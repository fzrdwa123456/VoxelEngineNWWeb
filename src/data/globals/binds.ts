// ===== The key bind DATA: the action ids, their defaults, the panel's rows and the display names =====
// Nothing in this file DOES anything. It holds the four tables that the bind machinery reads:
//
//   BIND_DEFAULTS      action -> its default code (the fallback before settings.json has a say)
//   KB_ACTIONS         the bind panel's rows: which action, under which i18n key
//   CODE_DISPLAY_NAMES how a code is written on a keycap (KeyW -> W, ControlLeft -> LCtrl)
//
// They live under `data/` because "which key is jump by default" and "how is KeyW written" are VALUES,
// not behaviour. The module that acts on them — validation, the conflict policy, the settings file and
// the code <-> mouse-button mapping — is `logic/host/input/keybinds.ts`; the panel that builds the rows
// is `logic/host/dom/menu.ts`.

/** Every action a key or a mouse button can be bound to. The union lives here because it is the SHAPE of
 *  the data (`KEYMAP.codes`, the gesture's `capturing`, save/load); the behaviour over it does not. */
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

export interface BindDef {
  action: BindAction;
  defaultCode: string;
}

/** The defaults, in the order the panel lists them. A code here is a `KeyboardEvent.code` or one of the
 *  mouse pseudo codes (`MouseLeft`…), which are managed in the same table as keyboard codes. */
export const BIND_DEFAULTS: BindDef[] = [
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

/** One row of the bind panel: the action, and the i18n KEY of the label shown next to its keycaps. */
export interface BindRow {
  action: BindAction;
  labelKey: string;
}

export const KB_ACTIONS: BindRow[] = [
  { action: "forward", labelKey: "bind.forward" },
  { action: "back", labelKey: "bind.back" },
  { action: "left", labelKey: "bind.left" },
  { action: "right", labelKey: "bind.right" },
  { action: "jump", labelKey: "bind.jump" },
  { action: "sneak", labelKey: "bind.sneak" },
  { action: "inventory", labelKey: "bind.inventory" },
  { action: "break", labelKey: "bind.break" },
  { action: "place", labelKey: "bind.place" },
];

/** The shape a bind code must have: an identifier starting with a letter
 *  (KeyW / Space / ControlLeft / ArrowUp / MouseLeft …). Deliberately NOT global, so `.test` keeps no
 *  per-call state. */
export const BIND_CODE_PATTERN = /^[A-Z][A-Za-z0-9]*$/;

/** Mouse buttons as (pseudo code, MouseEvent.button) pairs. The pseudo codes are binds like any other key
 *  code, and this table is the ONE place the two spellings are related — so `codeToButton` and
 *  `buttonToCode` cannot disagree about what `MouseX1` means. */
export const MOUSE_BUTTONS: readonly (readonly [string, number])[] = [
  ["MouseLeft", 0],
  ["MouseMiddle", 1],
  ["MouseRight", 2],
  ["MouseX1", 3],
  ["MouseX2", 4],
];

/** code -> display name (KeyW->W, Digit1->1, ControlLeft->LCtrl, ArrowUp->Up ...). A TABLE, so it is
 *  built once at import instead of on every keycap that asks (it used to be a literal inside the
 *  function, i.e. one 50-entry object per call per frame). */
export const CODE_DISPLAY_NAMES: Record<string, string> = {
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
