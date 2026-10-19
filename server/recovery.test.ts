import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readRecoveryHolds } from "./recovery";
const homes: string[] = [];
async function fixture() { const home = await mkdtemp(join(tmpdir(), "janitor-recovery-test-")); homes.push(home); const directory = join(home, "plugin-data", "session-recovery"); await mkdir(directory, { recursive: true }); return { home, path: join(directory, "holds.json") }; }
afterEach(async () => { for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });
describe("recovery protection", () => {
  it("works without the optional recovery plugin", async () => { const f = await fixture(); expect(await readRecoveryHolds(f.home, "host")).toEqual(new Set()); });
  it("reads only session IDs from the matching host", async () => {
    const f = await fixture(); await writeFile(f.path, JSON.stringify({ version: 1, serverId: "host", ids: ["session"] }));
    expect(await readRecoveryHolds(f.home, "host")).toEqual(new Set(["session"]));
    await expect(readRecoveryHolds(f.home, "other")).rejects.toThrow(/paused/);
  });
  it("pauses cleanup on a corrupted protection list", async () => { const f = await fixture(); await writeFile(f.path, "corrupt"); await expect(readRecoveryHolds(f.home, "host")).rejects.toThrow(/paused/); });
  it("does not treat an incomplete recovery installation as no protection", async () => { const f = await fixture(); await writeFile(join(f.path, "..", "state.json"), "{}"); await expect(readRecoveryHolds(f.home, "host")).rejects.toThrow(/paused/); });
});
