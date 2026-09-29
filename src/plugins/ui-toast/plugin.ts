// ===== ui-toast, as a DISCOVERED plugin (P1.40), and it CONSTRUCTS ITSELF now (P1.18c) =====
// The adapter used to narrow ONE instance the root had built (`host.instances.uiToast`) around a panel the ROOT
// spawned. Both are this plugin's, so both live here: `spawnToastPanel` is its own view and `createToastSystem`
// its own system, and nothing in the composition root constructs either. That completes the rule the plugin
// system has been moving towards — a folder owns its surface end to end — and it makes turning the plugin off
// mean what it says: no panel is spawned at all, rather than a panel nobody paints.
//
// WHAT IT STILL TAKES FROM THE HOST: `world`. A plugin may not import `host/`, and the panel/system need
// nothing else. `hot: true` gives it a hot-plug key (F10).
import type { DiscoveredPlugin, PluginHost } from "../../core/plugin/host";
import { createToastSystem, createUiToastPlugin, spawnToastPanel } from "./index";

export function createPlugin(host: PluginHost): DiscoveredPlugin {
  // Wiring time, which is where spawning belongs (a `setup` may NOT change the entity structure — iron rule 1,
  // an install is not a barrier). The catalogue runs this while the resources are already in the world.
  const panel = spawnToastPanel(host.world);
  const uiToast = createToastSystem(host.world, panel.panel, panel.body);
  return { hot: true, plugin: createUiToastPlugin({ uiToast }) };
}
