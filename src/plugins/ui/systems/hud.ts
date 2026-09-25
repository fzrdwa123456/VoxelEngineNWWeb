// ===== ui.hud: the GAMEPLAY widgets are visible only while a world is running =====
// The crosshair and the hotbar were spawned VISIBLE during wiring and no system ever wrote their
// visibility, so they were up in EVERY mode — the main menu, the pause menu (where the hotbar even
// draws ABOVE that menu's root: z-index 31 against 30) and behind the loading screen. The hotbar's
// slots were clickable there too, i.e. a menu click could change the selected slot. The old code had no
// notion of "these belong to a world": the only gate in the engine was `canControl()`, and that says
// what the MOUSE does, not which UI is on screen.
//
// WHY A SEPARATE SYSTEM: the answer is one predicate (`inWorld()`: the loop mode is `game`) applied to
// two widgets, and it belongs next to the widgets it gates rather than inside the inventory view (which
// is about the bag's CONTENT) or inside ui.picker (which owns the F3 panel and the mode chord). It
// lives in the ui lane because it writes widget data, and it is the FIRST system of that lane: it is a
// gate on what the rest of the lane may show.
//
// It does NOT own the F3 panel or the picker panel: those are a game SESSION's UI (F3 was pressed in a
// world), and `ui.picker` hides them itself when it sees that no world is running. And it deliberately
// does not touch the toast: a main-menu message is a documented case (the multiplayer placeholder is
// drawn by the menu frame), so "gameplay UI" here means the HUD that mirrors a running world.
import type { Entity, SystemAccess, World } from "../../../core/world";
import { UI_PAINT, type UiHudPaint } from "../../../data/globals/paint";
import { UI_STATE, setUiVisible } from "../components";

/** It writes the two HUD roots' visibility and nothing else. */
export const UI_HUD_ACCESS: SystemAccess = {
  writes: [UI_STATE],
};

export interface HudDeps {
  /** The crosshair root (ui/hud.ts) */
  readonly crosshair: Entity;
  /** The hotbar strip (ui/inventory.ts) */
  readonly hotbar: Entity;
  /** Is a world RUNNING? (the loop mode is `game`) — injected, so this module stays DOM-free and the
   *  composition root keeps the one definition of "playing" (`inWorld()`), exactly like ui.navigation. */
  readonly inWorld: () => boolean;
  /** Is the INVENTORY layer installed (the `ui-backpack` plugin)? The crosshair is the gameplay HUD and
   *  stays; the hotbar IS that layer's other half (it renders from the same data through the same system),
   *  so switching that plugin off has to take it down — otherwise it stays on screen, frozen. Injected from
   *  the root, which is the only place that knows what is installed right now. */
  readonly inventoryOn: () => boolean;
}

export class UiHudSystem {
  /** Both widgets are spawned VISIBLE, so that is the state the first frame starts from. The VALUE lives
   *  in UI_PAINT.hud (ecs/ui/paint.ts::createUiPaint initialises it to true, matching the spawn). */
  private readonly paint: UiHudPaint;

  private get shown(): boolean {
    return this.paint.shown;
  }
  private set shown(v: boolean) {
    this.paint.shown = v;
  }

  constructor(
    private readonly world: World,
    private readonly deps: HudDeps,
  ) {
    this.paint = world.resource(UI_PAINT).hud;
  }

  /** ui lane, once per frame. A hide/show only when the answer CHANGES: the record is data the
   *  reconciler diffes, but writing it every frame would be noise (and `setUiVisible` is write-only,
   *  so it could not even notice). */
  step(): void {
    const visible = this.deps.inWorld() && this.deps.inventoryOn();
    if (visible === this.shown) return;
    this.shown = visible;
    setUiVisible(this.world, this.deps.crosshair, visible);
    setUiVisible(this.world, this.deps.hotbar, visible);
  }
}
