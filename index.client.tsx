import type { PluginClientContext, PluginScreenProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Platform } from "react-native";
import { JanitorScreen } from "./client/screen";
import { JanitorSettings } from "./client/settings";

function JanitorItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="BrushCleaning"
      active={currentScreen?.screenId === "main"}
      onPress={() => openScreen({ screenId: "main" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  function Screen(props: PluginScreenProps) {
    return <JanitorScreen {...props} onOpenSettings={() => client.openSettings("preferences")} />;
  }
  client.addScreen({ id: "main", title: "session-janitor", Component: Screen });
  if (Platform.OS === "web") client.addSidebarHeaderItem({ id: "main", title: "session-janitor", Component: JanitorItem });
  client.addSettingsScreen({ id: "preferences", title: "Settings", icon: "Settings2", Component: JanitorSettings });
  client.addCommandCenterItem({ id: "open", title: "Open session-janitor", icon: "BrushCleaning", context: "global", onSelect({ openScreen }) { openScreen({ screenId: "main" }); } });
  client.addCommandCenterItem({ id: "settings", title: "session-janitor settings", icon: "Settings2", context: "global", onSelect({ openSettings }) { openSettings("preferences"); } });
  client.addCommandCenterItem({ id: "delete", title: "Delete this session…", icon: "Trash2", context: "agent", onSelect({ agent, openScreen }) { openScreen({ screenId: "main", params: { agentId: agent.id } }); } });
  return () => {};
}
