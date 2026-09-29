// ===== content-default, as a DISCOVERED plugin (P1.18b) =====
// The engine's built-in content declares itself and needs nothing from the root: its `setup` discovers the
// language set and the block table from the PACK CHAIN (which is preloaded before the install) and contributes
// them, and its `start` reports what the install actually has. So the adapter has no instances to narrow.
//
// `hot: false`: content is an install-time statement — the dictionaries and the block registry are built from
// what it declared right after the install, so plugging it in later would have nothing to re-run.
import type { DiscoveredPlugin, PluginHost } from "../../core/plugin/host";
import { contentDefaultPlugin } from "./index";

export function createPlugin(host: PluginHost): DiscoveredPlugin {
  void host;
  return { hot: false, plugin: contentDefaultPlugin };
}
