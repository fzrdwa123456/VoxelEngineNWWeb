// ===== ui.keybind: the key-bind gesture and the bind panels, as DATA + a system =====
// The gesture used to be ~140 lines of module-level mutable state in ui/menu.ts (`chipDrag`,
// `capHover`, `suppressNextClick`) plus an imperative `renderAllPanels()` that every code path had to
// remember to call — the cross-instance desync bug (a refresh hitting the hidden panel while the
// visible one stayed stuck) was a consequence of that shape.
//
// WHAT MOVED HERE and what deliberately did not:
//   * the GESTURE'S STATE is now KEYBIND_GESTURE, a resource: which chip is being dragged, which keycap
//     is lit, the live pointer position, and the one-shot click shield.
//   * the PANEL RENDERING (chip labels + selection, keycap legends + bound state) is derived every
//     frame from the bind table, like every other widget surface: no `renderAllPanels()` call sites, no
//     subscriptions, and a language switch or a bind change cannot desync two panels because there is
//     nothing to desync.
//   * the RUBBER BAND stays DOM in ui/menu.ts (the one element that file owns) — this system only
//     decides that a line has to be drawn, through injected `showLine`/`hideLine`. That is the same
//     split as the reconciler ("the system decides, the view draws"), and it keeps ecs/ DOM-free.
//   * the ARM PATHS (click shield / capture-free drag / physical capture) stay exactly where they were,
//     inside ui/menu.ts's listeners, reading this resource instead of module-level `let`s. They are
//     timing-sensitive click-synthesis handling (read the block comment there) and moving a decision
//     out of the listener that must take it synchronously is how that class of bug comes back.
import type { BindAction } from "../../platform/keybinds";
import { defineResource, type Resource } from "../core/resource";
import { POINTER } from "../resources";
import type { Entity, SystemAccess, World } from "../World";
import { UI_PAINT, type UiKeybindPaint } from "./paint";
import { UI_LAYOUT, UI_STATE, UI_TEXT, setUiActive, setUiLayout, setUiSelected, setUiText, setUiVisible } from "./widgets";

/** A capture-free drag in progress: hold an action chip and drop it on a keycap. `button` records the
 *  initiator — presses/releases of the OTHER button during the drag must not interrupt it. */
export interface ChipDrag {
  readonly action: BindAction;
  readonly button: number;
  readonly anchorX: number;
  readonly anchorY: number;
  /** Past the movement threshold this is a drag; below it, a plain click falls through to the
   *  native click's select toggle. */
  moved: boolean;
}

/** One REBIND decision the DEVICE layer already made, waiting for the ui lane to apply it. The listeners
 *  in platform/bind-gesture.ts take every decision at EVENT time (which key, which button, whether the
 *  drop landed on a keycap); what they may NOT do is write the bind table — that is the system's job, so
 *  the decision is queued here as data and `ui.keybind` applies it in the lane. The codes are already
 *  resolved (KeyboardEvent.code / buttonToCode / the keycap hit test), so this module needs no platform
 *  import. */
export type RebindIntent =
  /** A key or mouse code pressed while a capture is armed ("" = unbind — Escape) */
  | { readonly kind: "bindCapture"; readonly code: string }
  /** A drag released on a keycap: bind that action outright (no capture involved) */
  | { readonly kind: "bindDrag"; readonly action: string; readonly code: string };

/** Everything the document-level gesture knows, as world data. */
export interface KeybindGesture {
  /** The capture-free drag, or null */
  drag: ChipDrag | null;
  /** The keycap widget the drag currently lights up (the highlight is widget state, so the gesture only
   *  remembers WHICH entity it lit) */
  hover: Entity | null;
  /** Live pointer position, for the rubber band */
  pointerX: number;
  pointerY: number;
  /** The one-shot click shield (armed by the arm paths in ui/menu.ts; see the contract there) */
  shield: boolean;
  /** The action a rebind CAPTURE is armed for, or null. It used to be a module-level `let` inside
   *  platform/keybinds.ts — state with no owner, read by the ESC gate in the input system, by the panel
   *  actions and by `ui.navigation`. It is world data now: `platform/keybinds.ts` only holds a pointer to
   *  this object (`adoptKeybindGesture`), and the bind itself is applied by this system. */
  capturing: BindAction | null;
  /** Rebind decisions taken at event time, drained (and applied) by `ui.keybind` in the ui lane. */
  readonly rebinds: RebindIntent[];
}

export const KEYBIND_GESTURE = defineResource<KeybindGesture>("keybindGesture");

export function createKeybindGesture(): KeybindGesture {
  return {
    drag: null,
    hover: null,
    pointerX: 0,
    pointerY: 0,
    shield: false,
    capturing: null,
    rebinds: [],
  };
}

/** One action chip: the label is SURFACE logic (the selected chip shows a bare i18n KEY, the others a
 *  formatted "Sprint · ShiftLeft" literal), so the surface supplies it — the same rule the bound-slider
 *  label follows in ui/menu.ts. */
export interface KeybindChip {
  readonly action: BindAction;
  readonly entity: Entity;
  /** i18n key, used verbatim when this chip is the selected one */
  readonly labelKey: string;
  /** The formatted label for an unselected chip (raw text: it carries a value) */
  readonly format: (code: string, selected: boolean) => string;
}

/** One physical keycap and the legend widget inside it. */
export interface KeybindKeycap {
  readonly code: string;
  readonly key: Entity;
  readonly legend: Entity;
  /** The printed legend for this key (OS layout when available, else the QWERTY reference) */
  readonly legendText: () => string;
}

/** A panel instance's widgets. buildSettingsPanel() registers one per instance (pause menu + main
 *  menu): the panels are separate widget trees but they show ONE bind table, which is why the data they
 *  render from is a resource and not a field of either instance. */
export interface KeybindPanelSpec {
  readonly chips: readonly KeybindChip[];
  readonly keycaps: readonly KeybindKeycap[];
}

const specs: KeybindPanelSpec[] = [];

/** Wiring-time registration (structural: spawn happened before this is called) */
export function registerKeybindPanel(spec: KeybindPanelSpec): void {
  specs.push(spec);
}

/** Only the gate/tests need this: forget every registered panel. */
export function clearKeybindPanels(): void {
  specs.length = 0;
}

export interface KeybindDeps {
  /** The bind table (platform/keybinds owns it — injected so ecs/ never imports the platform layer) */
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
  /** The rubber band WIDGET (spawned by the composition root from ui/menu.ts's prefab): the SYSTEM writes
   *  its geometry as data (UI_LAYOUT) and the reconciler paints it. It replaced an SVG element the view
   *  owned and mutated on every mousemove. */
  readonly line: Entity;
  /** The keycap under a point, or null (ui/menu.ts owns the hit test and the keycap action id) */
  readonly keycapAt: (x: number, y: number) => Entity | null;
}

/** It writes widget data for the bind panels, the hover highlight during a drag and the rubber band's
 *  geometry; it READS the bind table (the KEYMAP resource, through the injected `boundCodes`/`bindOf`) and
 *  the POINTER resource (the device layer's last known position) to derive them. */
export const UI_KEYBIND_ACCESS: SystemAccess = {
  reads: [UI_STATE, UI_TEXT],
  writes: [UI_STATE, UI_TEXT, UI_LAYOUT],
  readsExternal: ["keybinds"],
};

export class UiKeybindSystem {
  /** Last text written per widget, so the 100+ keycap legends are not rewritten every frame (the
   *  reconciler would diff them away anyway, but this keeps the ui lane cheap). The DATA is
   *  UI_PAINT.keybind (ecs/ui/paint.ts): the caches are world state, this is their only writer. */
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
    for (const spec of specs) {
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
    // mousemove — it was a second `document` listener in ui/menu.ts before), so the drag threshold, the
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
