// ===== ui.picker: the F3+F4 game-mode picker, as DATA + a system =====
// It used to be ui/gamemode.ts: a class that registered its own document keydown/keyup listeners and
// kept `f3Down`/`f4Down`/`menuOpen`/`sel` in private fields. Three things were wrong with that shape, and
// they are the reason this file exists:
//   1. it LISTENED TO THE DOM. Only the device layer (ecs/systems/input.ts) may do that; a second
//      listener on the same keys is a second owner of the same event, and the F3 debug toggle and the
//      F4 cycle were invisible to everything else in the process.
//   2. its state was private, so "is the picker open" had no answer outside the object.
//   3. the mode it edits IS component data (CONTROL.mode), and it reached it through a {mode, setMode}
//      adapter object the composition root built — a closure in the middle of a data path.
// Now: the device layer publishes key EDGES (KEY_EVENTS), this system consumes them, the picker's state
// is the PICKER_STATE resource, and the mode change is the SetMode COMMAND like every other UI write.
//
// WHY THE ui LANE AND NOT fixed: it writes WIDGET data (the picker panel, the F3 panel's visibility),
// and the ui lane is where widget data is written. It used to be argued from the opposite side — "F3/F4
// work at the MAIN MENU too" — which was a bug, not a feature: the F3 panel and the mode chord belong to
// a world. They are gated on `inWorld()` now (see step()), so outside a world this system consumes the
// edges and does nothing; the debug panel's TEXT comes from the render lane, which does not run in the
// menu either, so an F3 panel opened there would have shown stale numbers anyway.
import { MODE_NAMES, type MoveMode } from "../../player/components";
import { KEY_EVENTS, KeyEdgeReader, PICKER_STATE, type PickerState } from "../../../data/globals/resources";
import type { Entity, SystemAccess, World } from "../../../core/world";
import { UI_STATE, spawnLabel, spawnPanel, setUiSelected, setUiVisible } from "../../ui/components";

/** Declared access: it writes the picker panel's own widget data and the F3 debug panel's visibility,
 *  and reads that panel's state to toggle it. The key log, the picker state and the player's mode reach
 *  it through its dependencies — resources are not modelled by the schedule, and the mode read/write is
 *  injected so this system stays a UI system (it writes widget data, like ui.inventory and ui.keybind,
 *  and the gate can drive its chord logic without a player entity). */
export const UI_PICKER_ACCESS: SystemAccess = {
  reads: [UI_STATE],
  writes: [UI_STATE],
  writesExternal: ["debugLog"],
};

/** The modes the picker cycles through, in order. */
export const PICKER_MODES = ["walk", "fly", "spectator"] as const;

/** The picker panel + its rows: a WIRING helper (spawn is a structural change — never inside a
 *  system). Called from main.ts, exactly like the Hud's own widget tree. */
export function spawnPickerPanel(world: World): { panel: Entity; items: Entity[] } {
  const panel = spawnPanel(world, null, "picker.panel", { hidden: true });
  spawnLabel(world, panel, "picker.title", "gamemode.title");
  const row = spawnPanel(world, panel, "picker.row");
  // The text is the i18n key, not the translated string: nothing here reacts to a language change,
  // because the reconciler re-resolves the key every frame.
  const items = PICKER_MODES.map((mode) => spawnLabel(world, row, "picker.item", `mode.${mode}`));
  return { panel, items };
}

export interface PickerDeps {
  /** The picker's own panel and its mode rows */
  readonly panel: Entity;
  readonly items: readonly Entity[];
  /** The F3 debug panel, so F3 alone still toggles it (see step()) */
  readonly debugPanel: Entity;
  /** The mode in force, and how to change it. Injected: reading CONTROL and sending the SetMode command
   *  is the composition root's job, and it keeps this system to widget data. */
  readonly readMode: () => MoveMode;
  readonly applyMode: (mode: MoveMode) => void;
  /** Is a world RUNNING? The F3 panel and the mode chord are GAMEPLAY UI: outside a world (`inWorld()`
   *  false — the main menu, and the loading screen while a world is built) neither may fire, and the
   *  panels come down. Injected, so this system keeps the one definition the composition root owns. */
  readonly inWorld: () => boolean;
  readonly log: (line: string) => void;
}

export class UiPickerSystem {
  private readonly state: PickerState;
  private readonly panel: Entity;
  private readonly items: readonly Entity[];
  /** Its own cursor into the shared edge log (ui.navigation reads the same edges) */
  private readonly reader: KeyEdgeReader;
  /** What the last frame did about it, so the panels are only touched when the answer changes. The value
   *  is `PICKER_STATE.outsideWorld` (its own resource), i.e. data with an owner. */
  private get outsideWorld(): boolean {
    return this.state.outsideWorld;
  }
  private set outsideWorld(v: boolean) {
    this.state.outsideWorld = v;
  }

  constructor(
    private readonly world: World,
    private readonly deps: PickerDeps,
  ) {
    this.state = world.resource(PICKER_STATE);
    this.panel = deps.panel;
    this.items = deps.items;
    this.reader = new KeyEdgeReader(world.resource(KEY_EVENTS));
  }

  /** ui lane. Reads the key edges published since the last frame and runs the chord:
   *  F3+F4 (either order) opens the picker, F4 cycles while it is open, F3 release applies the
   *  selection. Auto-repeat is ignored — a held F3 is one press. Its own CURSOR into the log, because
   *  ui.navigation reads the same edges (ESC, the inventory key).
   *
   *  Outside a world nothing here fires: the edges are still DRAINED (that is what the reader does, and
   *  ui.navigation's own cursor is unaffected), so a key pressed at the main menu is not replayed when a
   *  world starts — it is simply not acted on. */
  step(): void {
    const inWorld = this.deps.inWorld();
    if (!inWorld) {
      // A game session's panels must not outlive it: going back to the main menu with the F3 panel or
      // the picker open used to leave them on screen (with stale text, or over the menu). The chord
      // state is cleared with them, so a world starts from "nothing held".
      if (!this.outsideWorld) {
        this.outsideWorld = true;
        this.state.open = false;
        this.state.f3 = false;
        this.state.f4 = false;
        setUiVisible(this.world, this.panel, false);
        setUiVisible(this.world, this.deps.debugPanel, false);
      }
      this.reader.drain(() => {}); // consume: the edges are the world's, not a menu's
      return;
    }
    this.outsideWorld = false;
    this.reader.drain((edge) => {
      if (edge.repeat) return;
      if (edge.code === "F3") {
        this.state.f3 = edge.down;
        if (edge.down) {
          if (this.state.f4) this.open();
          else this.toggleDebug();
        } else if (this.state.open) {
          this.apply();
        }
      } else if (edge.code === "F4") {
        this.state.f4 = edge.down;
        if (edge.down) {
          if (this.state.open) this.cycle();
          else if (this.state.f3) this.open();
        }
      }
    });
  }

  /** F3 alone: the debug panel's widget data IS the "shown" state — there is no second copy of it
   *  anywhere any more (ui/hud.ts used to keep a `debugVisible` boolean next to this same fact). */
  private toggleDebug(): void {
    const state = this.world.get(this.deps.debugPanel, UI_STATE);
    if (!state) return;
    const wantVisible = state.hidden; // currently hidden -> we are about to show it
    setUiVisible(this.world, this.deps.debugPanel, wantVisible);
    this.deps.log(`DEBUG panel ${wantVisible ? "shown" : "hidden"}`);
  }

  /** The UNINSTALL path (P1.24): hide everything this system owns and clear its state.
   *
   *  A plugin that can be hot-unplugged must not leave a panel on screen — there would be no system left to
   *  close it, and F3/F4 would be dead keys with a stale debug panel stuck in the corner. `close()` is what
   *  the plugin's `stop` hook calls, i.e. this is the one method whose caller is the LIFECYCLE rather than
   *  the lane. */
  close(): void {
    this.state.open = false;
    this.state.f3 = false;
    setUiVisible(this.world, this.panel, false);
    setUiVisible(this.world, this.deps.debugPanel, false);
    this.deps.log("PICKER closed - the plugin was uninstalled");
  }

  private open(): void {
    const mode = this.deps.readMode();
    this.state.sel = Math.max(0, PICKER_MODES.indexOf(mode as (typeof PICKER_MODES)[number]));
    this.state.open = true;
    setUiVisible(this.world, this.panel, true);
    this.render();
    this.deps.log(`PICKER open mode=${mode}`);
  }

  private cycle(): void {
    this.state.sel = (this.state.sel + 1) % PICKER_MODES.length;
    this.render();
    this.deps.log(`PICKER cycle -> ${PICKER_MODES[this.state.sel]}`);
  }

  private render(): void {
    this.items.forEach((item, i) => setUiSelected(this.world, item, i === this.state.sel));
  }

  private apply(): void {
    this.state.open = false;
    setUiVisible(this.world, this.panel, false);
    const mode = PICKER_MODES[this.state.sel];
    if (mode === this.deps.readMode()) return;
    this.deps.applyMode(mode); // a COMMAND in main.ts: the mode is component data (see ecs/commands.ts)
    this.deps.log(`MODE switch -> ${mode} (${MODE_NAMES[mode]})`);
  }
}
