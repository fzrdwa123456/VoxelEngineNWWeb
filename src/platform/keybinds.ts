// ===== Key bind registry =====
// Action id -> KeyboardEvent.code. Defaults + settings.json persistence (keybinds field).
// Rebind conflict policy: preemption — if the new code is taken by another action, that action is cleared to unbound ("").
// ESC cannot be bound (reserved for menus); intercepted by the capture layer.
//
// The TABLE is a RESOURCE (`KEYMAP`, see ecs/resources.ts): four systems ask "which key is jump" every
// tick, so the map belongs to the world and every one of them declares that it reads it. This module owns
// the DEFAULTS, the validation and the display names, and it reads/writes the resource object it was
// given by `loadBinds` — one owner, no private copy to drift.
import type { KeyMapState } from "../ecs/resources";

export type BindAction =
  | "forward"
  | "back"
  | "left"
  | "right"
  | "jump"
  | "sneak"
  | "sprint"
  | "inventory"
  | "break"
  | "place";

interface BindDef {
  action: BindAction;
  defaultCode: string;
}

const DEFS: BindDef[] = [
  { action: "forward", defaultCode: "KeyW" },
  { action: "back", defaultCode: "KeyS" },
  { action: "left", defaultCode: "KeyA" },
  { action: "right", defaultCode: "KeyD" },
  { action: "jump", defaultCode: "Space" },
  { action: "sneak", defaultCode: "ControlLeft" },
    // Sprint: shared speed-up for walk/fly/spectator; Shift by default, no conflict with sneak (Ctrl).
    // The multiplier is defined once in ecs/systems/movement.ts (SPRINT_MULT) — do not restate its value here.
  { action: "sprint", defaultCode: "ShiftLeft" },
  { action: "inventory", defaultCode: "KeyE" },
    // Mouse-button binds: stored as pseudo codes (MouseLeft/MouseRight), managed in the same table as keyboard codes
  { action: "break", defaultCode: "MouseLeft" },
  { action: "place", defaultCode: "MouseRight" },
];

/** The resource object adopted at boot. Null only before `loadBinds` (a unit test with no World): the
 *  module's DEFAULTS answer then, which is exactly what its own table means. */
let table: KeyMapState | null = null;

const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((cb) => cb());
}

/** The code in force for one action: the resource's, or the module default before adoption. */
function codeOf(action: BindAction): string {
  return table?.codes.get(action) ?? DEFS.find((d) => d.action === action)!.defaultCode;
}

/** Adopt the KEYMAP resource: it becomes the table, seeded with the defaults for anything it lacks.
 *  Called by `loadBinds`; exposed so the gate (and any future world) can drive the module standalone. */
export function adoptKeyMap(state: KeyMapState): void {
  table = state;
  for (const d of DEFS) {
    if (!state.codes.has(d.action)) state.codes.set(d.action, d.defaultCode);
  }
}

/** Loaded at startup from settings.json's keybinds object into the KEYMAP resource (unknown
 *  actions/invalid values ignored, defaults kept) */
export function loadBinds(state: KeyMapState, raw: unknown): void {
  adoptKeyMap(state);
  if (typeof raw !== "object" || raw === null) return;
  const obj = raw as Record<string, unknown>;
  for (const d of DEFS) {
    const v = obj[d.action];
    if (typeof v === "string" && (v === "" || isValidCode(v))) {
      state.codes.set(d.action, v);
    }
  }
}

/** Snapshot of all current binds (for saving) */
export function getBindsAll(): Record<BindAction, string> {
  const out = {} as Record<BindAction, string>;
  for (const d of DEFS) out[d.action] = codeOf(d.action);
  return out;
}

export function getBind(action: BindAction): string {
  return codeOf(action);
}

/** Rebind: preempt conflicts (same code on other actions cleared to unbound), notify subscribers to refresh the UI */
export function setBind(action: BindAction, code: string): void {
  if (code !== "" && !isValidCode(code)) return;
  if (!table) adoptKeyMap({ codes: new Map(DEFS.map((d) => [d.action, d.defaultCode])) });
  for (const d of DEFS) {
    if (d.action !== action && table!.codes.get(d.action) === code) {
      table!.codes.set(d.action, "");
    }
  }
  table!.codes.set(action, code);
  notify();
}

export function onBindsChange(cb: () => void): void {
  listeners.add(cb);
}

// ===== Rebind capture state =====
// The UI layer clicks a row to enter capture; older listeners registered before the capture listener (e.g. inventory E)
// query isCapturing() and yield, avoiding accidental game triggers while rebinding.
let capturing: BindAction | null = null;

export function beginCapture(action: BindAction): void {
  capturing = action;
}

export function endCapture(): void {
  capturing = null;
}

export function isCapturing(): boolean {
  return capturing !== null;
}

export function getCapturing(): BindAction | null {
  return capturing;
}

/** KeyboardEvent.code validity: identifier starting with a letter (KeyW/Space/ControlLeft/ArrowUp/MouseLeft...) */
function isValidCode(code: string): boolean {
  return /^[A-Z][A-Za-z0-9]*$/.test(code);
}

/** Bind code -> MouseEvent.button number (only mouse pseudo codes map; keyboard codes return null) */
export function codeToButton(code: string): number | null {
  if (code === "MouseLeft") return 0;
  if (code === "MouseMiddle") return 1;
  if (code === "MouseRight") return 2;
  if (code === "MouseX1") return 3;
  if (code === "MouseX2") return 4;
  return null;
}

/** MouseEvent.button -> mouse pseudo code ("MouseLeft"/"MouseMiddle"/"MouseRight"/"MouseX1"/"MouseX2"); other buttons null */
export function buttonToCode(button: number): string | null {
  if (button === 0) return "MouseLeft";
  if (button === 1) return "MouseMiddle";
  if (button === 2) return "MouseRight";
  if (button === 3) return "MouseX1";
  if (button === 4) return "MouseX2";
  return null;
}

/** MouseEvent.button -> action bound to that mouse button (registry lookup); null if unbound */
export function buttonToAction(button: number): BindAction | null {
  const code = buttonToCode(button);
  if (!code) return null;
  for (const d of DEFS) {
    if (codeOf(d.action) === code) return d.action;
  }
  return null;
}

/** code -> display name (KeyW->W, Digit1->1, ControlLeft->LCtrl, ArrowUp->Up ...) */
export function codeDisplayName(code: string): string {
  if (code === "") return "";
  const MAP: Record<string, string> = {
    Space: "Space",
    MouseLeft: "LMB",
    MouseMiddle: "MMB",
    MouseRight: "RMB",
    MouseX1: "X1",
    MouseX2: "X2",
    ControlLeft: "LCtrl",
    ControlRight: "RCtrl",
    ShiftLeft: "LShift",
    ShiftRight: "RShift",
    AltLeft: "LAlt",
    AltRight: "RAlt",
    MetaLeft: "Win",
    MetaRight: "Win",
    ContextMenu: "Menu",
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
    Tab: "Tab",
    CapsLock: "Caps",
    Enter: "Enter",
    Backspace: "Bksp",
    Escape: "Esc",
    Insert: "Ins",
    Delete: "Del",
    PageUp: "PgUp",
    PageDown: "PgDn",
    Home: "Home",
    End: "End",
    PrintScreen: "PrtSc",
    ScrollLock: "ScrLk",
    Pause: "Pause",
    NumLock: "Num",
    NumpadDivide: "/",
    NumpadMultiply: "*",
    NumpadSubtract: "-",
    NumpadAdd: "+",
    NumpadEnter: "⏎",
    NumpadDecimal: ".",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Semicolon: ";",
    Quote: "'",
    Backquote: "`",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Backslash: "\\",
  };
  if (MAP[code]) return MAP[code];
  const m = /^(?:Key|Digit|Numpad)(.+)$/.exec(code);
  if (m) return m[1];
  return code;
}
