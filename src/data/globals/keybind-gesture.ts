// ===== The key-bind GESTURE, as world data =====
// This module is the DATA half of the key bind panel: the gesture's state (which chip is being dragged,
// which keycap is lit, the live pointer, the one-shot click shield, the rebind capture), the queued
// device decisions, and the registry of the panel instances the wiring built. The BEHAVIOUR that reads
// it lives in `logic/ui/keybind.ts` (the derived panels + the queued rebinds) and in
// `logic/host/input/bind-gesture.ts` (the event-time half, which only publishes facts).
//
// The gesture is a RESOURCE (`KEYBIND_GESTURE`), so the listeners that decide at event time and the
// system that applies the result in the ui lane see the same object — that split is what lets both be
// tested and what removed the last module-level `let` from platform/keybinds.ts (which now only holds a
// pointer to this object, `adoptKeybindGesture`).
import type { BindAction } from "./binds";
import { defineResource, type Resource } from "../../core/data/resource";
import type { Entity } from "../../core/world";

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
 *  in logic/host/input/bind-gesture.ts take every decision at EVENT time (which key, which button,
 *  whether the drop landed on a keycap); what they may NOT do is write the bind table — that is the
 *  system's job, so the decision is queued here as data and `ui.keybind` applies it in the lane. The
 *  codes are already resolved (KeyboardEvent.code / buttonToCode / the keycap hit test), so this module
 *  needs no platform import. */
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
  /** The one-shot click shield (armed by the arm paths in logic/host/dom/menu.ts; see its contract) */
  shield: boolean;
  /** The action a rebind CAPTURE is armed for, or null. It used to be a module-level `let` inside
   *  logic/host/input/keybinds.ts — state with no owner, read by the ESC gate in the input system, by
   *  the panel actions and by `ui.navigation`. It is world data now: that module only holds a pointer to
   *  this object (`adoptKeybindGesture`), and the bind itself is applied by the keybind system. */
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
 *  label follows in the settings panel. */
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

/** The panel instances the wiring registered (a wiring-time list, not game state) */
const specs: KeybindPanelSpec[] = [];

/** Wiring-time registration (structural: spawn happened before this is called) */
export function registerKeybindPanel(spec: KeybindPanelSpec): void {
  specs.push(spec);
}

/** Every registered panel, for the system that derives their text every frame. */
export function keybindPanels(): readonly KeybindPanelSpec[] {
  return specs;
}

/** Only the gate/tests need this: forget every registered panel. */
export function clearKeybindPanels(): void {
  specs.length = 0;
}
