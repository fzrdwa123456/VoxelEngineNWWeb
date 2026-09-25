// ===== Plugin: ui-backpack =====
// The INVENTORY layer: the backpack panel, the hotbar it shares its data with, and the system that reconciles
// both from the INVENTORY component (and bakes block icons through the injected render hooks). It left the ui
// plugin in P1.31, so "no inventory layer" is a manifest line.
//
// WHY BOTH TREES MOVED TOGETHER: the backpack and the hotbar render from the SAME data (one INVENTORY record,
// one INVENTORY_WIDGETS handle set) through one reconcile pass, and the crosshair — the other half of the
// gameplay HUD — stays in `ui.hud` with the gate that hides them outside a world. Splitting the hotbar from the
// backpack would have meant two reconcilers reading one component, i.e. the drift that pattern exists to avoid.
//
// IT NEEDS NO MOUNT: the bag panel is a TOP-LEVEL widget (like the toast), so it hot-plugs in BOTH directions —
// installed from off while the game runs, and uninstalled without leaving a surface behind (`stop` closes the
// bag, so nothing stays reachable-but-unpainted).
import { SLOT_RESOURCES } from "../../core/extension/slots";
import { definePlugin } from "../../core/plugin/descriptor";
import type { Plugin } from "../../core/plugin/descriptor";
import type { PluginApi } from "../../core/plugin/api";
import type { Entity, World } from "../../core/world";
import { UI_MODAL, INVENTORY_WIDGETS } from "../../data/globals/resources";
import { INVENTORY_VIEW_ACCESS, UiInventorySystem } from "./systems/inventory";
import { Inventory } from "./views/inventory";

/** The backpack/hotbar widgets, built during wiring (spawning is a structural change). */
export function createInventoryView(world: World, player: Entity): Inventory {
  return new Inventory(world, player);
}

export function createInventorySystem(
  ...args: ConstructorParameters<typeof UiInventorySystem>
): UiInventorySystem {
  return new UiInventorySystem(...args);
}

export interface UiBackpackSystems {
  readonly uiInventory: { step(): void };
}

export function declareUiBackpackSystems(api: PluginApi, s: UiBackpackSystems): void {
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

export function createUiBackpackPlugin(s: UiBackpackSystems): Plugin {
  return definePlugin({
    id: "ui-backpack",
    // The widget layer it renders into, and the player's INVENTORY component.
    deps: ["ui", "player"],
    setup(api) {
      api.contribute(SLOT_RESOURCES, [INVENTORY_WIDGETS]);
      declareUiBackpackSystems(api, s);
    },
    // A hot uninstall must not leave a bag that can still be opened and never painted again: close it.
    stop(api) {
      api.world.resource(UI_MODAL).inventory = false;
    },
  });
}
