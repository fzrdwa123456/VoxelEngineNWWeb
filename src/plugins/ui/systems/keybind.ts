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
import { POINTER } from "../../../data/globals/resources";
import { KEYBIND_GESTURE, keybindPanels } from "../../../data/globals/keybind-gesture";
import type { Entity, SystemAccess, World } from "../../../core/world";
import { UI_PAINT, type UiKeybindPaint } from "../../../data/globals/paint";
import { UI_LAYOUT, UI_STATE, UI_TEXT, setUiActive, setUiLayout, setUiSelected, setUiText, setUiVisible } from "../components";

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

  /** ui lane, once per frame: derive every panel's text/state from the bind table, then apply the
   *  gesture's presentation (the hover highlight and the rubber band). */
  step(): void {
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
