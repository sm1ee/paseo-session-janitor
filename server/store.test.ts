import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyState } from "../shared/model";
import { FileStore } from "./store";

const directories: string[] = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "paseo-janitor-store-test-"));
  directories.push(directory);
  const path = join(directory, "state.json");
  return { directory, path, store: new FileStore(path, "test") };
}
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
describe("durable cleanup state", () => {
  it("creates defaults only when the file is absent", async () => {
    const { path, store } = await fixture();
    expect(await store.load()).toEqual(emptyState("test"));
    await writeFile(path, "broken JSON");
    await expect(store.load()).rejects.toThrow(/paused/);
    expect(await readFile(path, "utf8")).toBe("broken JSON");
  });
  it("rejects state from a different daemon without overwriting it", async () => {
    const { path, store } = await fixture();
    const previous = JSON.stringify(emptyState("different"));
    await writeFile(path, previous);
    await expect(store.load()).rejects.toThrow(/paused/);
    expect(await readFile(path, "utf8")).toBe(previous);
  });
  it("preserves protection and unresolved receipts in an owner-only atomic file", async () => {
    const { path, directory, store } = await fixture();
    const state = emptyState("test");
    state.protectedIds = ["parent"];
    state.receipts.child = { action: "delete", at: "2026-10-20T00:00:00Z" };
    await store.save(state);
    expect(await store.load()).toEqual(state);
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual(["state.json"]);
  });
});
