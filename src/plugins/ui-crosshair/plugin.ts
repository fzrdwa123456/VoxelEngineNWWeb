// ===== ui-crosshair, as a DISCOVERED plugin (P1.40/P1.48) =====
// The smallest discovery adapter there is: the plugin needs the host for exactly ONE thing ("is a world
// running"), and its widgets come from the world the host hands its element's `build` at mount time — so no
// instance is injected at all. `hot: true` is what gives it a key (F5, data/globals/hotplug.ts).
import type { DiscoveredPlugin, PluginHost } from "../../core/plugin/host";
import { createUiCrosshairPlugin } from "./index";

export function createPlugin(host: PluginHost): DiscoveredPlugin {
  return { hot: true, plugin: createUiCrosshairPlugin({ inWorld: host.inWorld }) };
}
