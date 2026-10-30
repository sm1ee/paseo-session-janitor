import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text, View } from "react-native";
import { preferences, type Preferences } from "../shared/contracts";

function TimingFields({ values, save, busy }: { values: Preferences; save: (values: Preferences) => void; busy: boolean }) {
  const [hours, setHours] = useState(String(values.archiveAfterHours));
  const [children, setChildren] = useState(String(values.childRetentionDays));
  const [main, setMain] = useState(String(values.mainRetentionDays));
  const [home, setHome] = useState(values.daemonHome);
  const parsed = preferences.schema.safeParse({ ...values, archiveAfterHours: Number(hours), childRetentionDays: Number(children), mainRetentionDays: Number(main), daemonHome: home.trim() });
  return <>
    <SettingsSection title="Timing">
      <SettingsCard>
        <SettingsInput label="Archive after (hours)" hint="A finished subagent and its parents must stay quiet this long. Minimum: 0.25 hours." initialValue={hours} onChangeText={setHours} disabled={busy} />
        <SettingsInput label="Keep archived subagents (days)" hint="Whole days, from 1 to 3650." initialValue={children} onChangeText={setChildren} disabled={busy} />
        <SettingsInput label="Keep archived main sessions (days)" hint="Whole days, from 1 to 3650." initialValue={main} onChangeText={setMain} disabled={busy} />
      </SettingsCard>
    </SettingsSection>
    <SettingsSection title="Paseo home">
      <SettingsCard>
        <SettingsInput label="Home directory" hint="Leave empty for automatic detection. This must belong to the daemon running the plugin." initialValue={home} onChangeText={setHome} disabled={busy} />
        <SettingsAction label={parsed.success ? "Save timing and home directory" : "Enter valid hours and retention days"} actionLabel="Save" disabled={busy || !parsed.success} onPress={() => { if (parsed.success) save(parsed.data); }} />
      </SettingsCard>
    </SettingsSection>
  </>;
}

export function JanitorSettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(preferences);
  const text = { color: theme.colors.foreground };
  const muted = { color: theme.colors.foregroundMuted };
  if (settings.status !== "ready") return <SettingsSection title="Session Janitor">
    <Text style={text}>{settings.status === "loading" ? "Loading settings…" : "Could not read settings. Reload them or restore defaults."}</Text>
    {settings.status !== "loading" && <SettingsCard>
      <SettingsAction label="Reload settings" actionLabel="Reload" onPress={() => { void settings.reload(); }} />
      <SettingsAction label="Restore defaults" hint="Automatic cleanup is off by default." actionLabel="Restore" onPress={() => { void settings.reset(); }} />
    </SettingsCard>}
  </SettingsSection>;
  const values = settings.values;
  const save = (next: Preferences) => { void settings.save(next, settings.revision); };
  return <View style={{ gap: 24 }}>
    <SettingsSection title="Session Janitor">
      <Text style={muted}>Start with the preview in Session Janitor. When automatic cleanup is enabled, existing archives get a full retention period from that moment.</Text>
      <SettingsCard>
        <SettingsSwitch label="Automatic cleanup" hint="Runs on this daemon every 5 minutes, even when the app is closed. Turning this off keeps the preview and manual deletion available." value={values.enabled} disabled={settings.saving} onValueChange={(enabled) => save({ ...values, enabled })} />
        <SettingsSwitch label="Archive finished subagents" hint="Includes failed and closed subagents after the quiet period. Main sessions are never archived automatically." value={values.archiveChildren} disabled={settings.saving} onValueChange={(archiveChildren) => save({ ...values, archiveChildren })} />
        <SettingsSwitch label="Delete archived subagents" value={values.deleteChildren} disabled={settings.saving} onValueChange={(deleteChildren) => save({ ...values, deleteChildren })} />
        <SettingsSwitch label="Keep subagents until their parents are archived" hint="Recommended. Idle parents can still need a subagent's result. When off, every parent must instead stay quiet for the configured number of hours." value={values.waitForParentArchive} disabled={settings.saving} onValueChange={(waitForParentArchive) => save({ ...values, waitForParentArchive })} />
        <SettingsSwitch label="Delete archived main sessions" hint="Only sessions you have already archived. Child sessions are deleted first." value={values.deleteMain} disabled={settings.saving} onValueChange={(deleteMain) => save({ ...values, deleteMain })} />
      </SettingsCard>
      {settings.saveError && <Text style={text}>Could not save settings. Reload and try again.</Text>}
    </SettingsSection>
    <TimingFields key={settings.revision} values={values} save={save} busy={settings.saving} />
    <SettingsSection title="Sessions to keep">
      <Text style={muted}>Protect a session in the Session Janitor screen to exclude it and its children. You can also postpone cleanup for 24 hours. Open session tabs, pending approvals, active parents, and pinned workspaces are excluded from automatic cleanup.</Text>
      <Text style={muted}>Paseo reports turn completion, not whether a parent has finished using a result. Archiving uses an inactivity delay. Permanent deletion waits for archived parents by default.</Text>
    </SettingsSection>
  </View>;
}
