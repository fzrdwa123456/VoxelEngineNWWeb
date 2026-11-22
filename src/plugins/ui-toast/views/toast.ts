// ===== The toast's WIDGETS: a top-level panel and its text =====
// Tiny on purpose, and TOP-LEVEL (parented to the UI root, i.e. `null`): that is exactly why this surface
// can be hot-plugged in BOTH directions while the key bind page cannot — its widgets need no mount inside a
// layout somebody else owns. Spawned by the composition root during wiring, because spawning is a structural
// change (iron rule 1); `ui.toast` only ever writes their data.
import type { Entity, World } from "../../../core/world";
import { spawnLabel, spawnPanel } from "../../ui/components";

export function spawnToastPanel(world: World): { panel: Entity; body: Entity } {
  const panel = spawnPanel(world, null, "hud.toast", { hidden: true });
  const body = spawnLabel(world, panel, "text.label");
  return { panel, body };
}
