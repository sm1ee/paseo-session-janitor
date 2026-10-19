import { createPaseoApi, type PaseoAgent, type PaseoApi } from "@getpaseo/client";
import { DaemonClient, type WebSocketLike } from "@getpaseo/client/internal/daemon-client";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";
import { z } from "zod";
import type { Agent, Inventory, Workspace } from "../shared/model";
import { FileStore, type StateStore } from "./store";
import { readRecoveryHolds } from "./recovery";

export interface JanitorHost {
  store: StateStore;
  otherCleaner: boolean;
  list(check?: () => void): Promise<Inventory>;
  fetch(id: string): Promise<Agent | null>;
  children(id: string): Promise<Agent[]>;
  workspaces(ids: string[]): Promise<Workspace[]>;
  archive(id: string): Promise<void>;
  delete(id: string): Promise<void>;
  close(): Promise<void>;
}

export function metadata(a: PaseoAgent): Agent {
  return {
    id: a.id, title: a.title || `Untitled session (${a.id.slice(0, 8)})`, provider: a.provider,
    workspaceId: a.workspaceId ?? null, parentId: a.labels["paseo.parent-agent-id"]?.trim() || null,
    status: a.status, updatedAt: a.updatedAt, lastUserMessageAt: a.lastUserMessageAt,
    attentionReason: a.attentionReason ?? null, attentionTimestamp: a.attentionTimestamp ?? null,
    archivedAt: a.archivedAt ?? null,
    activeTurn: a.activeTurn === undefined ? undefined : a.activeTurn?.turnId ?? null,
    pendingPermissions: Array.isArray(a.pendingPermissions) ? a.pendingPermissions.length : -1,
    openTab: Object.entries(a.labels).some(([key, value]) => key.startsWith("paseo.open-agent-tab.") && String(value).toLowerCase() === "true"),
    internal: "internal" in a && a.internal === true,
  };
}
export async function collectPages<T>(first: { entries: T[]; pageInfo: { hasMore: boolean; nextCursor: string | null } }, next: (cursor: string) => Promise<typeof first>): Promise<T[]> {
  const entries = [...first.entries];
  const seen = new Set<string>();
  let page = first;
  while (page.pageInfo.hasMore) {
    const cursor = page.pageInfo.nextCursor;
    if (!cursor || seen.has(cursor) || entries.length > 20_000) throw new Error("The session directory is incomplete. Cleanup is paused.");
    seen.add(cursor);
    page = await next(cursor);
    entries.push(...page.entries);
  }
  return entries;
}

const lockSchema = z.object({ pid: z.number().int().positive(), serverId: z.string().min(1), listen: z.string().min(1) });
const run = promisify(execFile);
async function parentOf(pid: number): Promise<number> {
  const { stdout } = process.platform === "win32"
    ? await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').ParentProcessId`], { timeout: 3000, maxBuffer: 1024 })
    : await run("ps", ["-p", String(pid), "-o", "ppid="], { timeout: 3000, maxBuffer: 1024 });
  return /^\d+$/.test(stdout.trim()) ? Number(stdout.trim()) : -1;
}
export async function belongsToDaemon(parentPid: number, ownerPid: number, lookup = parentOf): Promise<boolean> {
  if (parentPid === ownerPid) return true;
  try { return await lookup(parentPid) === ownerPid; } catch { return false; }
}
export function resolveHome(configured: string): string {
  const raw = configured.trim() || process.env.PASEO_HOME || join(homedir(), ".paseo");
  return resolve(raw === "~" ? homedir() : raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw);
}
export function localEndpoint(listen: string): { url: string; socketPath?: string } {
  if (listen.startsWith("unix://") || listen.startsWith("pipe://") || listen.startsWith("/") || listen.startsWith("\\\\.\\pipe\\")) {
    const socketPath = listen.replace(/^(unix|pipe):\/\//, "");
    if (!socketPath) throw new Error("The host has no local socket.");
    return { url: "ws://localhost/ws", socketPath };
  }
  const target = new URL(`ws://${listen}/ws`);
  if (target.hostname === "0.0.0.0") target.hostname = "127.0.0.1";
  if (target.hostname === "[::]") target.hostname = "[::1]";
  if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) || target.username || target.password || target.pathname !== "/ws" || target.search || target.hash) throw new Error("session-janitor needs a loopback listener or a local socket.");
  return { url: target.href };
}
async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}
async function acquireLease(directory: string): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "worker.lock");
  const owner = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  try { await writeFile(path, owner, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let previous: { pid: number };
    try { previous = z.object({ pid: z.number().int().positive(), nonce: z.string() }).parse(JSON.parse(await readFile(path, "utf8"))); }
    catch { throw new Error("Cannot verify the cleanup worker lock. Cleanup is paused."); }
    try { process.kill(previous.pid, 0); throw new Error("Another session-janitor worker is already running."); }
    catch (probe) { if ((probe as NodeJS.ErrnoException).code !== "ESRCH") throw probe; }
    await unlink(path);
    await writeFile(path, owner, { flag: "wx", mode: 0o600 });
  }
  return async () => {
    try { if (await readFile(path, "utf8") === owner) await unlink(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  };
}

// 0.11.4 has no public permanent-delete operation or startup SDK context.
// Keep this version-pinned adapter on the daemon and authenticate only to its owner.
export async function openLocalHost(configuredHome: string, parentPid = process.ppid): Promise<JanitorHost> {
  const home = resolveHome(configuredHome);
  let lock: z.output<typeof lockSchema>;
  try { lock = lockSchema.parse(JSON.parse(await readFile(join(home, "paseo.pid"), "utf8"))); }
  catch { throw new Error("Cannot find this daemon. Check Paseo home in session-janitor settings."); }
  if (!await belongsToDaemon(parentPid, lock.pid)) throw new Error("This Paseo home belongs to another daemon. Cleanup is paused.");
  const endpoint = localEndpoint(lock.listen);
  // Keep the original data location so the rename preserves protections and receipts.
  const directory = join(home, "plugin-data", "paseo-session-janitor");
  const release = await acquireLease(directory);
  const readIdentity = async () => {
    const current = lockSchema.parse(JSON.parse(await readFile(join(home, "paseo.pid"), "utf8")));
    if (current.pid !== lock.pid || current.serverId !== lock.serverId || current.listen !== lock.listen) throw new Error("The daemon changed. Reconnect before cleaning up.");
  };
  const driver = new DaemonClient({
    url: endpoint.url, clientId: `session-janitor-${randomUUID()}`, clientType: "cli", appVersion: "0.11.4",
    connectTimeoutMs: 10_000, reconnect: { enabled: false },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    localCredential: async () => {
      await readIdentity();
      const credential = (await readFile(join(home, "local-credential"), "utf8")).trim();
      if (!/^[A-Za-z0-9_-]{43}$/.test(credential)) throw new Error("The local daemon credential is unavailable.");
      return credential;
    },
    webSocketFactory: (url, options) => new WebSocket(url, options?.protocols, { headers: options?.headers, ...(endpoint.socketPath ? { socketPath: endpoint.socketPath } : {}) }) as unknown as WebSocketLike,
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await driver.close().finally(release);
  };
  const assertIdentity = async () => {
    await readIdentity();
    if (closed || driver.getConnectionState().status !== "connected" || driver.getLastServerInfoMessage()?.serverId !== lock.serverId) throw new Error("The local daemon is disconnected. Cleanup is paused.");
  };
  try {
    await driver.connect();
    await assertIdentity();
    const version = driver.getLastServerInfoMessage()?.version;
    // Internal delete semantics were reviewed against this daemon series.
    if (typeof version === "string" && !/^0\.11\./.test(version)) throw new Error("This daemon version has not been verified for session deletion.");
    const paseo: PaseoApi = createPaseoApi(driver);
    const protectRecovery = async (agents: Agent[]): Promise<Agent[]> => {
      const holds = await readRecoveryHolds(home, lock.serverId);
      return agents.map((agent) => ({ ...agent, recoveryHold: holds.has(agent.id) }));
    };
    const checkRecovery = async (id: string): Promise<void> => {
      const holds = await readRecoveryHolds(home, lock.serverId);
      if (!holds.size) return;
      const seen = new Set<string>();
      let current: string | null = id;
      while (current) {
        if (seen.has(current) || seen.size > 50) throw new Error("Recovery ancestry could not be verified. Cleanup is paused.");
        seen.add(current);
        if (holds.has(current)) throw new Error("Session or parent has pending recovery. Dismiss it in session-recovery before cleanup.");
        const result = await paseo.agents.ref(current).refresh();
        if (!result?.agent) throw new Error("Recovery ancestry changed. Cleanup is paused.");
        current = metadata(result.agent).parentId;
      }
    };
    const launchAgents = process.platform === "darwin" ? await readdir(join(homedir(), "Library", "LaunchAgents")).catch(() => [] as string[]) : [];
    const otherCleaner = launchAgents.some((name) => /(?:^|[._-])paseo[-._](?:subagent[-._])?(?:janitor|cleaner)\.plist$/i.test(name)) && !await exists(join(home, "disable-subagent-janitor"));
    return {
      store: new FileStore(join(directory, "state.json"), lock.serverId), otherCleaner,
      async list(check) {
        check?.();
        await assertIdentity();
        const agentsOptions = { filter: { includeArchived: true }, sort: [{ key: "created_at" as const, direction: "asc" as const }], page: { limit: 200 } };
        // History includes stored agents whose provider is currently unavailable.
        const firstAgents = await driver.fetchAgentHistory(agentsOptions);
        check?.();
        const agents = await collectPages(firstAgents, async (cursor) => {
          check?.();
          const page = await driver.fetchAgentHistory({ ...agentsOptions, page: { limit: 200, cursor } });
          check?.();
          return page;
        });
        const workspaceOptions = { sort: [{ key: "name" as const, direction: "asc" as const }], page: { limit: 200 } };
        const firstWorkspaces = await paseo.workspaces.list(workspaceOptions);
        check?.();
        const workspaces = await collectPages(firstWorkspaces, async (cursor) => {
          check?.();
          const page = await paseo.workspaces.list({ ...workspaceOptions, page: { limit: 200, cursor } });
          check?.();
          return page;
        });
        await assertIdentity();
        return { agents: await protectRecovery(agents.map(({ agent }) => metadata(agent))), workspaces: workspaces.map((w) => ({ id: w.id, pinned: Boolean(w.pinnedAt), archiving: Boolean(w.archivingAt) })) };
      },
      async fetch(id) {
        await assertIdentity();
        const response = await paseo.agents.ref(id).refresh();
        await assertIdentity();
        return response?.agent ? (await protectRecovery([metadata(response.agent)]))[0]! : null;
      },
      async children(id) {
        await assertIdentity();
        const options = { filter: { includeArchived: true, labels: { "paseo.parent-agent-id": id } }, page: { limit: 200 } };
        const first = await driver.fetchAgentHistory(options);
        const entries = await collectPages(first, (cursor) => driver.fetchAgentHistory({ ...options, page: { limit: 200, cursor } }));
        await assertIdentity();
        return protectRecovery(entries.map(({ agent }) => metadata(agent)));
      },
      async workspaces(ids) {
        await assertIdentity();
        const result: Workspace[] = [];
        for (const id of new Set(ids)) {
          const page = await paseo.workspaces.list({ filter: { idPrefix: id }, page: { limit: 200 } });
          const workspace = page.entries.find((w) => w.id === id);
          if (workspace) result.push({ id, pinned: Boolean(workspace.pinnedAt), archiving: Boolean(workspace.archivingAt) });
        }
        await assertIdentity();
        return result;
      },
      async archive(id) { await assertIdentity(); await checkRecovery(id); await assertIdentity(); await paseo.agents.ref(id).archive(); },
      async delete(id) { await assertIdentity(); await checkRecovery(id); await assertIdentity(); await driver.deleteAgent(id); },
      close,
    };
  } catch (error) {
    await close();
    if (error instanceof Error && /^(Cannot |This |The |Session |Another )/.test(error.message)) throw error;
    throw new Error("Cannot connect to this daemon. Check its Paseo home and local connection.");
  }
}
