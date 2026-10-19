import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const preferences = defineSettings({
  id: "preferences",
  scope: "host",
  version: 1,
  schema: z.object({
    enabled: z.boolean().default(false),
    archiveChildren: z.boolean().default(true),
    archiveAfterHours: z.number().min(0.25).max(8760).default(6),
    deleteChildren: z.boolean().default(true),
    childRetentionDays: z.number().int().min(1).max(3650).default(3),
    waitForParentArchive: z.boolean().default(true),
    deleteMain: z.boolean().default(true),
    mainRetentionDays: z.number().int().min(1).max(3650).default(3),
    daemonHome: z.string().default(""),
  }),
});
export type Preferences = z.output<typeof preferences.schema>;

export const sessionRowSchema = z.object({
  id: z.string(), title: z.string(), provider: z.string(),
  kind: z.enum(["main", "subagent"]), status: z.string(),
  archivedAt: z.string().nullable(),
  action: z.enum(["archive", "delete", "keep"]),
  dueAt: z.string().nullable(), reason: z.string(),
  protected: z.boolean(), ownProtection: z.boolean(),
  snoozedUntil: z.string().nullable(),
});
export type SessionRow = z.output<typeof sessionRowSchema>;
export const auditSchema = z.object({
  at: z.string(), id: z.string(), action: z.enum(["archive", "delete"]),
  result: z.enum(["started", "done", "unverified"]),
});
export type AuditEntry = z.output<typeof auditSchema>;
export const statusInput = z.object({
  query: z.string().max(200).default(""),
  scope: z.enum(["queue", "all", "main", "archived", "protected"]).default("queue"),
  page: z.number().int().min(0).max(10000).default(0),
});
export const statusSchema = z.object({
  state: z.enum(["starting", "preview", "running", "error"]),
  scanning: z.boolean(),
  deletion: z.object({ state: z.enum(["idle", "running", "done", "error"]), total: z.number(), deleted: z.number(), error: z.string().nullable() }),
  lastScanAt: z.string().nullable(), error: z.string().nullable(),
  otherCleaner: z.boolean(),
  counts: z.object({ total: z.number(), archive: z.number(), delete: z.number(), protected: z.number() }),
  rows: z.array(sessionRowSchema), total: z.number(), page: z.number(),
  history: z.array(auditSchema),
});
export type JanitorStatus = z.output<typeof statusSchema>;
export const statusRpc = defineRpc({ name: "janitor.status", input: statusInput, output: statusSchema });
export const scanRpc = defineRpc({ name: "janitor.scan", input: z.object({}), output: z.object({ ok: z.literal(true) }) });
export const protectRpc = defineRpc({
  name: "janitor.protect", input: z.object({ id: z.string().min(1), protect: z.boolean() }), output: z.object({ ok: z.literal(true) }),
});
export const snoozeRpc = defineRpc({
  name: "janitor.snooze", input: z.object({ id: z.string().min(1), snooze: z.boolean() }), output: z.object({ ok: z.literal(true) }),
});
export const prepareDeleteRpc = defineRpc({
  name: "janitor.delete.prepare", input: z.object({ id: z.string().min(1) }),
  output: z.object({ token: z.string(), title: z.string(), count: z.number(), sessions: z.array(z.string()), expiresAt: z.string() }),
});
export type DeletePreview = z.output<typeof prepareDeleteRpc.output>;
export const confirmDeleteRpc = defineRpc({
  name: "janitor.delete.confirm", input: z.object({ token: z.string(), confirmation: z.literal("DELETE") }),
  output: z.object({ accepted: z.literal(true) }),
});
