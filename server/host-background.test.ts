import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { PaseoAgent } from "@getpaseo/client";
import { openLocalHost, type JanitorHost } from "./host";
import { isBusy } from "../shared/model";

type Info = NonNullable<ReturnType<DaemonClient["getLastServerInfoMessage"]>>;
let home: string;
let host: JanitorHost | undefined;
let version: unknown;
let background: boolean;

function agent(id: string, workspaceId: string, parentId?: string): PaseoAgent {
  return { id, title: id, provider: "test", workspaceId, labels: parentId ? { "paseo.parent-agent-id": parentId } : {}, status: "idle", updatedAt: "2026-01-01T00:00:00Z", lastUserMessageAt: null, archivedAt: parentId ? "2026-01-01T01:00:00Z" : null, activeTurn: id === "background-parent" ? { turnId: "active" } : null, pendingPermissions: [] } as unknown as PaseoAgent;
}
const agents = [agent("public", "public-space"), agent("background-parent", "background-space"), agent("background-child", "background-space", "background-parent")];
const spaces = [{ id: "public-space", pinnedAt: null, archivingAt: null }, { id: "background-space", pinnedAt: "2026-01-01T00:00:00Z", archivingAt: null }];

beforeEach(async () => {
  version = "0.12.0"; background = true;
  home = await mkdtemp(join(tmpdir(), "janitor-background-test-"));
  await writeFile(join(home, "paseo.pid"), JSON.stringify({ pid: process.pid, serverId: "scope-test", listen: "127.0.0.1:6767" }));
  vi.spyOn(DaemonClient.prototype, "connect").mockResolvedValue(undefined);
  vi.spyOn(DaemonClient.prototype, "close").mockResolvedValue(undefined);
  vi.spyOn(DaemonClient.prototype, "getConnectionState").mockReturnValue({ status: "connected" });
  vi.spyOn(DaemonClient.prototype, "getLastServerInfoMessage").mockImplementation(() => ({ serverId: "scope-test", version, features: { backgroundWorkspaces: background } }) as Info);
  vi.spyOn(DaemonClient.prototype, "supportsBackgroundWorkspaces").mockImplementation(() => background);
  vi.spyOn(DaemonClient.prototype, "fetchAgentHistory").mockImplementation(async (options) => {
    if (!background && options?.filter?.includeBackground) throw new Error("Background queries require a newer host");
    const selected = agents.filter((a) => (options?.filter?.includeBackground || a.workspaceId === "public-space") && (!options?.filter?.labels || Object.entries(options.filter.labels).every(([k, v]) => a.labels[k] === v)));
    const offset = options?.page?.cursor ? Number(options.page.cursor) : 0;
    return { requestId: "test", entries: selected.slice(offset, offset + 1).map((a) => ({ agent: a })), pageInfo: { hasMore: offset + 1 < selected.length, nextCursor: offset + 1 < selected.length ? String(offset + 1) : null } } as Awaited<ReturnType<DaemonClient["fetchAgentHistory"]>>;
  });
  vi.spyOn(DaemonClient.prototype, "fetchWorkspaces").mockImplementation(async (options) => {
    if (!background && options?.filter?.includeBackground) throw new Error("Background queries require a newer host");
    const selected = spaces.filter((w) => (options?.filter?.includeBackground || w.id === "public-space") && (!options?.filter?.idPrefix || w.id.startsWith(options.filter.idPrefix)));
    const offset = options?.page?.cursor ? Number(options.page.cursor) : 0;
    return { requestId: "test", entries: selected.slice(offset, offset + 1), pageInfo: { hasMore: offset + 1 < selected.length, nextCursor: offset + 1 < selected.length ? String(offset + 1) : null } } as Awaited<ReturnType<DaemonClient["fetchWorkspaces"]>>;
  });
});
afterEach(async () => { await host?.close(); host = undefined; vi.restoreAllMocks(); await rm(home, { recursive: true, force: true }); });

describe("background workspace inventory", () => {
  it("keeps background parents, archived children, and workspace pins across pages", async () => {
    host = await openLocalHost(home, process.pid);
    const inventory = await host.list();
    expect(inventory.agents.map((a) => a.id)).toEqual(["public", "background-parent", "background-child"]);
    expect(isBusy(inventory.agents.find((a) => a.id === "background-parent")!)).toBe(true);
    expect(inventory.workspaces).toContainEqual({ id: "background-space", pinned: true, archiving: false });
    expect((await host.children("background-parent")).map((a) => a.id)).toEqual(["background-child"]);
    expect(await host.workspaces(["background-space"])).toEqual([{ id: "background-space", pinned: true, archiving: false }]);
  });
  it("does not send unsupported background flags to 0.11 hosts", async () => {
    version = "0.11.4"; background = false;
    host = await openLocalHost(home, process.pid);
    expect((await host.list()).agents.map((a) => a.id)).toEqual(["public"]);
    expect(await host.workspaces(["public-space"])).toEqual([{ id: "public-space", pinned: false, archiving: false }]);
  });
  it.each([undefined, "0.13.0"])("rejects an unverified host before collecting any inventory: %s", async (value) => {
    version = value;
    await expect(openLocalHost(home, process.pid)).rejects.toThrow(/not supported/);
    expect(DaemonClient.prototype.fetchAgentHistory).not.toHaveBeenCalled();
    await expect(access(join(home, "plugin-data", "paseo-session-janitor", "worker.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
