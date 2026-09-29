// ===== player, as a DISCOVERED plugin (P1.18b) =====
// The second core plugin to move onto the discovery path (after `render`, P1.45) and the one that proves the
// PUBLISH direction is enough for a plugin whose systems the root drives:
//
//   * the native mouse capture is a host object (a plugin may not import `host/`), so the root hands it in as a
//     host instance — the same one-way direction as every other instance;
//   * the root drives the input system by hand (the raw-input thread, the frame loop, the focus handlers), so
//     the plugin PUBLISHES it as `PLAYER_HANDLES`: the reverse direction, exactly what `render` does.
//
// `hot: false`: the fixed lane IS the game — turning the player off is a manifest decision (a body with no
// input, movement or collision), not one of the F5–F11 surface keys.
import type { DiscoveredPlugin, PluginHost } from "../../core/plugin/host";
import { PLAYER_HANDLES } from "../../data/globals/player-handles";
import { createPlayerPlugin, type PlayerWiring } from "./index";

export function createPlugin(host: PluginHost): DiscoveredPlugin {
  const mouse = host.instances.mouseCapture as PlayerWiring["mouse"];
  const built = createPlayerPlugin({
    world: host.world,
    log: host.log,
    inWorld: host.inWorld,
    mouse,
  });
  // What the root DRIVES: the raw-input device layer feeds it, the frame loop drains it, the win-focus
  // handlers read its lock state, and `ui.navigation` takes/gives the capture through it.
  host.world.insertResource(PLAYER_HANDLES, { input: built.systems.input });
  return { hot: false, plugin: built.plugin };
}
