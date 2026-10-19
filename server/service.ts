import { randomUUID } from "node:crypto";
import { z } from "zod";
import { preferences, statusInput, type DeletePreview, type JanitorStatus, type Preferences, type SessionRow } from "../shared/contracts";
import { activityKnown, ancestors, DAY, deletionTree, emptyState, fingerprint, indexAgents, isBusy, plan, updateObservations, updatePins, type Agent, type Inventory, type SavedState } from "../shared/model";
import { openLocalHost, type JanitorHost } from "./host";

const INTERVAL = 5 * 60_000;
interface Ticket { rootId: string; fingerprints: Map<string, string>; expiresAt: number; generation: number }
export class JanitorService {
  private host: JanitorHost | null = null;
  private saved: SavedState = emptyState("");
  private inventory: Inventory = { agents: [], workspaces: [] };
  private settings = preferences.schema.parse({});
  private stable = new Map<string, number>();
  private observed = new Map<string, string>();
  private tickets = new Map<string, Ticket>();
  private generation = 0;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private error: string | null = null;
  private lastScanAt: string | null = null;
  private initialized = false;
  private scanning = false;
  private scanQueued = false;
  private deletion: JanitorStatus["deletion"] = { state: "idle", total: 0, deleted: 0, error: null };

  constructor(private readonly connect = openLocalHost, private readonly now = Date.now, private readonly automaticTimer = true) {}
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const task = this.queue.then(work);
    this.queue = task.catch(() => {});
    return task;
  }
  configure(settings: Preferences): Promise<void> {
    const generation = ++this.generation;
    this.tickets.clear();
    clearTimeout(this.timer);
    return this.enqueue(async () => {
      if (this.stopped || generation !== this.generation) return;
      if (settings.daemonHome !== this.settings.daemonHome) await this.disconnect();
      this.settings = settings;
      await this.scan(generation);
      this.schedule();
    });
  }
  invalidSettings(): Promise<void> {
    ++this.generation;
    this.tickets.clear();
    clearTimeout(this.timer);
    return this.enqueue(async () => { this.error = "Settings could not be read. Cleanup is paused."; await this.disconnect(); });
  }
  private schedule(): void {
    clearTimeout(this.timer);
    if (this.stopped || !this.automaticTimer) return;
    this.timer = setTimeout(() => { void this.enqueue(async () => { await this.scan(this.generation); this.schedule(); }); }, INTERVAL);
  }
  private async disconnect(): Promise<void> {
    const host = this.host;
    this.host = null;
    this.initialized = false;
    this.stable.clear();
    this.observed.clear();
    if (host) await host.close();
  }
  private check(generation: number): void {
    if (this.stopped || generation !== this.generation) throw new Error("Cleanup was paused or settings changed. Refresh and try again.");
  }
  private async ready(): Promise<JanitorHost> {
    if (this.stopped) throw new Error("session-janitor has stopped.");
    if (this.host) return this.host;
    const host = await this.connect(this.settings.daemonHome);
    try {
      this.saved = await host.store.load();
      this.host = host;
      return host;
    } catch (error) { await host.close(); throw error; }
  }
  private async snapshot(generation = this.generation): Promise<Inventory> {
    const host = await this.ready();
    const inventory = await host.list(() => this.check(generation));
    this.check(generation);
    const now = this.now();
    indexAgents(inventory.agents);
    for (const agent of inventory.agents) {
      const key = fingerprint(agent);
      if (this.observed.get(agent.id) !== key || (this.stable.get(agent.id) ?? Infinity) > now) this.stable.set(agent.id, now);
      this.observed.set(agent.id, key);
    }
    const present = new Set(inventory.agents.map((a) => a.id));
    for (const id of this.observed.keys()) if (!present.has(id)) { this.observed.delete(id); this.stable.delete(id); }
    updateObservations(inventory, this.saved, now);
    this.inventory = inventory;
    return inventory;
  }
  private rows(): SessionRow[] {
    const unfinished = new Set(Object.keys(this.saved.receipts));
    return plan(this.inventory, this.saved, this.settings, this.now(), this.stable).map((row) => unfinished.has(row.id)
      ? { ...row, action: "keep", dueAt: null, reason: "Previous cleanup could not be verified; review before deleting manually" } : row);
  }
  private async scan(generation: number): Promise<void> {
    this.scanning = true;
    try {
      this.check(generation);
      const host = await this.ready();
      this.check(generation);
      if (this.settings.enabled !== this.saved.enabled) {
        this.saved.enabled = this.settings.enabled;
        if (this.settings.enabled) this.saved.activatedAt = this.now();
      }
      await this.snapshot(generation);
      this.check(generation);
      // Reconcile receipts after a crash or a lost RPC response without retrying a mutation.
      const index = indexAgents(this.inventory.agents);
      for (const [id, receipt] of Object.entries(this.saved.receipts)) {
        const a = index.get(id);
        if (receipt.action === "archive" ? Boolean(a?.archivedAt) : !a) {
          delete this.saved.receipts[id];
          for (const entry of this.saved.history) if (entry.id === id && entry.at === receipt.at) entry.result = "done";
        }
      }
      await host.store.save(this.saved);
      this.initialized = true;
      this.lastScanAt = new Date(this.now()).toISOString();
      this.error = null;
      if (!this.settings.enabled) return;
      const candidates = this.rows().filter((r) => r.action !== "keep" && r.dueAt && Date.parse(r.dueAt) <= this.now()).slice(0, 5);
      const deadline = this.now() + 30_000;
      for (const candidate of candidates) {
        this.check(generation);
        if (this.now() > deadline) break;
        await this.snapshot(generation);
        const fresh = this.rows().find((r) => r.id === candidate.id);
        if (!fresh || fresh.action !== candidate.action || !fresh.dueAt || Date.parse(fresh.dueAt) > this.now()) continue;
        await this.guarded(candidate.id, candidate.action as "archive" | "delete", generation);
      }
    } catch (error) {
      if (generation !== this.generation || this.stopped) return;
      this.error = error instanceof Error ? error.message : "The daemon could not be checked. Cleanup is paused.";
      await this.disconnect().catch(() => {});
    } finally {
      this.scanning = false;
    }
  }
  private async guarded(id: string, action: "archive" | "delete", generation: number, manual = false): Promise<void> {
    const host = await this.ready();
    const before = indexAgents(this.inventory.agents);
    const agent = before.get(id);
    if (!agent) throw new Error("The session is no longer available.");
    const family = ancestors(agent, before);
    if (!family.valid) throw new Error("The parent relationship changed. Cleanup was stopped.");
    for (const a of [...family.parents].reverse().concat(agent)) {
      const current = await host.fetch(a.id);
      this.check(generation);
      if (!current || fingerprint(current) !== fingerprint(a)) throw new Error("A session changed during cleanup. Refresh and try again.");
    }
    const children = await host.children(id);
    this.check(generation);
    if (children.some((a) => action === "delete" || !a.archivedAt)) throw new Error("This session has child sessions. Cleanup was stopped.");
    if (!manual) {
      const current = this.rows().find((r) => r.id === id);
      if (!current || current.action !== action || !current.dueAt || Date.parse(current.dueAt) > this.now()) throw new Error("This session is no longer due for cleanup.");
    }
    const entry = { id, action, at: new Date(this.now()).toISOString(), result: "started" as "started" | "done" | "unverified" };
    this.saved.history = [...this.saved.history, entry].slice(-100);
    this.saved.receipts[id] = { action, at: entry.at };
    await host.store.save(this.saved);
    this.check(generation);
    try {
      if (action === "archive") await host.archive(id); else await host.delete(id);
      const after = await host.fetch(id);
      if (action === "archive" ? !after?.archivedAt : after !== null) throw new Error("The cleanup result could not be verified. This session will not be retried automatically.");
      entry.result = "done";
      delete this.saved.receipts[id];
      await host.store.save(this.saved);
      if (after) this.inventory.agents = this.inventory.agents.map((a) => a.id === id ? after : a);
      else this.inventory.agents = this.inventory.agents.filter((a) => a.id !== id);
    } catch (error) {
      entry.result = "unverified";
      await host.store.save(this.saved);
      throw error;
    }
  }
  status(input: z.output<typeof statusInput>): JanitorStatus {
    const rows = this.initialized ? this.rows() : [];
    const query = input.query.toLowerCase().trim();
    const filtered = rows.filter((r) => (!query || `${r.title} ${r.id} ${r.provider}`.toLowerCase().includes(query)) &&
      (input.scope === "all" || input.scope === "queue" && r.action !== "keep" || input.scope === "main" && r.kind === "main" || input.scope === "archived" && r.archivedAt || input.scope === "protected" && r.protected));
    filtered.sort((a, b) => (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity) || a.title.localeCompare(b.title));
    const page = Math.min(input.page, Math.max(0, Math.ceil(filtered.length / 30) - 1));
    return {
      state: this.error ? "error" : !this.initialized ? "starting" : this.settings.enabled ? "running" : "preview",
      scanning: this.scanning || this.scanQueued, deletion: { ...this.deletion },
      error: this.error, lastScanAt: this.lastScanAt, otherCleaner: this.host?.otherCleaner ?? false,
      counts: { total: rows.length, archive: rows.filter((r) => r.action === "archive").length, delete: rows.filter((r) => r.action === "delete").length, protected: rows.filter((r) => r.protected).length },
      rows: filtered.slice(page * 30, page * 30 + 30), total: filtered.length, page,
      history: this.saved.history.slice(-20).reverse(),
    };
  }
  scanNow(): Promise<{ ok: true }> {
    return this.enqueue(async () => {
      await this.scan(this.generation);
      if (this.error) throw new Error(this.error);
      return { ok: true };
    });
  }
  requestScan(): { ok: true } {
    if (!this.scanning && !this.scanQueued && !this.stopped) {
      this.scanQueued = true;
      void this.enqueue(async () => {
        this.scanQueued = false;
        await this.scan(this.generation);
      });
    }
    return { ok: true };
  }
  protect(id: string, protect: boolean): Promise<{ ok: true }> {
    const generation = ++this.generation;
    this.tickets.clear();
    return this.enqueue(async () => {
      const host = await this.ready();
      const agent = await host.fetch(id);
      this.check(generation);
      if (!agent || agent.id !== id) throw new Error("This session is no longer available.");
      this.saved.protectedIds = this.saved.protectedIds.filter((value) => value !== id);
      if (protect) this.saved.protectedIds.push(id);
      await host.store.save(this.saved);
      return { ok: true };
    });
  }
  snooze(id: string, snooze: boolean): Promise<{ ok: true }> {
    const generation = ++this.generation;
    this.tickets.clear();
    return this.enqueue(async () => {
      const host = await this.ready();
      const agent = await host.fetch(id);
      this.check(generation);
      if (!agent || agent.id !== id) throw new Error("This session is no longer available.");
      if (snooze) this.saved.snoozed[id] = this.now() + DAY; else delete this.saved.snoozed[id];
      await host.store.save(this.saved);
      return { ok: true };
    });
  }
  prepareDelete(id: string): Promise<DeletePreview> {
    if (this.deletion.state === "running") return Promise.reject(new Error("A deletion is already running. Wait for it to finish."));
    const generation = ++this.generation;
    this.tickets.clear();
    return this.enqueue(async () => {
      const inventory = await this.treeSnapshot(id, generation);
      this.check(generation);
      const tree = deletionTree(id, inventory, this.saved, this.now());
      const token = randomUUID();
      const expiresAt = this.now() + 5 * 60_000;
      for (const [key, value] of this.tickets) if (value.expiresAt <= this.now()) this.tickets.delete(key);
      if (this.tickets.size > 10) this.tickets.clear();
      this.tickets.set(token, { rootId: id, fingerprints: new Map(tree.map((a) => [a.id, fingerprint(a)])), expiresAt, generation });
      return { token, title: tree.at(-1)!.title, count: tree.length, sessions: tree.map((a) => a.title), expiresAt: new Date(expiresAt).toISOString() };
    });
  }
  private async treeSnapshot(id: string, generation: number): Promise<Inventory> {
    const host = await this.ready();
    const root = await host.fetch(id);
    this.check(generation);
    if (!root || root.id !== id) throw new Error("This session is no longer available. Refresh the list.");
    if (isBusy(root) || !activityKnown(root)) throw new Error("This session is active, waiting for input, or has unknown state. Stop it before deleting.");
    const agents = new Map<string, Agent>([[id, root]]);
    let parentId = root.parentId;
    while (parentId) {
      if (agents.has(parentId)) throw new Error("The session tree contains a cycle. Deletion is blocked.");
      const parent = await host.fetch(parentId);
      this.check(generation);
      if (!parent || parent.id !== parentId) throw new Error("The parent relationship could not be verified. Deletion is blocked.");
      agents.set(parent.id, parent);
      parentId = parent.parentId;
    }
    const descendants = new Set([id]);
    const queue = [id];
    while (queue.length) {
      const currentId = queue.shift()!;
      const children = await host.children(currentId);
      this.check(generation);
      for (const child of children) {
        if (child.parentId !== currentId || agents.has(child.id)) throw new Error("The session tree changed or contains a cycle. Refresh and try again.");
        agents.set(child.id, child);
        descendants.add(child.id);
        if (descendants.size > 50) throw new Error("This tree has more than 50 sessions. Clean up smaller branches first.");
        queue.push(child.id);
      }
    }
    const workspaces = await host.workspaces([...new Set([...agents.values()].map((a) => a.workspaceId).filter((v): v is string => Boolean(v)))]);
    this.check(generation);
    updatePins(workspaces, this.saved);
    const known = indexAgents(this.inventory.agents);
    for (const agent of agents.values()) known.set(agent.id, agent);
    this.inventory.agents = [...known.values()];
    return { agents: [...agents.values()], workspaces };
  }
  private consumeTicket(token: string, confirmation: string): Ticket {
    const ticket = this.tickets.get(token);
    this.tickets.delete(token);
    if (!ticket || confirmation !== "DELETE" || this.now() >= ticket.expiresAt || ticket.generation !== this.generation) throw new Error("This deletion preview expired or changed. Review the session list again.");
    return ticket;
  }
  confirmDelete(token: string, confirmation: string): Promise<{ deleted: number }> {
    let ticket: Ticket;
    try { ticket = this.consumeTicket(token, confirmation); } catch (error) { return Promise.reject(error); }
    return this.enqueue(() => this.executeDelete(ticket));
  }
  requestDelete(token: string, confirmation: string): { accepted: true } {
    if (this.deletion.state === "running") throw new Error("A deletion is already running. Wait for it to finish.");
    const ticket = this.consumeTicket(token, confirmation);
    this.deletion = { state: "running", total: ticket.fingerprints.size, deleted: 0, error: null };
    void this.enqueue(() => this.executeDelete(ticket)).then(({ deleted }) => {
      this.deletion = { ...this.deletion, state: "done", deleted };
    }).catch((error) => {
      this.deletion = { ...this.deletion, state: "error", error: error instanceof Error ? error.message : "Deletion was stopped." };
    });
    return { accepted: true };
  }
  private async executeDelete(ticket: Ticket): Promise<{ deleted: number }> {
      const generation = ticket.generation;
      let deleted = 0;
      try {
        const inventory = await this.treeSnapshot(ticket.rootId, generation);
        this.check(generation);
        const tree = deletionTree(ticket.rootId, inventory, this.saved, this.now());
        if (tree.length !== ticket.fingerprints.size || tree.some((a) => ticket.fingerprints.get(a.id) !== fingerprint(a))) throw new Error("The session list changed. Review it again before deleting.");
        for (const agent of tree) {
          this.check(generation);
          const host = await this.ready();
          const workspaces = await host.workspaces(agent.workspaceId ? [agent.workspaceId] : []);
          this.check(generation);
          updatePins(workspaces, this.saved);
          const remaining = { agents: this.inventory.agents.filter((a) => inventory.agents.some((known) => known.id === a.id)), workspaces };
          // The current leaf must still be safe, with no unapproved children.
          deletionTree(agent.id, remaining, this.saved, this.now());
          await this.guarded(agent.id, "delete", generation, true);
          deleted++;
          if (this.deletion.state === "running") this.deletion.deleted = deleted;
        }
        return { deleted };
      } catch (error) {
        throw new Error(`${deleted ? `${deleted} session(s) deleted. ` : ""}${error instanceof Error ? error.message : "Deletion was stopped."}`);
      }
  }
  stop(): Promise<void> {
    this.stopped = true;
    ++this.generation;
    this.tickets.clear();
    clearTimeout(this.timer);
    return this.enqueue(() => this.disconnect());
  }
}
