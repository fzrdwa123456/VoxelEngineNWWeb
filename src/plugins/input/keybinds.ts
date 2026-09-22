// ===== Key bind registry =====
// Action id -> KeyboardEvent.code. Defaults + settings.json persistence (keybinds field).
// Rebind conflict policy: preemption — if the new code is taken by another action, that action is cleared to unbound ("").
// ESC cannot be bound (reserved for menus); intercepted by the capture layer.
//
// The TABLE is a RESOURCE (`KEYMAP`, see ecs/resources.ts): four systems ask "which key is jump" every
// tick, so the map belongs to the world and every one of them declares that it reads it. This module owns
// the VALIDATION, the conflict policy and the file, and it reads/writes the resource object it was given
// by `loadBinds` — one owner, no private copy to drift. The VALUES it works on (the action ids, the
// defaults, the panel rows, the keycap display names) are data — `data/globals/binds.ts` — and the
// notification that a bind changed is behaviour — `logic/host/config-bus.ts`.
import type { KeyMapState } from "../../data/globals/resources";
import type { KeybindGesture } from "../../data/globals/keybind-gesture";
import { BIND_CODE_PATTERN, BIND_DEFAULTS, CODE_DISPLAY_NAMES, MOUSE_BUTTONS, type BindAction } from "../../data/globals/binds";
import { notifyConfigChange } from "../../core/services/bus";

/** The resource object adopted at boot. Null only before `loadBinds` (a unit test with no World): the
 *  module's DEFAULTS answer then, which is exactly what its own table means. */
let table: KeyMapState | null = null;

/** The code in force for one action: the resource's, or the module default before adoption. */
function codeOf(action: BindAction): string {
  return table?.codes.get(action) ?? BIND_DEFAULTS.find((d) => d.action === action)!.defaultCode;
}

/** Adopt the KEYMAP resource: it becomes the table, seeded with the defaults for anything it lacks.
 *  Called by `loadBinds`; exposed so the gate (and any future world) can drive the module standalone. */
export function adoptKeyMap(state: KeyMapState): void {
  table = state;
  for (const d of BIND_DEFAULTS) {
    if (!state.codes.has(d.action)) state.codes.set(d.action, d.defaultCode);
  }
}

/** Loaded at startup from settings.json's keybinds object into the KEYMAP resource (unknown
 *  actions/invalid values ignored, defaults kept) */
export function loadBinds(state: KeyMapState, raw: unknown): void {
  adoptKeyMap(state);
  if (typeof raw !== "object" || raw === null) return;
  const obj = raw as Record<string, unknown>;
  for (const d of BIND_DEFAULTS) {
    const v = obj[d.action];
    if (typeof v === "string" && (v === "" || isValidCode(v))) {
      state.codes.set(d.action, v);
    }
  }
}

/** Snapshot of all current binds (for saving) */
export function getBindsAll(): Record<BindAction, string> {
  const out = {} as Record<BindAction, string>;
  for (const d of BIND_DEFAULTS) out[d.action] = codeOf(d.action);
  return out;
}

export function getBind(action: BindAction): string {
  return codeOf(action);
}

/** Rebind: preempt conflicts (same code on other actions cleared to unbound), notify subscribers to refresh the UI */
export function setBind(action: BindAction, code: string): void {
  if (code !== "" && !isValidCode(code)) return;
  if (!table) adoptKeyMap({ codes: new Map(BIND_DEFAULTS.map((d) => [d.action, d.defaultCode])) });
  for (const d of BIND_DEFAULTS) {
    if (d.action !== action && table!.codes.get(d.action) === code) {
      table!.codes.set(d.action, "");
    }
  }
  table!.codes.set(action, code);
  notifyConfigChange("binds");
}

// ===== Rebind capture state =====
// The UI layer clicks a row to enter capture; older listeners registered before the capture listener (e.g. inventory E)
// query isCapturing() and yield, avoiding accidental game triggers while rebinding.
//
// THE STATE IS THE GESTURE RESOURCE (`KEYBIND_GESTURE.capturing`, ecs/ui/keybind.ts) and this module only
// holds a POINTER to it, adopted by the composition root — a module-level `let capturing` was the last
// piece of semantic state living outside the world (read by the input system's ESC gate, by the bind
// panel's actions and by ui.navigation, i.e. exactly the "one value, several readers" shape a resource is
// for). The BIND ITSELF is applied in the ui lane too (`ui.keybind` drains the queued device decisions);
// what is left here is the table and its validation.
let gesture: KeybindGesture | null = null;

/** Hand this module the gesture resource (`KEYBIND_GESTURE`) the world owns. Until it is adopted every
 *  capture query answers "no capture", which is the truth before wiring. */
export function adoptKeybindGesture(g: KeybindGesture): void {
  gesture = g;
}

export function beginCapture(action: BindAction): void {
  if (gesture) gesture.capturing = action;
}

export function endCapture(): void {
  if (gesture) gesture.capturing = null;
}

export function isCapturing(): boolean {
  return (gesture?.capturing ?? null) !== null;
}

export function getCapturing(): BindAction | null {
  return gesture?.capturing ?? null;
}

/** KeyboardEvent.code validity: identifier starting with a letter (KeyW/Space/ControlLeft/ArrowUp/MouseLeft...) */
function isValidCode(code: string): boolean {
  return BIND_CODE_PATTERN.test(code);
}

/** Bind code -> MouseEvent.button number (only mouse pseudo codes map; keyboard codes return null) */
export function codeToButton(code: string): number | null {
  const entry = MOUSE_BUTTONS.find(([c]) => c === code);
  return entry ? entry[1] : null;
}

/** MouseEvent.button -> mouse pseudo code ("MouseLeft"/"MouseMiddle"/"MouseRight"/"MouseX1"/"MouseX2"); other buttons null */
export function buttonToCode(button: number): string | null {
  const entry = MOUSE_BUTTONS.find(([, b]) => b === button);
  return entry ? entry[0] : null;
}

/** MouseEvent.button -> action bound to that mouse button (registry lookup); null if unbound */
export function buttonToAction(button: number): BindAction | null {
  const code = buttonToCode(button);
  if (!code) return null;
  for (const d of BIND_DEFAULTS) {
    if (codeOf(d.action) === code) return d.action;
  }
  return null;
}

/** code -> display name (KeyW->W, Digit1->1, ControlLeft->LCtrl, ArrowUp->Up ...) */
export function codeDisplayName(code: string): string {
  if (code === "") return "";
  const MAP = CODE_DISPLAY_NAMES;
  if (MAP[code]) return MAP[code];
  const m = /^(?:Key|Digit|Numpad)(.+)$/.exec(code);
  if (m) return m[1];
  return code;
}
