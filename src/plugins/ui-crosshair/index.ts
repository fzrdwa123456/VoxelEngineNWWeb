// ===== Plugin: ui-crosshair =====
// The aiming reticle, as an OPTIONAL, HOT-PLUGGABLE surface (P1.48): F5 installs and uninstalls it while the
// game runs. It is the smallest possible HUD plugin, and it is the proof of the element mechanism: it owns no
// resource, declares no system, and needs nothing from the host but "is a world running" — it contributes ONE
// HUD ELEMENT (`SLOT_UI_HUD`) whose `build` spawns the widget tree, and `ui.hud` mounts it on install and
// despawns the whole subtree on uninstall, so "off" leaves nothing behind.
//
// WHY IT IS ITS OWN PLUGIN rather than a row in the core's table: the crosshair is gameplay UI a player may
// want gone (a screenshot, a HUD-less view), and the element table is exactly the mechanism for that. With
// this, the core contributes NO HUD element of its own any more — the table is entirely plugin-contributed.
import { SLOT_UI_HUD } from "../../core/extension/slots";
import { definePlugin } from "../../core/plugin/descriptor";
import type { Plugin } from "../../core/plugin/descriptor";
import type { UiHudElement } from "../../data/globals/ui-hud";
import { spawnCrosshair } from "./views/crosshair";

export interface UiCrosshairDeps {
  /** "Is a world running?" — the element's OWN gate. A HUD element is MOUNTED in every mode and only made
   *  VISIBLE in a world, so this is the whole of its visibility logic. */
  readonly inWorld: () => boolean;
}

export function createUiCrosshairPlugin(deps: UiCrosshairDeps): Plugin {
  return definePlugin({
    id: "ui-crosshair",
    // It spawns widgets, so it needs the widget layer. `player` is deliberately NOT a dependency: nothing here
    // reads the player, and a surface that only needs the widget layer must not drag the world in.
    deps: ["ui"],
    setup(api) {
      // `order: 10` keeps it before the hotbar (20), the order the lane used while both were the core's. The
      // gate travels WITH the element, so toggling another surface can never change this one's visibility.
      const crosshair: UiHudElement = {
        id: "crosshair",
        order: 10,
        build: (mount) => [spawnCrosshair(mount.world)],
        gate: () => deps.inWorld(),
      };
      api.contribute(SLOT_UI_HUD, [crosshair]);
    },
  });
}
