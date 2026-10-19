import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const holdsSchema = z.object({ version: z.literal(1), serverId: z.string(), ids: z.array(z.string().min(1)).max(2000) });
export async function readRecoveryHolds(home: string, serverId: string): Promise<Set<string>> {
  try {
    const holds = holdsSchema.parse(JSON.parse(await readFile(join(home, "plugin-data", "session-recovery", "holds.json"), "utf8")));
    if (holds.serverId !== serverId) throw new Error("Host changed");
    return new Set(holds.ids);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // No optional plugin is normal. A journal without its protection list is
      // incomplete and must not silently release pending recovery to cleanup.
      try { await stat(join(home, "plugin-data", "session-recovery", "state.json")); }
      catch (missing) { if ((missing as NodeJS.ErrnoException).code === "ENOENT") return new Set(); }
    }
    throw new Error("Recovery protections could not be verified. Cleanup is paused. Check session-recovery before continuing.");
  }
}
