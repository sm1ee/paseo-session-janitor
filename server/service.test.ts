import { describe, expect, it, vi } from "vitest";
import { preferences, statusInput } from "../shared/contracts";
import { DAY, HOUR, emptyState, type Agent, type Inventory, type SavedState } from "../shared/model";
import type { JanitorHost } from "./host";
import { JanitorService } from "./service";

const start = Date.parse("2026-10-20T00:00:00Z");
function agent(id: string, extra: Partial<Agent> = {}): Agent {
  return { id, title: id, provider: "codex", workspaceId: "w", parentId: null, status: "idle", updatedAt: new Date(start - DAY).toISOString(), lastUserMessageAt: null, attentionReason: "finished", attentionTimestamp: new Date(start - DAY).toISOString(), archivedAt: null, activeTurn: null, pendingPermissions: 0, openTab: false, internal: false, ...extra };
}
function fixture(agents = [agent("parent"), agent("child", { parentId: "parent" })], saved?: SavedState) {
  let now = start;
  let persisted = structuredClone(saved ?? emptyState("test"));
  const inventory: Inventory = { agents: structuredClone(agents), workspaces: [{ id: "w", pinned: false, archiving: false }] };
  const host: JanitorHost = {
    store: { load: vi.fn(async () => structuredClone(persisted)), save: vi.fn(async (s) => { persisted = structuredClone(s); }) },
    otherCleaner: false,
    list: vi.fn(async () => structuredClone(inventory)),
    fetch: vi.fn(async (id) => structuredClone(inventory.agents.find((a) => a.id === id) ?? null)),
    children: vi.fn(async (id) => structuredClone(inventory.agents.filter((a) => a.parentId === id))),
    workspaces: vi.fn(async () => structuredClone(inventory.workspaces)),
    archive: vi.fn(async (id) => { const a = inventory.agents.find((a) => a.id === id)!; a.archivedAt = new Date(now).toISOString(); a.status = "closed"; a.updatedAt = a.archivedAt; }),
    delete: vi.fn(async (id) => { inventory.agents = inventory.agents.filter((a) => a.id !== id); }),
    close: vi.fn(async () => {}),
  };
  const connect = vi.fn(async () => host);
  const service = new JanitorService(connect, () => now, false);
  const settings = preferences.schema.parse({ enabled: true, archiveAfterHours: 0.25 });
  return { service, host, connect, settings, inventory, advance: (n: number) => { now += n; }, saved: () => structuredClone(persisted), status: () => service.status(statusInput.parse({ scope: "all" })) };
}
describe("automatic cleanup", () => {
  it("acknowledges refresh requests immediately and coalesces them while a scan is running", async () => {
    const f = fixture(); await f.service.configure({ ...f.settings, enabled: false });
    let release!: (value: Inventory) => void;
    let began!: () => void;
    const running = new Promise<void>((resolve) => { began = resolve; });
    vi.mocked(f.host.list).mockImplementationOnce(async () => { began(); return new Promise((resolve) => { release = resolve; }); });
    expect(f.service.requestScan()).toEqual({ ok: true });
    await running;
    expect(f.status().scanning).toBe(true);
    expect(f.service.requestScan()).toEqual({ ok: true });
    release(structuredClone(f.inventory));
    await f.service.stop();
    expect(f.host.list).toHaveBeenCalledTimes(2);
  });
  it("starts in preview and never mutates old sessions", async () => {
    const f = fixture([agent("main", { archivedAt: new Date(start - 100 * DAY).toISOString() })]);
    await f.service.configure(preferences.schema.parse({}));
    f.advance(100 * DAY); await f.service.scanNow();
    expect(f.status().state).toBe("preview");
    expect(f.host.delete).not.toHaveBeenCalled();
    expect(f.host.archive).not.toHaveBeenCalled();
    await f.service.stop();
  });
  it("archives a settled finished child, then verifies the result", async () => {
    const f = fixture(); await f.service.configure(f.settings);
    expect(f.host.archive).not.toHaveBeenCalled();
    f.advance(HOUR); await f.service.scanNow();
    expect(f.host.archive).toHaveBeenCalledExactlyOnceWith("child");
    expect(f.saved().history.at(-1)?.result).toBe("done");
    expect(f.saved().receipts).toEqual({});
    await f.service.stop();
  });
  it("restarts retention when automation is first enabled", async () => {
    const f = fixture([agent("main", { archivedAt: new Date(start - DAY).toISOString() })]);
    await f.service.configure({ ...f.settings, enabled: false });
    f.advance(30 * DAY); await f.service.configure(f.settings);
    await f.service.scanNow();
    expect(f.host.delete).not.toHaveBeenCalled();
    f.advance(3 * DAY + HOUR); await f.service.scanNow();
    expect(f.host.delete).toHaveBeenCalledExactlyOnceWith("main");
    await f.service.stop();
  });
  it("retains archived children of unarchived parents", async () => {
    const f = fixture([agent("parent"), agent("child", { parentId: "parent", archivedAt: new Date(start - DAY).toISOString() })]);
    await f.service.configure(f.settings); f.advance(4 * DAY); await f.service.scanNow();
    expect(f.host.delete).not.toHaveBeenCalled();
    await f.service.stop();
  });
  it("stops if live parent state changes just before mutation", async () => {
    const f = fixture(); await f.service.configure(f.settings); f.advance(HOUR);
    vi.mocked(f.host.fetch).mockImplementation(async (id) => ({ ...structuredClone(f.inventory.agents.find((a) => a.id === id)!), ...(id === "parent" ? { activeTurn: "new-turn" } : {}) }));
    await expect(f.service.scanNow()).rejects.toThrow(/changed/);
    expect(f.host.archive).not.toHaveBeenCalled();
    await f.service.stop();
  });
  it("stops if a new child appears after the full snapshot", async () => {
    const f = fixture(); await f.service.configure(f.settings); f.advance(HOUR);
    vi.mocked(f.host.children).mockResolvedValue([agent("new", { parentId: "child" })]);
    await expect(f.service.scanNow()).rejects.toThrow(/child sessions/);
    expect(f.host.archive).not.toHaveBeenCalled();
    await f.service.stop();
  });
  it("honors pause requests while a guard read is in flight", async () => {
    const f = fixture(); await f.service.configure(f.settings); f.advance(HOUR);
    let finish!: (a: Agent) => void;
    let started!: () => void;
    const reading = new Promise<void>((r) => { started = r; });
    vi.mocked(f.host.fetch).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; started(); }));
    const scan = f.service.scanNow();
    await reading;
    const pause = f.service.configure({ ...f.settings, enabled: false });
    finish(f.inventory.agents[0]!);
    await scan; await pause;
    expect(f.host.archive).not.toHaveBeenCalled();
    expect(f.status().state).toBe("preview");
    await f.service.stop();
  });
  it("does not retry a delete with an unverified result, even after history rollover", async () => {
    const f = fixture([agent("main", { archivedAt: new Date(start - DAY).toISOString() })]);
    vi.mocked(f.host.delete).mockResolvedValue();
    await f.service.configure(f.settings); f.advance(4 * DAY);
    await expect(f.service.scanNow()).rejects.toThrow(/not be retried/);
    expect(f.saved().receipts.main?.action).toBe("delete");
    await f.service.scanNow(); f.advance(DAY); await f.service.scanNow();
    expect(f.host.delete).toHaveBeenCalledTimes(1);
    expect(f.status().rows[0]?.reason).toMatch(/not be verified/);
    await f.service.stop();
  });
  it("reconciles a completed mutation whose response was lost", async () => {
    const f = fixture([agent("main", { archivedAt: new Date(start - DAY).toISOString() })]);
    vi.mocked(f.host.delete).mockImplementation(async () => { f.inventory.agents = []; throw new Error("Connection lost"); });
    await f.service.configure(f.settings); f.advance(4 * DAY);
    await expect(f.service.scanNow()).rejects.toThrow(/Connection lost/);
    expect(f.saved().receipts.main).toBeDefined();
    await f.service.scanNow();
    expect(f.saved().receipts).toEqual({});
    expect(f.saved().history.at(-1)?.result).toBe("done");
    expect(f.host.delete).toHaveBeenCalledTimes(1);
    await f.service.stop();
  });
  it("does not mutate when durable receipt storage fails", async () => {
    const f = fixture(); await f.service.configure(f.settings); f.advance(HOUR);
    vi.mocked(f.host.store.save).mockRejectedValue(new Error("Disk unavailable"));
    await expect(f.service.scanNow()).rejects.toThrow(/Disk unavailable/);
    expect(f.host.archive).not.toHaveBeenCalled();
    await f.service.stop();
  });
  it("refuses to start with unreadable state", async () => {
    const f = fixture(); vi.mocked(f.host.store.load).mockRejectedValue(new Error("Invalid state"));
    await f.service.configure(f.settings); f.advance(4 * DAY);
    expect(f.status().state).toBe("error");
    expect(f.host.archive).not.toHaveBeenCalled();
    await f.service.stop();
  });
});
describe("manual delete and protection", () => {
  it("prepares and confirms deletion without reloading the whole host directory", async () => {
    const f = fixture(); await f.service.configure({ ...f.settings, enabled: false });
    vi.mocked(f.host.list).mockRejectedValue(new Error("A full scan is too slow"));
    const preview = await f.service.prepareDelete("parent");
    await expect(f.service.confirmDelete(preview.token, "DELETE")).resolves.toEqual({ deleted: 2 });
    expect(f.host.list).toHaveBeenCalledTimes(1);
    await f.service.stop();
  });
  it("accepts confirmed deletion as a background job and reports its progress", async () => {
    const f = fixture(); await f.service.configure({ ...f.settings, enabled: false });
    const preview = await f.service.prepareDelete("parent");
    let complete!: () => void;
    let began!: () => void;
    const running = new Promise<void>((resolve) => { began = resolve; });
    vi.mocked(f.host.delete).mockImplementationOnce(async (id) => {
      began(); await new Promise<void>((resolve) => { complete = resolve; });
      f.inventory.agents = f.inventory.agents.filter((a) => a.id !== id);
    });
    expect(f.service.requestDelete(preview.token, "DELETE")).toEqual({ accepted: true });
    await running;
    expect(f.status().deletion).toMatchObject({ state: "running", total: 2, deleted: 0 });
    complete();
    await f.service.scanNow();
    expect(f.status().deletion).toMatchObject({ state: "done", total: 2, deleted: 2 });
    await f.service.stop();
  });
  it("requires a one-use, unexpired confirmation and deletes leaves first", async () => {
    const f = fixture(); await f.service.configure({ ...f.settings, enabled: false });
    const preview = await f.service.prepareDelete("parent");
    expect(preview.count).toBe(2);
    expect(f.host.delete).not.toHaveBeenCalled();
    await expect(f.service.confirmDelete(preview.token, "DELETE")).resolves.toEqual({ deleted: 2 });
    expect(vi.mocked(f.host.delete).mock.calls.map(([id]) => id)).toEqual(["child", "parent"]);
    await expect(f.service.confirmDelete(preview.token, "DELETE")).rejects.toThrow(/expired/);
    await f.service.stop();
  });
  it.each(["changed", "expired", "new-child", "bad-confirmation"])("rejects a %s preview", async (kind) => {
    const f = fixture(); await f.service.configure({ ...f.settings, enabled: false });
    const preview = await f.service.prepareDelete("parent");
    if (kind === "changed") f.inventory.agents[0]!.updatedAt = new Date(start).toISOString();
    if (kind === "expired") f.advance(HOUR);
    if (kind === "new-child") f.inventory.agents.push(agent("new", { parentId: "parent" }));
    await expect(f.service.confirmDelete(preview.token, kind === "bad-confirmation" ? "yes" : "DELETE")).rejects.toThrow();
    expect(f.host.delete).not.toHaveBeenCalled();
    await f.service.stop();
  });
  it("invalidates a deletion preview when protection changes", async () => {
    const f = fixture(); await f.service.configure({ ...f.settings, enabled: false });
    const preview = await f.service.prepareDelete("parent");
    await f.service.protect("child", true);
    await expect(f.service.confirmDelete(preview.token, "DELETE")).rejects.toThrow(/expired/);
    expect(f.host.delete).not.toHaveBeenCalled();
    expect(f.saved().protectedIds).toEqual(["child"]);
    await f.service.stop();
  });
  it("inherits a 24-hour postponement", async () => {
    const f = fixture(); await f.service.configure(f.settings);
    await f.service.snooze("parent", true); f.advance(HOUR); await f.service.scanNow();
    expect(f.host.archive).not.toHaveBeenCalled();
    await f.service.snooze("parent", false); await f.service.scanNow();
    expect(f.host.archive).toHaveBeenCalledExactlyOnceWith("child");
    await f.service.stop();
  });
});
