// ===== THE GAME's DOOR TO THE UI =====
//
// The composition root and the render lane reach the widget layer through THIS module, never through
// `src/plugins/ui/**`. Together with `adapters/game.ts` it is the whole seam: the UI does not import a
// game plugin, a game plugin does not import the UI, and everything that has to cross does it here.
//
// The F3 seam is the one data-level exception worth naming: `diagnostics` is a render-lane system that writes
// the debug panel's WIDGET data (it owns the numbers), so it needs the two components and the setter. They are
// re-exported rather than duplicated — the widgets have one owner (the UI), and this is its published face.
export { createMainMenu, createPauseMenu, createUiViews } from "../plugins/ui";
export { createUiOrder, UI_ORDER, UI_STATE, UI_TEXT, setUiText } from "../plugins/ui/components";
export { Menu, spawnMenuBackdrop } from "../plugins/ui/views/menu";
export { MainMenu } from "../plugins/ui/views/mainmenu";
export { cancelKeybindDrag } from "../plugins/ui-keybind/views/keybind";
export type { NavigationTrees } from "../plugins/ui/systems/navigation";
