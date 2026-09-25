// ===== HUD ELEMENTS: the gameplay HUD as DATA (P1.32) =====
// The crosshair and the hotbar used to be two hard-coded widgets gated by ONE predicate in one system — which
// is how switching the inventory layer off took the crosshair with it. An element is now a value:
//
//   * `roots` — the widgets it is made of (the contributing view spawns them; the host only shows/hides);
//   * `gate`  — ITS OWN reason to be visible (`() => inWorld()`, `() => inWorld() && inventoryOn()`, ...).
//
// A plugin can therefore add a HUD element (armor, xp, boss bar, subtitles) by contributing to `SLOT_UI_HUD`
// and spawning its own widgets — no change to the ui plugin, and no shared predicate to get wrong.
import { defineResource } from "../../core/data/resource";
import type { Entity } from "../../core/world";

export interface UiHudElement {
  /** Stable id (`crosshair`, `hotbar`, ...). Also the key the host remembers what it painted. */
  readonly id: string;
  /** Draw order among elements (lower first); the host sorts by it for determinism. */
  readonly order: number;
  /** The widgets this element is made of. Spawned by the view that owns them, never by the host. */
  readonly roots: readonly Entity[];
  /** Why it is visible NOW. Its own predicate — never borrowed from a neighbour. */
  readonly gate: () => boolean;
}

/** What the host painted last frame, by element id: how it notices an element that WENT AWAY (its plugin was
 *  uninstalled) and hides its widgets once, instead of leaving them on screen with nobody to update them. */
export const UI_HUD_PAINTED = defineResource<Map<string, readonly Entity[]>>("uiHudPainted");
