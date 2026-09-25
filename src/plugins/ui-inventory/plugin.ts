// ===== ui-inventory, as a DISCOVERED plugin (P1.40) =====
// See `plugins/ui-debug/plugin.ts` for the shape. This one needs THREE things: the reconcile system, the view
// (its HUD element's `buildHotbar`) and the world predicate its element gates on. `hot: true` -> F11.
import type { DiscoveredPlugin, PluginHost } from "../../core/plugin/host";
import { createUiInventoryPlugin } from "./index";
import type { Inventory } from "./views/inventory";

export function createPlugin(host: PluginHost): DiscoveredPlugin {
  const uiInventory = host.instances.uiInventory as { step(): void };
  const inv = host.instances.inv as Inventory;
  const inWorld = host.inWorld;
  return { hot: true, plugin: createUiInventoryPlugin({ uiInventory, inv, inWorld }) };
}
