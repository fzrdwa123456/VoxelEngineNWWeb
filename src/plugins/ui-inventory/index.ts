// ===== Plugin: ui-inventory =====
// The INVENTORY layer: the panel opened with E, the hotbar it shares its data with, and the system that reconciles
// both from the INVENTORY component (and bakes block icons through the injected render hooks). It left the ui
// plugin in P1.31, so "no inventory layer" is a manifest line.
//
// WHY BOTH TREES MOVED TOGETHER: the backpack and the hotbar render from the SAME data (one INVENTORY record,
// one INVENTORY_WIDGETS handle set) through one reconcile pass, and the crosshair — the other half of the
// gameplay HUD — stays in `ui.hud` with the gate that hides them outside a world. Splitting the hotbar from the
// backpack would have meant two reconcilers reading one component, i.e. the drift that pattern exists to avoid.
//
// WHY THE HOTBAR IS *THIS* PLUGIN'S HUD ELEMENT (P1.35): it used to be one of the CORE's two rows in the HUD
// table, gated on "is the inventory layer installed". A gate can only HIDE, so uninstalling the layer left the
// strip's widgets on the scene (invisible, unwritable, and rebuilt never) — the residue trap, one level down.
// Contributing it to `SLOT_UI_HUD` makes the uninstall a real DESPAWN: the element leaves the table, `ui.hud`
// disposes of it and despawns the whole strip, and installing it again BUILDS a new one through `buildHotbar`
// (which also has to invalidate the reconcile cache — a strip that came back blank is exactly that bug).
//
// IT NEEDS NO MOUNT for the BAG: the bag panel is a TOP-LEVEL widget (like the toast), so the layer hot-plugs
// in BOTH directions — installed from off while the game runs, and uninstalled without leaving a surface
// behind (`stop` closes the bag, so nothing stays reachable-but-unpainted).
import { SLOT_RESOURCES, SLOT_UI_HUD } from "../../core/extension/slots";
import { definePlugin } from "../../core/plugin/descriptor";
import type { Plugin } from "../../core/plugin/descriptor";
import type { PluginApi } from "../../core/plugin/api";
import type { Entity, World } from "../../core/world";
import { UI_MODAL, INVENTORY_WIDGETS } from "../../data/globals/resources";
import type { UiHudElement } from "../../data/globals/ui-hud";
import { INVENTORY_VIEW_ACCESS, UiInventorySystem } from "./systems/inventory";
import { Inventory } from "./views/inventory";

/** The backpack/bag widgets, built during wiring (spawning is a structural change). The HOTBAR's widgets are
 *  NOT built here: they are the HUD element's `build` (see below), because their lifetime is the host's. */
export function createInventoryView(world: World, player: Entity): Inventory {
  return new Inventory(world, player);
}

export function createInventorySystem(
  ...args: ConstructorParameters<typeof UiInventorySystem>
): UiInventorySystem {
  return new UiInventorySystem(...args);
}

export interface UiInventorySystems {
  readonly uiInventory: { step(): void };
  /** The VIEW, for the HUD element's `build`: the strip's widgets are this plugin's to create, at a barrier
   *  the host picks (it knows when a mount is legal, the plugin knows WHAT to mount). */
  readonly inv: Inventory;
  /** "Is a world running?" — the element's own gate. A HUD element is mounted in every mode and only made
   *  VISIBLE in a world; the bag's own gate (the E key, its mouse bind) is the root's, in ui.navigation. */
  readonly inWorld: () => boolean;
}

export function declareUiInventorySystems(api: PluginApi, s: UiInventorySystems): void {
  api.system({
    // The bag + the hotbar. It writes the widget data for both, so it must run before every other widget
    // writer — ordered against the core's anchors, never against another OPTIONAL surface (see ui/index.ts).
    name: "ui.inventory",
    stage: "ui",
    after: ["ui.slot.bag"],
    before: ["ui.slot.debug"],
    ...INVENTORY_VIEW_ACCESS,
    run: () => s.uiInventory.step(),
  });
}

export function createUiInventoryPlugin(s: UiInventorySystems): Plugin {
  return definePlugin({
    id: "ui-inventory",
    // The widget layer it renders into, and the player's INVENTORY component.
    deps: ["ui", "player"],
    setup(api) {
      api.contribute(SLOT_RESOURCES, [INVENTORY_WIDGETS]);
      // THE HOTBAR STRIP, as this plugin's HUD element (P1.35). `order: 20` puts it after the core's crosshair
      // (10), and the gate is only "a world is running": that this plugin is INSTALLED is expressed by the
      // element existing at all, which is the difference between hiding a strip and owning one.
      const hotbar: UiHudElement = {
        id: "hotbar",
        order: 20,
        build: (mount) => [s.inv.buildHotbar(mount.world)],
        gate: () => s.inWorld(),
      };
      api.contribute(SLOT_UI_HUD, [hotbar]);
      declareUiInventorySystems(api, s);
    },
    // A hot uninstall must not leave a bag that can still be opened and never painted again: close it. The
    // HOTBAR needs nothing here — the element left the table with this plugin, so `ui.hud` despawns its
    // widgets at the next barrier (that is the whole point of contributing it).
    stop(api) {
      api.world.resource(UI_MODAL).inventory = false;
    },
  });
}
