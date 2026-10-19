import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { confirmDeleteRpc, prepareDeleteRpc, protectRpc, scanRpc, snoozeRpc, statusRpc, type DeletePreview, type SessionRow } from "../shared/contracts";

const scopeOptions = [
  ["queue", "Scheduled"], ["main", "Main sessions"], ["archived", "Archived"], ["protected", "Protected"], ["all", "All sessions"],
] as const;
type Scope = typeof scopeOptions[number][0];
const stateText = { starting: "Connecting…", preview: "Preview only", running: "Automatic cleanup is on", error: "Cleanup is paused" };
function date(value: string | null): string { return value ? new Date(value).toLocaleString() : ""; }

export function JanitorScreen({ theme, layout, params, onOpenSettings }: PluginScreenProps & { onOpenSettings: () => void }) {
  const requestedId = typeof params?.agentId === "string" ? params.agentId : "";
  const [query, setQuery] = useState(requestedId);
  const [scope, setScope] = useState<Scope>(requestedId ? "all" : "queue");
  const [page, setPage] = useState(0);
  const [preview, setPreview] = useState<DeletePreview | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const status = useRpc(statusRpc);
  const scan = useRpc(scanRpc);
  const protect = useRpc(protectRpc);
  const snooze = useRpc(snoozeRpc);
  const prepareDelete = useRpc(prepareDeleteRpc);
  const confirmDelete = useRpc(confirmDeleteRpc);
  const cache = useQueryClient();
  const refresh = () => { void cache.invalidateQueries({ queryKey: ["janitor"] }); };
  const result = useQuery({ queryKey: ["janitor", query, scope, page], queryFn: () => status({ query, scope, page }), refetchInterval: 10_000 });
  const mutation = useMutation({
    mutationFn: async (action: { kind: "scan" } | { kind: "protect" | "snooze" | "review"; row: SessionRow } | { kind: "delete" }) => {
      setNotice(null);
      if (action.kind === "scan") { await scan({}); setNotice("Session refresh requested."); }
      if (action.kind === "protect") await protect({ id: action.row.id, protect: !action.row.ownProtection });
      if (action.kind === "snooze") await snooze({ id: action.row.id, snooze: !action.row.snoozedUntil });
      if (action.kind === "review") { setPreview(await prepareDelete({ id: action.row.id })); setConfirmation(""); }
      if (action.kind === "delete" && preview && confirmation === "DELETE") {
        await confirmDelete({ token: preview.token, confirmation: "DELETE" });
        setPreview(null); setConfirmation("");
        setNotice("Deletion started. Progress is shown below.");
      }
    },
    onSettled: refresh,
    onError: (error) => { setNotice(error instanceof Error ? error.message : "The request failed. Try again."); setPreview(null); },
  });
  const busy = mutation.isPending;
  const colors = theme.colors;
  const text = { color: colors.foreground };
  const muted = { color: colors.foregroundMuted, fontSize: 12 };
  const button = (label: string, onPress: () => void, disabled = false, danger = false) => <Pressable
    accessibilityRole="button" accessibilityLabel={label} disabled={disabled || busy} onPress={onPress}
    style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 6, backgroundColor: colors.surface2, borderWidth: danger ? 1 : 0, borderColor: colors.statusDanger, opacity: disabled || busy ? 0.5 : 1 }}
  ><Text style={{ color: danger ? colors.statusDanger : colors.foreground, fontSize: 12 }}>{label}</Text></Pressable>;
  const data = result.data;
  return <ScrollView style={{ flex: 1, backgroundColor: colors.surface0 }} contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 20, maxWidth: 1040, width: "100%", alignSelf: "center" }}>
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
        <Text style={{ ...text, fontSize: 24, fontWeight: "600", flexShrink: 1 }}>session-janitor</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Open settings" onPress={onOpenSettings}
          style={{ paddingVertical: 9, paddingHorizontal: 14, borderRadius: 6, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface2 }}>
          <Text style={{ ...text, fontSize: 13 }}>Settings</Text>
        </Pressable>
      </View>
      <Text style={muted}>Archive finished subagents after a quiet period. Delete archived sessions when their retention period ends.</Text>
      <Text style={{ ...text, fontWeight: "600" }}>{data ? stateText[data.state] : "Connecting…"}</Text>
      {data?.state === "preview" && <Text style={muted}>Automatic changes are off. Open Settings to enable them. Manual deletion is available below.</Text>}
      {data?.otherCleaner && <Text style={text}>A separate subagent cleaner is installed on this Mac. It can still archive sessions while this plugin is in preview mode.</Text>}
      {(data?.error || result.isError) && <Text style={text}>{data?.error ?? "Cannot read this host's session list. Check the connection and refresh."}</Text>}
      {data && <Text style={muted}>{data.counts.archive} scheduled for archive · {data.counts.delete} scheduled for deletion · {data.counts.protected} protected · {data.counts.total} sessions</Text>}
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {button(data?.scanning ? "Refreshing…" : busy ? "Working…" : "Refresh sessions", () => mutation.mutate({ kind: "scan" }), data?.scanning)}
        <Text style={muted}>{data?.lastScanAt ? `Checked ${date(data.lastScanAt)}` : ""}</Text>
      </View>
      <Text style={muted}>Cleanup runs every 5 minutes while the daemon is running. Enabling it starts a fresh retention period for existing archives.</Text>
    </View>
    {notice && <Text accessibilityRole="alert" style={text}>{notice}</Text>}
    {data && data.deletion.state !== "idle" && <View style={{ gap: 8, padding: 16, backgroundColor: colors.surface1, borderWidth: 1, borderColor: colors.border, borderRadius: 8 }}>
      <Text style={text}>{data.deletion.state === "running" ? "Deleting sessions…" : data.deletion.state === "done" ? "Deletion complete" : "Deletion stopped"} · {data.deletion.deleted} / {data.deletion.total}</Text>
      {data.deletion.error && <Text style={text}>{data.deletion.error}</Text>}
    </View>}
    {preview && <View style={{ gap: 12, padding: 16, borderWidth: 1, borderColor: colors.statusDanger, borderRadius: 8 }}>
      <Text style={{ ...text, fontSize: 18, fontWeight: "600" }}>Delete {preview.count === 1 ? "this session" : `these ${preview.count} sessions`}?</Text>
      <Text style={text}>This permanently removes Paseo session records and their Paseo conversation history. Project files and worktrees stay in place. Provider CLI history may remain.</Text>
      {preview.sessions.map((title, i) => <Text key={i} numberOfLines={2} style={muted}>{title}</Text>)}
      <Text style={muted}>Type DELETE to confirm. This preview expires at {date(preview.expiresAt)}.</Text>
      <TextInput value={confirmation} onChangeText={setConfirmation} editable={!busy} autoCapitalize="characters" autoCorrect={false} accessibilityLabel="Type DELETE to confirm"
        placeholder="DELETE" placeholderTextColor={colors.foregroundMuted}
        style={{ ...text, padding: 10, backgroundColor: colors.surface1, borderColor: colors.border, borderWidth: 1, borderRadius: 6 }} />
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        {button("Delete permanently", () => mutation.mutate({ kind: "delete" }), confirmation !== "DELETE", true)}
        {button("Cancel", () => { setPreview(null); setConfirmation(""); })}
      </View>
    </View>}
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
        {scopeOptions.map(([value, label]) => <Pressable key={value} accessibilityRole="button" accessibilityState={{ selected: scope === value }} onPress={() => { setScope(value); setPage(0); }}
          style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 6, backgroundColor: scope === value ? colors.accent : colors.surface1 }}>
          <Text style={{ color: scope === value ? colors.accentForeground : colors.foreground, fontSize: 12 }}>{label}</Text>
        </Pressable>)}
      </View>
      <TextInput value={query} onChangeText={(value) => { setQuery(value); setPage(0); }} placeholder="Find a session by name, provider, or ID" placeholderTextColor={colors.foregroundMuted} accessibilityLabel="Find a session"
        style={{ ...text, padding: 12, backgroundColor: colors.surface1, borderColor: colors.border, borderWidth: 1, borderRadius: 6 }} />
      {!data?.rows.length && <Text style={muted}>{result.isPending ? "Loading sessions…" : "No sessions in this view. Try All sessions to see why a session is being kept."}</Text>}
      {data?.rows.map((row) => <View key={row.id} style={{ gap: 8, padding: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1, borderRadius: 8 }}>
        <Text style={{ ...text, fontWeight: "600" }} numberOfLines={2}>{row.title}</Text>
        <Text style={muted}>{row.kind === "main" ? "Main session" : "Subagent"} · {row.provider} · {row.archivedAt ? "archived" : row.status} · {row.id.slice(0, 8)}</Text>
        <Text style={text}>{row.action === "keep" ? row.reason : `${row.action === "archive" ? "Archive" : "Delete"} ${date(row.dueAt)}`}</Text>
        {row.action !== "keep" && <Text style={muted}>{row.reason}{data.state === "preview" ? " · Preview only" : ""}</Text>}
        {row.snoozedUntil && <Text style={muted}>Postponed until {date(row.snoozedUntil)}</Text>}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {button(row.ownProtection ? "Remove protection" : "Protect", () => mutation.mutate({ kind: "protect", row }))}
          {button(row.snoozedUntil ? "End postponement" : "Postpone 24h", () => mutation.mutate({ kind: "snooze", row }))}
          {button("Review deletion…", () => mutation.mutate({ kind: "review", row }), row.protected || data.deletion.state === "running")}
        </View>
      </View>)}
      {data && data.total > 30 && <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {button("Previous", () => setPage(data.page - 1), data.page === 0)}
        <Text style={muted}>{data.page + 1} / {Math.ceil(data.total / 30)} · {data.total} sessions</Text>
        {button("Next", () => setPage(data.page + 1), (data.page + 1) * 30 >= data.total)}
      </View>}
    </View>
    {!!data?.history.length && <View style={{ gap: 8 }}>
      <Text style={{ ...text, fontSize: 18, fontWeight: "600" }}>Recent cleanup</Text>
      {data.history.map((entry, i) => <Text key={`${entry.id}-${entry.at}-${i}`} style={muted}>{date(entry.at)} · {entry.action} · {entry.id.slice(0, 8)} · {entry.result}</Text>)}
    </View>}
  </ScrollView>;
}
