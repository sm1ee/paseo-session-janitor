import { describe, expect, it } from "vitest";
import { preferences } from "./contracts";
import { DAY, HOUR, deletionTree, emptyState, plan, updateObservations, type Agent, type Inventory } from "./model";

const start = Date.parse("2026-10-20T00:00:00Z");
const iso = (n: number) => new Date(n).toISOString();
export function agent(id: string, extra: Partial<Agent> = {}): Agent {
  return { id, title: id, provider: "codex", workspaceId: "workspace", parentId: null, status: "idle", updatedAt: iso(start - DAY), lastUserMessageAt: iso(start - DAY), attentionReason: "finished", attentionTimestamp: iso(start - DAY), archivedAt: null, activeTurn: null, pendingPermissions: 0, openTab: false, internal: false, ...extra };
}
function setup(agents: Agent[] = [agent("parent"), agent("child", { parentId: "parent" })]) {
  const inventory: Inventory = { agents, workspaces: [{ id: "workspace", pinned: false, archiving: false }] };
  const state = emptyState("test");
  updateObservations(inventory, state, start);
  const stable = new Map(agents.map((a) => [a.id, start]));
  const settings = preferences.schema.parse({});
  return { inventory, state, stable, settings, rows: (now = start + 7 * HOUR) => plan(inventory, state, settings, now, stable) };
}
describe("archive policy", () => {
  it("keeps a recovery candidate and descendants of a protected parent", () => {
    const s = setup([agent("parent", { recoveryHold: true }), agent("child", { parentId: "parent" })]);
    expect(s.rows()[1]).toMatchObject({ action: "keep", protected: true });
    expect(s.rows()[1]?.reason).toMatch(/pending recovery/);
    expect(() => deletionTree("parent", s.inventory, s.state, start)).toThrow(/pending recovery/);
  });
  it("only schedules finished children, after a full observation period", () => {
    const s = setup();
    expect(s.rows().find((r) => r.id === "parent")?.action).toBe("keep");
    expect(s.rows(start).find((r) => r.id === "child")).toMatchObject({ action: "archive", dueAt: iso(start + 6 * HOUR) });
  });
  it.each(["error", "closed"])("supports a %s child", (status) => {
    const s = setup([agent("parent"), agent("child", { parentId: "parent", status, attentionReason: null, attentionTimestamp: null })]);
    expect(s.rows()[1]?.action).toBe("archive");
  });
  it("does not equate idle with task completion", () => {
    const s = setup([agent("parent"), agent("child", { parentId: "parent", attentionReason: null, attentionTimestamp: null })]);
    expect(s.rows()[1]?.action).toBe("keep");
  });
  it.each([
    { status: "running" }, { status: "initializing" }, { activeTurn: "turn" }, { pendingPermissions: 1 }, { pendingPermissions: -1 }, { openTab: true }, { activeTurn: undefined },
  ])("keeps a child with unsafe state: %j", (extra) => {
    const s = setup([agent("parent"), agent("child", { parentId: "parent", ...extra })]);
    expect(s.rows()[1]?.action).toBe("keep");
  });
  it.each([{ activeTurn: "turn" }, { pendingPermissions: 1 }, { status: "running" }, { activeTurn: undefined }])("keeps results while a parent is active or unknown: %j", (extra) => {
    const s = setup([agent("parent", extra), agent("child", { parentId: "parent" })]);
    expect(s.rows()[1]?.action).toBe("keep");
  });
  it("restarts the quiet period after parent activity", () => {
    const s = setup();
    s.inventory.agents[0]!.updatedAt = iso(start + 4 * HOUR);
    updateObservations(s.inventory, s.state, start + 4 * HOUR);
    expect(s.rows()[1]?.dueAt).toBe(iso(start + 10 * HOUR));
  });
  it("never archives a branch with a live child", () => {
    const s = setup([agent("parent"), agent("child", { parentId: "parent" }), agent("grandchild", { parentId: "child", status: "running", activeTurn: "t" })]);
    expect(s.rows()[1]?.reason).toMatch(/child sessions/);
  });
  it.each(["missing", "cycle", "other-workspace"])("rejects an unverified %s parent", (kind) => {
    const parent = agent("parent", kind === "cycle" ? { parentId: "child" } : kind === "other-workspace" ? { workspaceId: "elsewhere" } : {});
    const s = setup([...(kind === "missing" ? [] : [parent]), agent("child", { parentId: "parent" })]);
    expect(s.rows().at(-1)?.reason).toMatch(/relationship/);
  });
  it("inherits protection and postponement through ancestors", () => {
    const s = setup();
    s.state.protectedIds.push("parent");
    expect(s.rows()[1]).toMatchObject({ protected: true, action: "keep", ownProtection: false });
    s.state.protectedIds = [];
    s.state.snoozed.parent = start + DAY;
    expect(s.rows()[1]?.action).toBe("keep");
  });
  it("remembers pinned workspaces after they disappear from the active directory", () => {
    const s = setup();
    s.inventory.workspaces[0]!.pinned = true;
    updateObservations(s.inventory, s.state, start);
    s.inventory.workspaces = [];
    updateObservations(s.inventory, s.state, start + HOUR);
    expect(s.rows()[1]?.reason).toBe("Pinned workspace");
  });
  it("defers all mutations during workspace archival", () => {
    const s = setup(); s.inventory.workspaces[0]!.archiving = true;
    expect(s.rows().every((r) => r.action === "keep")).toBe(true);
  });
});
describe("retention", () => {
  it("gives pre-existing archives a full retention period", () => {
    const s = setup([agent("main", { archivedAt: iso(start - 90 * DAY), activeTurn: undefined })]);
    expect(s.rows()[0]).toMatchObject({ action: "delete", dueAt: iso(start + 3 * DAY) });
  });
  it("waits for every parent to be archived before permanent child deletion", () => {
    const s = setup([agent("parent"), agent("child", { parentId: "parent", archivedAt: iso(start - DAY) })]);
    expect(s.rows(start + 5 * DAY)[1]?.reason).toMatch(/every parent/);
    s.inventory.agents[0]!.archivedAt = iso(start);
    expect(s.rows(start + 5 * DAY)[1]?.action).toBe("delete");
  });
  it("requires a quiet parent when archived-parent protection is disabled", () => {
    const s = setup([agent("parent"), agent("child", { parentId: "parent", archivedAt: iso(start - DAY) })]);
    s.settings.waitForParentArchive = false;
    s.inventory.agents[0]!.updatedAt = iso(start + 3 * DAY);
    updateObservations(s.inventory, s.state, start + 3 * DAY);
    expect(s.rows(start + 3 * DAY)[1]?.dueAt).toBe(iso(start + 3 * DAY + 6 * HOUR));
  });
  it("deletes leaves before their archived parents", () => {
    const s = setup([agent("parent", { archivedAt: iso(start - DAY) }), agent("child", { parentId: "parent", archivedAt: iso(start - DAY) })]);
    expect(s.rows()[0]?.action).toBe("keep");
    expect(s.rows()[1]?.action).toBe("delete");
  });
  it("resets retention when a session is restored and archived again", () => {
    const s = setup([agent("main", { archivedAt: iso(start - DAY) })]);
    s.inventory.agents[0]!.archivedAt = null;
    updateObservations(s.inventory, s.state, start + DAY);
    s.inventory.agents[0]!.archivedAt = iso(start + 2 * DAY);
    updateObservations(s.inventory, s.state, start + 2 * DAY);
    expect(s.rows(start + 2 * DAY)[0]?.dueAt).toBe(iso(start + 5 * DAY));
  });
  it("requires another live observation after restart", () => {
    const s = setup([agent("main", { archivedAt: iso(start - DAY) })]);
    s.stable.clear();
    expect(Date.parse(s.rows(start + 4 * DAY)[0]!.dueAt!)).toBe(start + 4 * DAY + 60_000);
  });
  it("rejects duplicate directory IDs", () => {
    const s = setup([agent("same"), agent("same")]);
    expect(() => s.rows()).toThrow(/duplicate/);
  });
});
describe("manual deletion", () => {
  it("lists children first and allows the selected root's own tab", () => {
    const s = setup([agent("parent", { openTab: true }), agent("child", { parentId: "parent" })]);
    expect(deletionTree("parent", s.inventory, s.state, start).map((a) => a.id)).toEqual(["child", "parent"]);
  });
  it.each([{ status: "running" }, { pendingPermissions: 1 }, { activeTurn: undefined }, { openTab: true }])("blocks an unsafe child: %j", (extra) => {
    const s = setup([agent("parent"), agent("child", { parentId: "parent", ...extra })]);
    expect(() => deletionTree("parent", s.inventory, s.state, start)).toThrow();
  });
  it("blocks a protected descendant", () => {
    const s = setup(); s.state.protectedIds.push("child");
    expect(() => deletionTree("parent", s.inventory, s.state, start)).toThrow(/protection/);
  });
});
