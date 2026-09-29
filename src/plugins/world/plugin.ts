// ===== world, as a DISCOVERED plugin (P1.18b) =====
// The voxel world claims the VOXEL token and nothing else — the world object itself is a resource the root
// inserts (it is built before the install, because `loadLang`/`buildBlockRegistry`/the palette all read it).
//
// `hot: false`: there is no game without a world, and its systems (chunk stream, collision, interaction) read
// it in their constructors, so it can never arrive later.
import type { DiscoveredPlugin, PluginHost } from "../../core/plugin/host";
import { worldPlugin } from "./index";

export function createPlugin(host: PluginHost): DiscoveredPlugin {
  void host;
  return { hot: false, plugin: worldPlugin };
}
