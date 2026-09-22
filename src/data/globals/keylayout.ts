// ===== The VISUAL keyboard layout: which keycaps exist, in which grid =====
// The settings panel's key bind page draws a whole keyboard and lets the user click a keycap to bind it.
// These four tables are that drawing: they say which codes exist, how wide each one is, and where each
// one sits. They are DATA — the panel (`logic/host/dom/menu.ts`) reads them and composes the prefabs;
// nothing here knows what a widget is.

/** One keycap: [code, width unit]; code="" is an empty spacer. */
export type KeyCap = [string, number];

/** One main-area row: the keycaps in it. */
export type KeyRow = KeyCap[];

// Visual keyboard main area: [code, width unit u]; code="" is an empty spacer. Each row sums
// to 18.5u (main 15 + gap 0.5 + nav 3); flex-grow splits widths proportionally.
export const KB_ROWS: KeyRow[] = [
  // Function key row (PrtSc group moved to the bottom right tower)
  [["Escape", 1], ["", 1], ["F1", 1], ["F2", 1], ["F3", 1], ["F4", 1], ["", 0.5], ["F5", 1], ["F6", 1], ["F7", 1], ["F8", 1], ["", 0.5], ["F9", 1], ["F10", 1], ["F11", 1], ["F12", 1]],
  // Main number row (nav area moved to the bottom right tower)
  [["Backquote", 1], ["Digit1", 1], ["Digit2", 1], ["Digit3", 1], ["Digit4", 1], ["Digit5", 1], ["Digit6", 1], ["Digit7", 1], ["Digit8", 1], ["Digit9", 1], ["Digit0", 1], ["Minus", 1], ["Equal", 1], ["Backspace", 2]],
  // Tab row
  [["Tab", 1.5], ["KeyQ", 1], ["KeyW", 1], ["KeyE", 1], ["KeyR", 1], ["KeyT", 1], ["KeyY", 1], ["KeyU", 1], ["KeyI", 1], ["KeyO", 1], ["KeyP", 1], ["BracketLeft", 1], ["BracketRight", 1], ["Backslash", 1.5]],
  // Caps row
  [["CapsLock", 1.75], ["KeyA", 1], ["KeyS", 1], ["KeyD", 1], ["KeyF", 1], ["KeyG", 1], ["KeyH", 1], ["KeyJ", 1], ["KeyK", 1], ["KeyL", 1], ["Semicolon", 1], ["Quote", 1], ["Enter", 2.25]],
  // Shift row (arrow keys moved to the bottom area)
  [["ShiftLeft", 2.25], ["KeyZ", 1], ["KeyX", 1], ["KeyC", 1], ["KeyV", 1], ["KeyB", 1], ["KeyN", 1], ["KeyM", 1], ["Comma", 1], ["Period", 1], ["Slash", 1], ["ShiftRight", 2.75]],
  // Bottom row (arrow keys moved to the bottom area)
  [["ControlLeft", 1.25], ["MetaLeft", 1.25], ["AltLeft", 1.25], ["Space", 6.25], ["AltRight", 1.25], ["MetaRight", 1.25], ["ContextMenu", 1.25], ["ControlRight", 1.25]],
];

/** One keycap of a CSS-grid cluster: its code and its `grid-area` string. */
export interface GridKey {
  code: string;
  area: string;
}

// Arrow cluster: Up centered on top, Left/Down/Right below (track width aligned with the main grid)
export const TOWER_GRID: GridKey[] = [
  { code: "PrintScreen", area: "1 / 1 / 2 / 2" },
  { code: "ScrollLock", area: "1 / 2 / 2 / 3" },
  { code: "Pause", area: "1 / 3 / 2 / 4" },
  { code: "Insert", area: "2 / 1 / 3 / 2" },
  { code: "Home", area: "2 / 2 / 3 / 3" },
  { code: "PageUp", area: "2 / 3 / 3 / 4" },
  { code: "Delete", area: "3 / 1 / 4 / 2" },
  { code: "End", area: "3 / 2 / 4 / 3" },
  { code: "PageDown", area: "3 / 3 / 4 / 4" },
  { code: "ArrowUp", area: "4 / 2 / 5 / 3" },
  { code: "ArrowLeft", area: "5 / 1 / 6 / 2" },
  { code: "ArrowDown", area: "5 / 2 / 6 / 3" },
  { code: "ArrowRight", area: "5 / 3 / 6 / 4" },
];

// Numpad: standard 4-column grid; + and Enter span two rows restoring the real shape, 0 spans two columns
export const NUM_GRID: GridKey[] = [
  { code: "NumLock", area: "1 / 1 / 2 / 2" },
  { code: "NumpadDivide", area: "1 / 2 / 2 / 3" },
  { code: "NumpadMultiply", area: "1 / 3 / 2 / 4" },
  { code: "NumpadSubtract", area: "1 / 4 / 2 / 5" },
  { code: "Numpad7", area: "2 / 1 / 3 / 2" },
  { code: "Numpad8", area: "2 / 2 / 3 / 3" },
  { code: "Numpad9", area: "2 / 3 / 3 / 4" },
  { code: "NumpadAdd", area: "2 / 4 / 4 / 5" },
  { code: "Numpad4", area: "3 / 1 / 4 / 2" },
  { code: "Numpad5", area: "3 / 2 / 4 / 3" },
  { code: "Numpad6", area: "3 / 3 / 4 / 4" },
  { code: "Numpad1", area: "4 / 1 / 5 / 2" },
  { code: "Numpad2", area: "4 / 2 / 5 / 3" },
  { code: "Numpad3", area: "4 / 3 / 5 / 4" },
  { code: "NumpadEnter", area: "4 / 4 / 6 / 5" },
  { code: "Numpad0", area: "5 / 1 / 6 / 3" },
  { code: "NumpadDecimal", area: "5 / 3 / 6 / 4" },
];

// Mouse buttons: full five-button layout. 6 half-column tracks: top-row main keys span 2
// tracks each, bottom-row side keys span 3 tracks filling the row without gaps
export const MOUSE_GRID: GridKey[] = [
  { code: "MouseLeft", area: "1 / 1 / 2 / 3" },
  { code: "MouseMiddle", area: "1 / 3 / 2 / 5" },
  { code: "MouseRight", area: "1 / 5 / 2 / 7" },
  { code: "MouseX1", area: "2 / 1 / 3 / 4" },
  { code: "MouseX2", area: "2 / 4 / 3 / 7" },
];
