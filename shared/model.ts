import type { AuditEntry, Preferences, SessionRow } from "./contracts";

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const SETTLE_MS = 60_000;
export interface Agent {
  id: string; title: string; provider: string; workspaceId: string | null;
  parentId: string | null; status: string; updatedAt: string; lastUserMessageAt: string | null;
  attentionReason: string | null; attentionTimestamp: string | null;
  archivedAt: string | null; activeTurn: string | null | undefined;
  pendingPermissions: number; openTab: boolean; internal: boolean; recoveryHold?: boolean;
}
export interface Workspace { id: string; pinned: boolean; archiving: boolean }
export interface Inventory { agents: Agent[]; workspaces: Workspace[] }
export interface Observation {
  fingerprint: string; quietSince: number; firstSeenAt: number;
  archivedAt: string | null; retentionSince: number;
}
export interface SavedState {
  version: 1; serverId: string;
  enabled: boolean; activatedAt: number;
  protectedIds: string[]; snoozed: Record<string, number>;
  pinnedWorkspaces: string[];
  observations: Record<string, Observation>;
  receipts: Record<string, { action: "archive" | "delete"; at: string }>;
  history: AuditEntry[];
}
export function emptyState(serverId: string): SavedState {
  return { version: 1, serverId, enabled: false, activatedAt: 0, protectedIds: [], snoozed: {}, pinnedWorkspaces: [], observations: {}, receipts: {}, history: [] };
}
export function fingerprint(agent: Agent): string {
  return JSON.stringify(agent);
}
export function time(value: string | null | undefined): number {
  const n = value ? Date.parse(value) : NaN;
  return Number.isFinite(n) ? n : 0;
}
export function isBusy(agent: Agent): boolean {
  return !["idle", "error", "closed"].includes(agent.status) || agent.activeTurn != null || agent.pendingPermissions !== 0;
}
export function activityKnown(agent: Agent): boolean {
  return agent.activeTurn === null || Boolean(agent.archivedAt) || agent.status === "closed";
}
export function indexAgents(agents: Agent[]): Map<string, Agent> {
  const index = new Map(agents.map((a) => [a.id, a]));
  if (index.size !== agents.length) throw new Error("The host returned duplicate sessions. Cleanup is paused.");
  return index;
}
export function ancestors(agent: Agent, index: Map<string, Agent>): { parents: Agent[]; valid: boolean } {
  const seen = new Set([agent.id]);
  const parents: Agent[] = [];
  let parentId = agent.parentId;
  while (parentId) {
    if (seen.has(parentId)) return { parents, valid: false };
    seen.add(parentId);
    const parent = index.get(parentId);
    // Missing parents can be hidden, unavailable, or deleted. Do not guess.
    if (!parent || parent.workspaceId !== agent.workspaceId || parent.internal) return { parents, valid: false };
    parents.push(parent);
    parentId = parent.parentId;
  }
  return { parents, valid: true };
}
export function updateObservations(inventory: Inventory, state: SavedState, now: number): void {
  const present = new Set<string>();
  for (const agent of inventory.agents) {
    present.add(agent.id);
    const previous = state.observations[agent.id];
    const key = fingerprint(agent);
    state.observations[agent.id] = {
      fingerprint: key,
      quietSince: previous?.fingerprint === key && previous.quietSince <= now ? previous.quietSince : now,
      firstSeenAt: previous?.firstSeenAt && previous.firstSeenAt <= now ? previous.firstSeenAt : now,
      archivedAt: agent.archivedAt,
      retentionSince: previous?.archivedAt === agent.archivedAt && previous.retentionSince <= now ? previous.retentionSince : now,
    };
  }
  for (const id of Object.keys(state.observations)) if (!present.has(id)) delete state.observations[id];
  updatePins(inventory.workspaces, state);
}
export function updatePins(workspaces: Workspace[], state: SavedState): void {
  const pinned = new Set(state.pinnedWorkspaces);
  for (const workspace of workspaces) {
    if (workspace.pinned) pinned.add(workspace.id); else pinned.delete(workspace.id);
  }
  state.pinnedWorkspaces = [...pinned];
}
export function protectionReason(agent: Agent, parents: Agent[], inventory: Inventory, state: SavedState, now: number): string | null {
  const family = [agent, ...parents];
  if (family.some((a) => a.recoveryHold)) return "Session or parent has pending recovery; dismiss it in session-recovery before cleanup";
  if (family.some((a) => a.internal)) return "Internal session";
  if (family.some((a) => state.protectedIds.includes(a.id))) return "Protected session or parent";
  if (family.some((a) => (state.snoozed[a.id] ?? 0) > now)) return "Cleanup postponed for this session or parent";
  if (family.some((a) => a.workspaceId && state.pinnedWorkspaces.includes(a.workspaceId))) return "Pinned workspace";
  if (family.some((a) => inventory.workspaces.some((w) => w.id === a.workspaceId && w.archiving))) return "Workspace is being archived";
  return null;
}

export function plan(inventory: Inventory, state: SavedState, settings: Preferences, now: number, stableSince: Map<string, number>): SessionRow[] {
  const index = indexAgents(inventory.agents);
  const children = new Map<string, Agent[]>();
  for (const a of inventory.agents) if (a.parentId) children.set(a.parentId, [...(children.get(a.parentId) ?? []), a]);
  return inventory.agents.map((agent): SessionRow => {
    const family = ancestors(agent, index);
    const protectedReason = protectionReason(agent, family.parents, inventory, state, now);
    const row: SessionRow = {
      id: agent.id, title: agent.title, provider: agent.provider,
      kind: agent.parentId ? "subagent" : "main", status: agent.status,
      archivedAt: agent.archivedAt, action: "keep", dueAt: null, reason: "Main sessions are only archived by you",
      protected: Boolean(protectedReason), ownProtection: state.protectedIds.includes(agent.id),
      snoozedUntil: (state.snoozed[agent.id] ?? 0) > now ? new Date(state.snoozed[agent.id]!).toISOString() : null,
    };
    const keep = (reason: string) => ({ ...row, reason });
    if (!agent.workspaceId) return keep("Workspace is unknown");
    if (!family.valid) return keep("Parent relationship could not be verified");
    if (protectedReason) return keep(protectedReason);
    if (isBusy(agent)) return keep("Session is running or waiting for input");
    if (!activityKnown(agent)) return keep("Live session state is unavailable");
    if (agent.openTab) return keep("Session is open in a client");
    if (family.parents.some((p) => isBusy(p) || !activityKnown(p))) return keep("A parent is active or its state is unavailable");
    const observation = state.observations[agent.id];
    if (!observation) return keep("Waiting for the first observation");
    const activation = state.activatedAt;
    const quietAt = (a: Agent) => Math.max(time(a.updatedAt), time(a.lastUserMessageAt), state.observations[a.id]?.quietSince ?? now, activation);
    const settleAt = Math.max(...[agent, ...family.parents].map((a) => (stableSince.get(a.id) ?? now) + SETTLE_MS));
    if (agent.archivedAt) {
      if (agent.parentId ? !settings.deleteChildren : !settings.deleteMain) return keep("Automatic deletion is off");
      if ((children.get(agent.id) ?? []).length) return keep("Waiting for child sessions to be deleted");
      if (agent.parentId && settings.waitForParentArchive && family.parents.some((p) => !p.archivedAt)) return keep("Waiting for every parent to be archived");
      const archivedAt = time(agent.archivedAt);
      if (!archivedAt) return keep("Archive timestamp is unavailable");
      const retention = (agent.parentId ? settings.childRetentionDays : settings.mainRetentionDays) * DAY;
      const due = Math.max(archivedAt, observation.retentionSince, activation) + retention;
      const parentQuiet = family.parents.filter((p) => !p.archivedAt).map((p) => quietAt(p) + settings.archiveAfterHours * HOUR);
      row.action = "delete";
      row.dueAt = new Date(Math.max(due, settleAt, ...parentQuiet)).toISOString();
      row.reason = "Archive retention period";
      return row;
    }
    if (!agent.parentId) return row;
    if (!settings.archiveChildren) return keep("Automatic archiving is off");
    if ((children.get(agent.id) ?? []).some((a) => !a.archivedAt)) return keep("Waiting for child sessions to be archived");
    const terminal = agent.status === "closed" || agent.status === "error" || ["finished", "error"].includes(agent.attentionReason ?? "");
    if (!terminal) return keep("No completed or failed turn reported");
    const finishedAt = time(agent.attentionTimestamp) || (agent.status !== "idle" ? time(agent.updatedAt) : 0);
    if (!finishedAt) return keep("Completion timestamp is unavailable");
    const quiet = Math.max(finishedAt, quietAt(agent), ...family.parents.filter((p) => !p.archivedAt).map(quietAt));
    row.action = "archive";
    row.dueAt = new Date(Math.max(quiet + settings.archiveAfterHours * HOUR, settleAt)).toISOString();
    row.reason = "Finished subagent and quiet parents";
    return row;
  });
}

export function deletionTree(rootId: string, inventory: Inventory, state: SavedState, now: number): Agent[] {
  const index = indexAgents(inventory.agents);
  const root = index.get(rootId);
  if (!root) throw new Error("This session is no longer available. Refresh the list.");
  const ordered: Agent[] = [];
  const visiting = new Set<string>();
  const visit = (agent: Agent) => {
    if (visiting.has(agent.id)) throw new Error("The session tree contains a cycle. Deletion is blocked.");
    visiting.add(agent.id);
    const family = ancestors(agent, index);
    if (!family.valid) throw new Error("The parent relationship could not be verified. Deletion is blocked.");
    const reason = protectionReason(agent, family.parents, inventory, state, now);
    if (reason) throw new Error(`${reason}. Remove that protection before deleting.`);
    if ([agent, ...family.parents].some((a) => isBusy(a) || !activityKnown(a))) throw new Error("A session or parent is active, waiting for input, or has unknown state. Stop it before deleting.");
    // The selected root can be open; its children cannot be open in another tab.
    if (agent.id !== rootId && agent.openTab) throw new Error("A child session is open in a client. Close its tab before deleting.");
    for (const child of inventory.agents.filter((a) => a.parentId === agent.id)) visit(child);
    ordered.push(agent);
  };
  visit(root);
  if (ordered.length > 50) throw new Error("This tree has more than 50 sessions. Clean up smaller branches first.");
  return ordered;
}
