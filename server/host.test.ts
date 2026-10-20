import { describe, expect, it } from "vitest";
import type { PaseoAgent } from "@getpaseo/client";
import { activityKnown, isBusy } from "../shared/model";
import { belongsToDaemon, collectPages, localEndpoint, metadata } from "./host";

describe("local host boundary", () => {
  it.each(["127.0.0.1:6767", "localhost:6767", "0.0.0.0:6767", "[::]:6767", "[::1]:6767"])("accepts a local listener %s", (listen) => {
    expect(localEndpoint(listen).url).toMatch(/^ws:\/\/(127\.0\.0\.1|localhost|\[::1\]):6767\/ws$/);
  });
  it.each(["example.com:6767", "user:password@127.0.0.1:6767", "127.0.0.1:6767/elsewhere", "127.0.0.1:6767?token=secret"])("rejects %s", (listen) => {
    expect(() => localEndpoint(listen)).toThrow();
  });
  it("supports local sockets", () => {
    expect(localEndpoint("unix:///tmp/paseo-test.sock")).toEqual({ url: "ws://localhost/ws", socketPath: "/tmp/paseo-test.sock" });
  });
  it("only accepts its parent daemon or the daemon's supervisor", async () => {
    expect(await belongsToDaemon(200, 200)).toBe(true);
    expect(await belongsToDaemon(201, 200, async () => 200)).toBe(true);
    expect(await belongsToDaemon(201, 202, async () => 200)).toBe(false);
    expect(await belongsToDaemon(201, 202, async () => { throw new Error("unknown"); })).toBe(false);
  });
  it("fails closed on a repeated or missing pagination cursor", async () => {
    const first = { entries: [1], pageInfo: { hasMore: true, nextCursor: "same" } };
    await expect(collectPages(first, async () => first)).rejects.toThrow(/incomplete/);
    await expect(collectPages({ ...first, pageInfo: { hasMore: true, nextCursor: null } }, async () => first)).rejects.toThrow(/incomplete/);
  });
  it("does not silently use a partial directory", async () => {
    await expect(collectPages({ entries: [1], pageInfo: { hasMore: true, nextCursor: "next" } }, async () => { throw new Error("offline"); })).rejects.toThrow(/offline/);
  });
});

describe("dormant snapshot activity", () => {
  const snapshot = (extra: Record<string, unknown> = {}) => ({ id: "fixture", title: "Fixture", provider: "codex", labels: {}, workspaceId: "workspace",
    status: "idle", updatedAt: "2026-10-20T00:00:00Z", lastUserMessageAt: null, pendingPermissions: [], ...extra }) as unknown as PaseoAgent;
  it.each(["idle", "error", "closed"])("recognizes a stored %s snapshot without restoring its provider", (status) => {
    const a = metadata(snapshot({ status }));
    expect(a.activeTurn).toBeNull(); expect(activityKnown(a)).toBe(true); expect(isBusy(a)).toBe(false);
  });
  it.each(["running", "initializing", "unknown"])("keeps a stored %s snapshot unavailable for cleanup", (status) => {
    const a = metadata(snapshot({ status }));
    expect(a.activeTurn).toBeUndefined(); expect(activityKnown(a)).toBe(false); expect(isBusy(a)).toBe(true);
  });
  it("preserves an explicit active turn even when the lifecycle says idle", () => {
    const a = metadata(snapshot({ activeTurn: { turnId: "live-turn", startedAt: null } }));
    expect(a.activeTurn).toBe("live-turn"); expect(isBusy(a)).toBe(true);
  });
  it.each([undefined, null])("rejects a missing permissions snapshot: %j", (pendingPermissions) => {
    const a = metadata(snapshot({ pendingPermissions }));
    expect(a.activeTurn).toBeUndefined(); expect(a.pendingPermissions).toBe(-1); expect(isBusy(a)).toBe(true);
  });
  it("keeps stored sessions with pending input protected", () => {
    const a = metadata(snapshot({ pendingPermissions: [{ id: "approval" }] }));
    expect(a.pendingPermissions).toBe(1); expect(isBusy(a)).toBe(true);
  });
});
