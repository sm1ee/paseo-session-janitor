import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { auditSchema } from "../shared/contracts";
import { emptyState, type SavedState } from "../shared/model";

const timestamp = z.number().finite().nonnegative();
const schema = z.object({
  version: z.literal(1), serverId: z.string().min(1), enabled: z.boolean(), activatedAt: timestamp,
  protectedIds: z.array(z.string()), snoozed: z.record(z.string(), timestamp), pinnedWorkspaces: z.array(z.string()),
  observations: z.record(z.string(), z.object({
    fingerprint: z.string(), quietSince: timestamp, firstSeenAt: timestamp,
    archivedAt: z.string().nullable(), retentionSince: timestamp,
  })), receipts: z.record(z.string(), z.object({ action: z.enum(["archive", "delete"]), at: z.string() })), history: z.array(auditSchema).max(100),
});
export interface StateStore { load(): Promise<SavedState>; save(state: SavedState): Promise<void> }
export class FileStore implements StateStore {
  constructor(private readonly path: string, private readonly serverId: string) {}
  async load(): Promise<SavedState> {
    try {
      const state = schema.parse(JSON.parse(await readFile(this.path, "utf8")));
      if (state.serverId !== this.serverId) throw new Error("Host changed");
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState(this.serverId);
      throw new Error("Cannot read cleanup history. Automatic cleanup is paused. Check the plugin's state file.");
    }
  }
  async save(state: SavedState): Promise<void> {
    schema.parse(state);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(state), { flag: "wx", mode: 0o600 });
      await rename(temporary, this.path);
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    }
  }
}
