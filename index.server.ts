import type { PluginServerContext } from "@getpaseo/plugin/server";
import { JanitorService } from "./server/service";
import { confirmDeleteRpc, preferences, prepareDeleteRpc, protectRpc, scanRpc, snoozeRpc, statusRpc } from "./shared/contracts";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(preferences);
  const service = new JanitorService();
  const configure = async () => {
    const state = await settings.read();
    if (state.status === "ready") await service.configure(state.values);
    else await service.invalidSettings();
  };
  const unsubscribe = settings.subscribe((state) => state.status === "ready" ? service.configure(state.values) : service.invalidSettings());
  void configure().catch(() => service.invalidSettings());
  server.handle(statusRpc, (input) => service.status(input));
  server.handle(scanRpc, () => service.requestScan());
  server.handle(protectRpc, ({ id, protect }) => service.protect(id, protect));
  server.handle(snoozeRpc, ({ id, snooze }) => service.snooze(id, snooze));
  server.handle(prepareDeleteRpc, ({ id }) => service.prepareDelete(id));
  server.handle(confirmDeleteRpc, ({ token, confirmation }) => service.requestDelete(token, confirmation));
  return async () => { unsubscribe(); await service.stop(); };
}
