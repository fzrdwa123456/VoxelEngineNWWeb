// ===== ui-inventory, as a DISCOVERED plugin (P1.40), and it CONSTRUCTS ITSELF now (P1.18c) =====
// It used to narrow THREE host instances (`uiInventory`, `inv`, `inWorld`) around a view the ROOT had built. The
// view, the widget handles and the reconcile system are this plugin's, so they are built here, at wiring time
// (a `setup` may NOT change the entity structure — iron rule 1, an install is not a barrier). `hot: true` -> F11.
//
// WHAT IT STILL TAKES FROM THE HOST, and why each one is an instance rather than an import:
//   * `iconSource` — the block ICON BAKER: a `host/` object (three.js + a render target), which a plugin may not
//     import. It is the same three functions the root used to hand the system directly;
//   * `inWorld` — "is a world running", which the HUD element gates on.
//
// WHAT IT PUBLISHES BACK: `INVENTORY_HANDLES.panel`, because `ui.navigation` — a different plugin — paints the
// modal trees and the backpack's panel is one of them. Same direction as `UI_HANDLES`.
import type { DiscoveredPlugin, PluginHost } from "../../core/plugin/host";
import { INVENTORY_WIDGETS, LOCAL_PLAYER } from "../../data/globals/resources";
import { INVENTORY_HANDLES } from "../../data/globals/ui-handles";
import {
  createInventorySystem,
  createInventoryView,
  createUiInventoryPlugin,
  type IconSource,
} from "./index";

export function createPlugin(host: PluginHost): DiscoveredPlugin {
  const world = host.world;
  // The entity, not a handle the root passes: the LOCAL_PLAYER resource exists before the catalogue runs.
  const player = world.resource(LOCAL_PLAYER);
  const inv = createInventoryView(world, player);
  // The handles the reconciler writes into (the view only spawns them).
  world.insertResource(INVENTORY_WIDGETS, inv.widgets);
  const uiInventory = createInventorySystem(world, host.instances.iconSource as IconSource);
  // What the ROOT paints with: the bag's panel entity (see INVENTORY_HANDLES).
  world.insertResource(INVENTORY_HANDLES, { panel: inv.panelEntity });
  return { hot: true, plugin: createUiInventoryPlugin({ uiInventory, inv, inWorld: host.inWorld }) };
}
