// ===== diagnostics, as a DISCOVERED plugin (P1.43) =====
// The first CORE plugin to move onto the discovery path, and the easiest one: the root never uses a handle this
// plugin constructs (it declares one system and claims two resources), so `createPlugin(host)` needs nothing
// but the world. The four optional surfaces moved first (P1.40); `player` / `render` / `ui` cannot follow yet
// — the root constructs their systems and views and USES those handles, which needs a shape of its own.
//
// `hot: false`: turning the diagnostics off is a manifest decision (a restart), not one of the F8-F11 keys.
import type { DiscoveredPlugin, PluginHost } from "../../core/plugin/host";
import { createDiagnosticsPlugin } from "./index";

export function createPlugin(host: PluginHost): DiscoveredPlugin {
  return { hot: false, plugin: createDiagnosticsPlugin(host.world) };
}
