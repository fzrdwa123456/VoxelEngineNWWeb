// ===== ui.keybind: the bind panels (derived) + the queued rebind decisions =====
// The DATA is `data/globals/keybind-gesture.ts` (the gesture resource, the queued device decisions and
// the panel registry); this is the behaviour. It writes widget data for the bind panels, the hover
// highlight during a drag and the rubber band's geometry, and it READS the bind table (the KEYMAP
// resource, through the injected `boundCodes`/`bindOf`) and the POINTER resource (the device layer's
// last known position) to derive them.
//
// WHY THE PANELS ARE DERIVED EVERY FRAME: `renderAllPanels()` was an imperative call every code path had
// to remember, and it is how the visible panel could stay stuck while a refresh hit the hidden one. Two
// panels showing ONE bind table cannot desync if both are re-derived from it.
//
// WHY THE BINDS ARE APPLIED HERE: the device listeners in logic/host/input/bind-gesture.ts take every
// decision at event time (which key, which button, whether a drop landed on a keycap) and publish it as
// a RebindIntent; writing the bind table is this lane's job, so the event half holds no policy and the
// capture state (KEYBIND_GESTURE.capturing) is read where it is applied.
import type { BindAction } from "../../../data/globals/binds";
import { POINTER, UI_MODAL } from "../../../data/globals/resources";
import { KEYBIND_GESTURE, keybindPanels } from "../../../data/globals/keybind-gesture";
import type { Entity, SystemAccess, World } from "../../../core/world";
import { UI_PAINT, type UiKeybindPaint } from "../../../data/globals/paint";
import { UI_LAYOUT, UI_STATE, UI_TEXT, setUiActive, setUiLayout, setUiSelected, setUiText, setUiVisible } from "../../ui/components";

export interface KeybindDeps {
  /** The bind table (logic/host/input/keybinds.ts owns it — injected so this layer never imports it) */
  readonly boundCodes: () => Set<string>;
  /** The action being captured right now, or null */
  readonly capturing: () => BindAction | null;
  /** Read the current code for an action ("" = unbound) */
  readonly bindOf: (action: BindAction) => string;
  /** Write a bind — the system applies the QUEUED decisions, so this is injected like the reads. */
  readonly setBind: (action: BindAction, code: string) => void;
  /** End the capture after a queued bind has been applied. */
  readonly endCapture: () => void;
  /** One line per applied bind (`KBCAP bind done (code=…)`), so the P1.13 diagnostic survives the move
   *  of the bind out of the event listener. */
  readonly log: (line: string) => void;
  /** The rubber band WIDGET (spawned by the composition root from the settings panel's prefab): the
   *  SYSTEM writes its geometry as data (UI_LAYOUT) and the reconciler paints it. It replaced an SVG
   *  element the view owned and mutated on every mousemove. */
  readonly line: Entity;
  /** The keycap under a point, or null (the settings panel owns the hit test and the keycap action id) */
  readonly keycapAt: (x: number, y: number) => Entity | null;
  /** The "key binds" ENTRY buttons, one per settings panel (the pause menu and the main menu each build
   *  one). They are spawned HIDDEN and it is THIS system that shows them: the plugin that owns the page
   *  owns the way IN to it, so a build without the plugin has no entry point rather than a dead one. */
  readonly entries: readonly Entity[];
}

/** Declared access: widget data for the panels, the drag highlight and the rubber band. */
export const UI_KEYBIND_ACCESS: SystemAccess = {
  reads: [UI_STATE, UI_TEXT],
  writes: [UI_STATE, UI_TEXT, UI_LAYOUT],
  readsExternal: ["keybinds"],
};

export class UiKeybindSystem {
  /** Last text written per widget, so the 100+ keycap legends are not rewritten every frame (the
   *  reconciler would diff them away anyway, but this keeps the ui lane cheap). The DATA is
   *  UI_PAINT.keybind (data/globals/paint.ts): the caches are world state, this is their only writer. */
  private readonly paint: UiKeybindPaint;
  private get drawn(): Map<Entity, string> {
    return this.paint.drawn;
  }
  private get hovered(): Entity | null {
    return this.paint.hovered;
  }
  private set hovered(v: Entity | null) {
    this.paint.hovered = v;
  }
  private get lineShown(): boolean {
    return this.paint.lineShown;
  }
  private set lineShown(v: boolean) {
    this.paint.lineShown = v;
  }

  constructor(
    private readonly world: World,
    private readonly deps: KeybindDeps,
  ) {
    this.paint = world.resource(UI_PAINT).keybind;
  }

  /** The way IN to the page: one button per settings panel, spawned hidden by the view. It is written on
   *  every frame (the reconciler diffs it), because the ONLY question it answers is "is this plugin
   *  installed" — and after a hot uninstall nobody would be left to answer it.
   *
   *  IT IS CALLED FROM step(), NEVER FROM THE CONSTRUCTOR, and that is load-bearing: the composition root
   *  fills `deps.entries` only once BOTH menus exist (their views spawn the buttons while they build the
   *  settings panel), while this system is constructed earlier. Showing them once from the constructor was a
   *  no-op over an empty array, and the binding page then had NO way in — from either menu. */
  private showEntries(): void {
    for (const entry of this.deps.entries) setUiVisible(this.world, entry, true);
  }

  /** The UNINSTALL path (P1.24): the way in goes away with the page, a page that is OPEN steps back to the
   *  settings list, and the DRAG's residue is taken down — see the note below, this shipped broken. */
  close(): void {
    for (const entry of this.deps.entries) setUiVisible(this.world, entry, false);
    const ui = this.world.resource(UI_MODAL);
    if (ui.settings === "keybind") ui.settings = "settings";
    // THE BAND IS THE SYSTEM'S TO HIDE, and that is exactly why an uninstall leaked it: its geometry AND its
    // visibility are written by step() every frame (they are derived from the GESTURE resource + POINTER), so
    // the moment this system leaves the schedule nothing re-derives them — F9 during a drag left the rubber
    // band frozen on screen and the gesture still live, so a re-install resumed drawing it. ESC gets away with
    // clearing only the gesture state because the system runs ONE MORE FRAME and hides the band then; an
    // uninstall has no such frame, so the take-down is explicit here.
    //
    // What is NOT taken down here (and cannot be): the document listeners `bindKeybindDrag` installed —
    // plugins/input/bind-gesture.ts registers them once and returns no disposer. They are inert after this (a
    // hidden panel cannot be hit, `drag` is null, the capture is over), but a plugin that can be installed and
    // uninstalled repeatedly should hand back a disposer; recorded in ROADMAP P1.26.
    const gesture = this.world.resource(KEYBIND_GESTURE);
    gesture.drag = null;
    gesture.hover = null;
    gesture.shield = false;
    this.deps.endCapture();
    if (this.hovered !== null) {
      setUiSelected(this.world, this.hovered, false);
      this.hovered = null;
    }
    setUiVisible(this.world, this.deps.line, false);
    this.lineShown = false;
    this.deps.log("KEYBIND page closed - the plugin was uninstalled");
  }

  /** ui lane, once per frame: derive every panel's text/state from the bind table, then apply the
   *  gesture's presentation (the hover highlight and the rubber band). */
  step(): void {
    // The way IN first: these buttons are spawned hidden, and this system is the only thing that shows them
    // (see the note on showEntries — it has to be here, not in the constructor).
    this.showEntries();
    // The queued REBIND decisions first: they were taken inside the events of the last frame, and this is
    // the lane that owns the bind table.
    this.applyRebinds();
    const capturing = this.deps.capturing();
    const bound = this.deps.boundCodes();
    for (const spec of keybindPanels()) {
      for (const chip of spec.chips) {
        const selected = capturing === chip.action;
        const code = this.deps.bindOf(chip.action);
        // Selected: the bare i18n KEY (the reconciler re-resolves it every frame). Otherwise the
        // formatted literal, which is why it is written raw.
        this.write(chip.entity, selected ? chip.labelKey : chip.format(code, selected), !selected);
        setUiSelected(this.world, chip.entity, selected);
      }
      for (const cap of spec.keycaps) {
        this.write(cap.legend, cap.legendText(), true);
        setUiActive(this.world, cap.key, bound.has(cap.code));
      }
    }

    // ── The gesture's PRESENTATION, derived from data every frame ───────────────────────────────────
    // The pointer position is the POINTER resource's (the device layer publishes it while it handles
    // mousemove — it was a second `document` listener in the view before), so the drag threshold, the
    // hover target and the line's geometry are all RECOMPUTED here instead of being pushed by the event
    // that moved the pointer. That is the rule the rest of the UI already follows: state in, painting out.
    const pointer = this.world.resource(POINTER);
    const gesture = this.world.resource(KEYBIND_GESTURE);
    const drag = gesture.drag;
    let hover: Entity | null = null;
    if (drag) {
      gesture.pointerX = pointer.x;
      gesture.pointerY = pointer.y;
      // Past the 6px threshold the gesture IS a drag (and stays one, even if the pointer comes back).
      if (!drag.moved && Math.hypot(pointer.x - drag.anchorX, pointer.y - drag.anchorY) >= 6) drag.moved = true;
      if (drag.moved) {
        gesture.hover = this.deps.keycapAt(pointer.x, pointer.y);
        hover = gesture.hover;
      }
    }
    if (hover !== this.hovered) {
      if (this.hovered !== null) setUiSelected(this.world, this.hovered, false);
      if (hover !== null) setUiSelected(this.world, hover, true);
      this.hovered = hover;
    }

    // The rubber band: one widget whose LAYOUT is the two endpoints, written while a drag is past its
    // threshold and hidden otherwise.
    const show = drag !== null && drag.moved;
    if (show) {
      const dx = gesture.pointerX - drag!.anchorX;
      const dy = gesture.pointerY - drag!.anchorY;
      const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
      setUiLayout(
        this.world,
        this.deps.line,
        `left:${drag!.anchorX}px;top:${drag!.anchorY}px;width:${Math.hypot(dx, dy)}px;` +
          `transform-origin:left center;transform:rotate(${angle}deg);`,
      );
    }
    if (show !== this.lineShown) {
      setUiVisible(this.world, this.deps.line, show);
      this.lineShown = show;
    }
  }

  /** Apply what the device layer decided, in arrival order, then clear the queue. A `bindCapture` intent
   *  is applied to whatever capture is armed NOW — a capture that was already ended (Escape handled,
   *  another bind landed) makes it a no-op instead of binding the wrong action. */
  private applyRebinds(): void {
    const gesture = this.world.resource(KEYBIND_GESTURE);
    if (gesture.rebinds.length === 0) return;
    for (const intent of gesture.rebinds) {
      if (intent.kind === "bindCapture") {
        const action = this.deps.capturing();
        if (!action) continue;
        this.deps.setBind(action, intent.code);
        this.deps.endCapture();
        this.deps.log(`KBCAP bind done (code=${intent.code || "Escape"})`);
      } else {
        this.deps.setBind(intent.action as BindAction, intent.code);
        this.deps.log(`KBCAP drag release action=${intent.action} code=${intent.code || "no hit"}`);
      }
    }
    gesture.rebinds.length = 0;
  }

  private write(entity: Entity, text: string, raw: boolean): void {
    const key = `${raw ? "r" : "k"}\u0000${text}`;
    if (this.drawn.get(entity) === key) return;
    this.drawn.set(entity, key);
    setUiText(this.world, entity, text, raw);
  }
}
