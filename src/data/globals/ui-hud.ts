// ===== HUD ELEMENTS: the gameplay HUD as DATA (P1.32) — MOUNTED BY ITS HOST (P1.34) =====
// The crosshair and the hotbar used to be two hard-coded widgets gated by ONE predicate in one system — which
// is how switching the inventory layer off took the crosshair with it. An element is now a value:
//
//   * `build`   — how it is CREATED (at a barrier: a system may not spawn, iron rule 1);
//   * `roots`   — or, for an element whose view spawned it during wiring, the widgets it is made of;
//   * `dispose` — what to undo when it goes away (a registered spec/action, a cached paint, a listener);
//   * `gate`    — ITS OWN reason to be visible (`() => inWorld()`, `() => inWorld() && inventoryOn(), ...).
//
// WHO OWNS THE WIDGETS: the HOST (`ui.hud`), not the view that knows what they mean. An element that appears
// while the game runs (a plugin installed with F11) is BUILT within a frame, and one whose contribution
// disappears is disposed of and DESPAWNED — the whole subtree, because the ECS has no cascade. The view
// supplies the two things only it can know: how to spawn its widgets, and what "gone" means for it. That is
// what makes the HUD dynamic instead of a burst of spawn calls during wiring.
//
// A plugin can therefore add a HUD element (armor, xp, boss bar, subtitles) by contributing to `SLOT_UI_HUD`
// with its own gate AND its own build — no change to the ui plugin, and no shared predicate to get wrong.
import { defineResource } from "../../core/data/resource";
import type { Entity, World } from "../../core/world";

/** What a `build` is handed: the BARRIER's world (spawning is legal exactly there) and the plugin log. */
export interface UiHudMount {
  /** The world to spawn into — never a captured one: the barrier decides WHEN, and it hands its own world. */
  readonly world: World;
  /** Where a build that fails says so. The host logs it once and does not retry every frame. */
  log(line: string): void;
}

export interface UiHudElement {
  /** Stable id (`crosshair`, `hotbar`, ...). Also the key the host remembers what it mounted. */
  readonly id: string;
  /** Draw order among elements (lower first); the host sorts by it for determinism. */
  readonly order: number;
  /** Create the widgets and return their ROOTS (everything below them is despawned with them). Called at a
   *  barrier, at most once per mount — and again after a re-install. Omit it when `roots` are pre-spawned. */
  build?(mount: UiHudMount): readonly Entity[];
  /** The widgets it is made of, for an element whose view spawned them at wiring time. The STATIC form of
   *  `build`: the host adopts them and only ever writes their visibility. */
  readonly roots?: readonly Entity[];
  /** Undo what `build` did (a registered action or spec, a cached paint, a listener). Runs at a barrier,
   *  before the widgets are despawned. Optional: a widget tree with no other state needs nothing. */
  dispose?(): void;
  /** Why it is visible NOW. Its own predicate — never borrowed from a neighbour. */
  readonly gate: () => boolean;
}

/** What the host mounted last frame, by element id. It keeps the ELEMENT as well as its roots, because by the
 *  time an element goes away its `dispose` still has to run. This is how the host notices that an element's
 *  contribution disappeared (its plugin was uninstalled) and takes its widgets down ONCE, instead of leaving
 *  them on screen with nobody to update them. */
export interface HudPainted {
  readonly element: UiHudElement;
  readonly roots: readonly Entity[];
}

export const UI_HUD_PAINTED = defineResource<Map<string, HudPainted>>("uiHudPainted");
