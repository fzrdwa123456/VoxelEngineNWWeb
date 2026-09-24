// ===== HUD: crosshair + hotbar-adjacent gameplay widgets + the F3 debug panel =====
// These are WIDGETS now, not DOM: this class spawns four widget trees during wiring and afterwards only
// writes component data (text, visibility). The elements belong to ecs/ui/system.ts, so there is no
// createElement, no style string and no CSS literal left in this file.
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
  private readonly crosshair: Entity;
  private readonly debugPanel: Entity;
  private readonly debugBody: Entity;

  /** The F3 panel, for ecs/ui/picker.ts (F3 alone toggles it; its UI_STATE IS the shown/hidden state) */
  get debugPanelEntity(): Entity {
    return this.debugPanel;
  }
  /** The crosshair root, for `ui.hud` — the system that hides the GAMEPLAY widgets while no world is
   *  running. It is spawned VISIBLE, like the hotbar, and nothing else writes its visibility. */
  get crosshairEntity(): Entity {
    return this.crosshair;
  }

  constructor(private readonly world: World) {
    // Crosshair: a centred box with two bars in it (the box centres them for us)
    const crosshair = spawnPanel(world, null, "hud.crosshair");
    this.crosshair = crosshair;
    spawnPanel(world, crosshair, "hud.crosshairH");
    spawnPanel(world, crosshair, "hud.crosshairV");

    // F3 debug panel: hidden until toggled, one preformatted text block inside it
    this.debugPanel = spawnPanel(world, null, "debug.panel", { hidden: true });
    this.debugBody = spawnLabel(world, this.debugPanel, "debug.line");

  }

  /** The F3 panel and its text line, for the composition root to publish as the F3_PANEL resource
   *  (diagnostics writes the text; the panel's UI_STATE.hidden is read there too). */
  get debugPanelEntities(): { panel: Entity; body: Entity } {
    return { panel: this.debugPanel, body: this.debugBody };
  }
}
