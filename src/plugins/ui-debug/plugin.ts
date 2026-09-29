// ===== ui-debug, as a DISCOVERED plugin (P1.40), and it CONSTRUCTS ITSELF now (P1.18c) =====
// The last core-surface plugin to leave the composition root: it used to narrow ONE host instance (`uiPicker`)
// around a panel the ROOT had spawned. The panel, the items and the system are this plugin's, so they are built
// here, at wiring time (a `setup` may NOT change the entity structure — iron rule 1, an install is not a
// barrier). With this, **no system is constructed by the root at all** — 22 of 22 come from the plugin that
// declares them. `hot: true` -> F8.
//
// WHAT IT STILL TAKES FROM THE HOST, and why:
//   * `f3Panel` — the F3 DEBUG PANEL is a widget of the ui plugin's HUD VIEW, which the ROOT spawns (a view's
//     construction is the root's, because spawning is a structural change and the root decides WHEN it happens:
//     `diagnostics` reads the widget handles before this plugin is built). So it arrives as an instance, exactly
//     like the ui plugin gets it;
//   * `inWorld`, `log` — the host's.
//
// THE PLAYER IS NOT AN INSTANCE: the LOCAL_PLAYER resource and the player plugin's own components/commands are
// reachable from here, because `player` is a DECLARED dep of this plugin (it reads CONTROL and sends SetMode).
import type { DiscoveredPlugin, PluginHost } from "../../core/plugin/host";
import type { Entity } from "../../core/world";
import { LOCAL_PLAYER } from "../../data/globals/resources";
import { CONTROL } from "../player/components";
import { SetMode } from "../player/commands";
import { createPickerSystem, createUiDebugPlugin, spawnPickerPanel } from "./index";

export function createPlugin(host: PluginHost): DiscoveredPlugin {
  const world = host.world;
  const player = world.resource(LOCAL_PLAYER);
  const picker = spawnPickerPanel(world);
  const uiPicker = createPickerSystem(world, {
    panel: picker.panel,
    items: picker.items,
    debugPanel: host.instances.f3Panel as Entity,
    // The player's mode and how to change it: a component read and the SetMode COMMAND, injected so the picker
    // system itself only ever writes widget data.
    readMode: () => world.get(player, CONTROL)?.mode ?? "walk",
    applyMode: (mode) => world.commands.send(SetMode, { entity: player, mode }),
    inWorld: host.inWorld,
    log: host.log,
  });
  return { hot: true, plugin: createUiDebugPlugin({ uiPicker }) };
}
