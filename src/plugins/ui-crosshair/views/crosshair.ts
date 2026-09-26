// ===== The CROSSHAIR: a centred box with two bars in it (P1.48) =====
// Moved out of the ui plugin's hud view when the crosshair became a PLUGIN of its own. The three panels are
// the same widgets and the theme still owns their look (`hud.crosshair`, `hud.crosshairH`, `hud.crosshairV`,
// data/assets/theme.ts) — what changed is WHO owns their lifetime: `ui.hud` mounts this tree when the element
// is mounted and despawns it when the element goes away, so turning the surface off leaves nothing behind.
//
// Spawned HIDDEN and never left that way: the host writes the element's gate in the same frame (a mount is a
// barrier command, and the barrier runs before that frame's ui lane), and a widget that is up for one frame is
// a visible flash — a hidden default cannot leak one.
import type { Entity, World } from "../../../core/world";
import { spawnPanel } from "../../ui/components";

export function spawnCrosshair(world: World): Entity {
  const crosshair = spawnPanel(world, null, "hud.crosshair", { hidden: true });
  spawnPanel(world, crosshair, "hud.crosshairH");
  spawnPanel(world, crosshair, "hud.crosshairV");
  return crosshair;
}
