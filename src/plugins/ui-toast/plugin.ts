// ===== ui-toast, as a DISCOVERED plugin (P1.40) =====
// See `plugins/ui-debug/plugin.ts` for the shape: the folder opts in with this file, and the ADAPTER narrows
// the host instance it needs. `hot: true` gives it a hot-plug key (F10).
import type { DiscoveredPlugin, PluginHost } from "../../core/plugin/host";
import { createUiToastPlugin } from "./index";

export function createPlugin(host: PluginHost): DiscoveredPlugin {
  const uiToast = host.instances.uiToast as { step(): void; close(): void };
  return { hot: true, plugin: createUiToastPlugin({ uiToast }) };
}
