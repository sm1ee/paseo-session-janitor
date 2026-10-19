import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
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
  client.addScreen({ id: "main", title: "Session janitor", Component: JanitorScreen });
  client.addSidebarFooterItem({ id: "main", title: "Session janitor", Component: JanitorItem });
  client.addSettingsScreen({ id: "preferences", title: "Session janitor", icon: "BrushCleaning", Component: JanitorSettings });
  client.addCommandCenterItem({ id: "open", title: "Open Session janitor", icon: "BrushCleaning", context: "global", onSelect({ openScreen }) { openScreen({ screenId: "main" }); } });
  client.addCommandCenterItem({ id: "settings", title: "Session janitor settings", icon: "Settings2", context: "global", onSelect({ openSettings }) { openSettings("preferences"); } });
  client.addCommandCenterItem({ id: "delete", title: "Delete this session…", icon: "Trash2", context: "agent", onSelect({ agent, openScreen }) { openScreen({ screenId: "main", params: { agentId: agent.id } }); } });
  return () => {};
}
