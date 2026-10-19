import { describe, expect, it } from "vitest";
import { belongsToDaemon, collectPages, localEndpoint } from "./host";

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
