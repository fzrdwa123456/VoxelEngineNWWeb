// ===== Plugin: ui-keybind =====
// The key bind PAGE: the system that DERIVES the bind panels from the bind table (chips, keycap legends,
// the hover highlight and the rubber band's geometry) and that APPLIES the rebind decisions the device
// layer queued. Split out of `ui` (P1.25) so that a build without it has no key bind page at all — and so
// that it can be plugged in and out at runtime like `ui-debug` (`data/globals/hotplug.ts`).
//
// WHAT STAYED IN `ui`, and why: the page's WIDGETS are built by `views/menu.ts` (the settings panel is ONE
// layout with four tabs; the drag's event-time half, the click-synthesis arm paths and the hit test are
// wiring that belongs to that view). What moved is the BEHAVIOUR — and with it the way IN: the entry
// buttons are spawned invisible and only this system shows them, so "the plugin is off" means the tab is
// not reachable, from either menu.
import { SLOT_RESOURCES } from "../../core/extension/slots";
import { definePlugin } from "../../core/plugin/descriptor";
import type { Plugin } from "../../core/plugin/descriptor";
import type { PluginApi } from "../../core/plugin/api";
import type { Entity } from "../../core/world";
import { SLOT_UI_PAGES } from "../../core/extension/slots";
import type { UiPage } from "../../data/globals/ui-pages";
import { UI_KEYBIND_ACCESS, UiKeybindSystem } from "./systems/keybind";
import { clearKeybindPanels } from "../../data/globals/keybind-gesture";
import { rebindKeybindDrag, spawnKeybindPanel, unbindKeybindDrag } from "./views/keybind";

/** Pass-through factory: the composition root builds the instance (it needs the bind table, the rubber
 *  band widget and the entry buttons), the plugin owns what it IS and where it runs. */
export function createKeybindSystem(...args: ConstructorParameters<typeof UiKeybindSystem>): UiKeybindSystem {
  return new UiKeybindSystem(...args);
}

export interface UiKeybindSystems {
  /** `step()` is the lane's; `close()` is the LIFECYCLE's (an uninstall takes the way in away). */
  readonly uiKeybind: { step(): void; close(): void };
}

export function declareUiKeybindSystems(api: PluginApi, s: UiKeybindSystems): void {
  api.system({
    // The bind panels + the drag presentation. It writes widget data (UI_STATE/UI_TEXT/UI_LAYOUT) on the
    // same COMPONENTS as ui.toast / ui.navigation on different entities, so the order has to be declared:
    // it follows the toast and precedes the painter and the reconciler.
    name: "ui.keybind",
    stage: "ui",
    after: ["ui.slot.keybind"],
    // The edges that used to name `ui.toast`/`ui.navigation`/`ui.widgets` are the core's anchors now (P1.27):
    // a surface may only be ordered against systems that EXIST whatever else is turned off.
    before: ["ui.navigation"],
    ...UI_KEYBIND_ACCESS,
    run: () => s.uiKeybind.step(),
  });
}

export function createUiKeybindPlugin(s: UiKeybindSystems, entries: Entity[]): Plugin {
  const mine: Entity[] = [];
  const keybindPage: UiPage = {
    id: "keybind",
    section: "settings",
    order: 40,
    titleKey: "settings.keybinds",
    build(mount) {
      // `build` runs at a BARRIER (inside the host's mount command), which is why it may spawn at all.
      mine.push(mount.entry);
      entries.push(mount.entry);
      spawnKeybindPanel({
        world: mount.host.world,
        settingsPanel: mount.host.settingsPanel,
        panel: mount.panel,
        entry: mount.entry,
        id: mount.host.id,
        show: (page) => mount.host.show(page),
        log: mount.host.log,
      });
    },
    dispose() {
      // The widgets in the page and its entry are despawned by the host; what this must undo is the GLOBAL
      // registrations the build made (the derived-panel specs) and the entry handles the system still holds.
      clearKeybindPanels();
      for (const e of mine) {
        const at = entries.indexOf(e);
        if (at >= 0) entries.splice(at, 1);
      }
      mine.length = 0;
    },
  };
  return definePlugin({
    id: "ui-keybind",
    // It renders into the settings panel the ui plugin's views build, and it reads the widget components the
    // ui plugin owns: without the widget layer there is no page to fill.
    // `input` is a REAL dependency: the bind table lives there (plugins/input/keybinds.ts) and this
    // plugin's view reads it to draw the chips and to apply a captured key.
    deps: ["ui", "input"],
    setup(api) {
      // THE PAGE IS DATA NOW (P1.29): the host system materializes it wherever a container was registered, so
      // this plugin no longer needs the settings panel to ask it for a tab — and a plugin installed at RUNTIME
      // gets its page (and its entry row) within a frame.
      api.contribute(SLOT_UI_PAGES, [keybindPage]);
      // The drag's document listeners follow the plugin's lifetime (see views/keybind.ts).
      rebindKeybindDrag();
      declareUiKeybindSystems(api, s);
    },
    // The page goes down with the plugin (see UiKeybindSystem.close()).
    stop() {
      s.uiKeybind.close();
      // …and its device listeners go with it.
      unbindKeybindDrag();
    },
  });
}
