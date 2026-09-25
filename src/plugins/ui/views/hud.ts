// ===== HUD: the crosshair, the F3 debug panel, and the widget trees the host mounts =====
// These are WIDGETS now, not DOM: this class SPAWNS widget trees and afterwards only writes component data
// (text, visibility). The elements belong to the ui reconciler, so there is no createElement, no style string
// and no CSS literal left in this file.
//
// WHAT THIS VIEW OWNS vs WHAT THE HOST OWNS (P1.34): the view knows how to BUILD a widget tree — that is local
// knowledge — and `ui.hud` owns the LIFETIME of the ones that are HUD ELEMENTS. The crosshair is the worked
// example: it used to be spawned here, during wiring, and its root was published for the host to hide; now the
// host calls `buildCrosshair` when the element is mounted and despawns the same tree when it goes away, so an
// element that appears at runtime (a plugin's armor bar) and one the core owns are mounted by ONE mechanism.
//
// What is NOT here any more, and where it went: the F3 toggle and its `debugVisible` boolean (the
// panel's own UI_STATE.hidden is the state, and ecs/ui/picker.ts toggles it), `showToast()` with its
// `setTimeout` (the message and its wall-clock deadline are the TOAST resource, armed by the ShowToast
// command and driven by ecs/ui/toast.ts), and `updateDebug()` (the F3 TEXT is written by
// ecs/systems/diagnostics.ts now, from the panel's two widget handles — the `F3_PANEL` resource — so a
// render-lane system no longer calls into a view). All three were "how long / whether / what does it
// say" questions owned by a view.
//
// Note what disappeared with the DOM: `onLangChange(refresh)` — the reconciler re-derives every label
// from its i18n key once per frame, so a language switch needs no subscription anywhere.
import type { Entity, World } from "../../../core/world";
import { spawnLabel, spawnPanel } from "../components";

export class Hud {
  private readonly debugPanel: Entity;
  private readonly debugBody: Entity;

  /** The F3 panel, for ecs/ui/picker.ts (F3 alone toggles it; its UI_STATE IS the shown/hidden state) */
  get debugPanelEntity(): Entity {
    return this.debugPanel;
  }

  constructor(private readonly world: World) {
    // F3 debug panel: hidden until toggled, one preformatted text block inside it. NOT a HUD element: it is a
    // game SESSION's panel (F3 was pressed in a world) and `ui.picker` owns when it shows, so it is not in the
    // element table and the host never touches it.
    this.debugPanel = spawnPanel(world, null, "debug.panel", { hidden: true });
    this.debugBody = spawnLabel(world, this.debugPanel, "debug.line");

  }

  /** THE CROSSHAIR: a centred box with two bars in it (the box centres them for us), built by `ui.hud` when
   *  the element is MOUNTED and despawned with it. Spawned HIDDEN and never left that way: the host writes the
   *  element's gate in the same frame (the mount is a barrier command, and the barrier a frame runs before its
   *  ui lane), so no frame ever paints it in the wrong state — but a widget that is up for one frame is a
   *  visible flash, and a hidden default cannot leak one. */
  buildCrosshair(world: World): Entity {
    const crosshair = spawnPanel(world, null, "hud.crosshair", { hidden: true });
    spawnPanel(world, crosshair, "hud.crosshairH");
    spawnPanel(world, crosshair, "hud.crosshairV");
    return crosshair;
  }

  /** The F3 panel and its text line, for the composition root to publish as the F3_PANEL resource
   *  (diagnostics writes the text; the panel's UI_STATE.hidden is read there too). */
  get debugPanelEntities(): { panel: Entity; body: Entity } {
    return { panel: this.debugPanel, body: this.debugBody };
  }
}
