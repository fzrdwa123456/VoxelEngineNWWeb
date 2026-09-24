// ===== The key bind tab's MOUNT: how the settings panel asks a plugin to build one of its tabs =====
// DATA, so that neither plugin has to import the other. The settings panel lives in `plugins/ui`, the tab
// lives in `plugins/ui-keybind`, and the dependency runs one way (`ui-keybind` -> `ui`) — so the shape they
// agree on cannot live in either of them. It lives here, next to the other cross-cutting tokens.
//
// The flow: `plugins/ui-keybind`'s `setup` INSERTs its builder under `KEYBIND_TAB`; `buildSettingsPanel`
// reads the token and, if it is there, hands the builder a mount (the settings list it adds its entry
// button to, the empty panel container it fills, its action-id prefix, and how to open a sub-page). A build
// without the plugin has no token, so it has no tab, no entry button and no rubber band — which is the
// whole point of the split.
import { defineResource } from "../../core/data/resource";
import type { Entity, World } from "../../core/world";

/** What a tab builder gets: everything the settings panel owns and the tab must fit into. */
export interface KeybindTabMount {
  readonly world: World;
  /** The settings LIST panel, where the entry button belongs. */
  readonly settingsPanel: Entity;
  /** The (empty, hidden) sub-panel container the tab fills — part of the settings layout, so the caller
   *  spawns it and the tab only adds children. */
  readonly panel: Entity;
  /** The settings-list row that opens this tab, when the caller already made one (the ui lane's PAGE HOST
   *  does, P1.29). Absent = the tab spawns its own, which is what the pre-P1.29 wiring did. */
  readonly entry?: Entity;
  /** The caller's action-id prefix ("pause" | "main"): the two menus each build a settings panel. */
  readonly id: string;
  /** Open a settings sub-page (what a menu's `show()` does — it writes `UI_MODAL.settings`). */
  readonly show: (panel: "settings" | "keybind") => void;
  readonly log: (line: string) => void;
}

/** What the caller keeps: the containers it has to hand to the systems that paint them. */
export interface KeybindTabSurfaces {
  /** The tab's own panel — the nav painter shows it when `UI_MODAL.settings` is "keybind". */
  readonly panel: Entity;
  /** The entry button, spawned hidden: `ui.keybind` is what shows it while the plugin is installed. */
  readonly entry: Entity;
}

export type KeybindTabBuilder = (mount: KeybindTabMount) => KeybindTabSurfaces;

/** The builder, inserted by `plugins/ui-keybind`'s `setup` and read by the settings panel. */
export const KEYBIND_TAB = defineResource<KeybindTabBuilder>("keybindTab");
