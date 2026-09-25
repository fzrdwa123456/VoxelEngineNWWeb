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
import { UI_HUD_PAINTED, type UiHudElement } from "../../../data/globals/ui-hud";
import { UI_STATE, setUiVisible } from "../components";

/** It writes the two HUD roots' visibility and nothing else. */
export const UI_HUD_ACCESS: SystemAccess = {
  writes: [UI_STATE],
};

export interface HudDeps {
  /** Every HUD element in force right now: the ones plugins contributed (`SLOT_UI_HUD`) plus the core's own,
   *  late-bound through the root's registry getter. Each carries ITS OWN gate — that is the whole point. */
  readonly elements: () => readonly UiHudElement[];
}

export class UiHudSystem {
  /** What this host painted last frame, by element id (world data — see UI_HUD_PAINTED). */
  private readonly painted: Map<string, readonly Entity[]>;

  constructor(
    private readonly world: World,
    private readonly deps: HudDeps,
  ) {
    this.painted = world.resource(UI_HUD_PAINTED);
  }

  /** ui lane, once per frame: paint every element from its own gate, and take down whatever went away.
   *
   *  Two loops, in this order, and the second one is the load-bearing half: an element whose contribution
   *  DISAPPEARED (its plugin was uninstalled) is no longer in the table, so nothing would ever write its
   *  widgets' visibility again — they would stay on screen, frozen. The host remembers what it painted
   *  (`UI_HUD_PAINTED`, world data) and hides those once. This is the same residue trap the rubber band and
   *  the toast taught us, solved once for every HUD element. */
  step(): void {
    const live = [...this.deps.elements()].sort((a, b) => a.order - b.order);
    const present = new Set(live.map((el) => el.id));
    for (const [id, roots] of [...this.painted]) {
      if (present.has(id)) continue;
      for (const root of roots) setUiVisible(this.world, root, false);
      this.painted.delete(id);
    }
    for (const el of live) {
      for (const root of el.roots) setUiVisible(this.world, root, el.gate());
      this.painted.set(el.id, el.roots);
    }
  }
}
