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
import { KEYBIND_TAB } from "../../data/globals/keybind-tab";
import { UI_KEYBIND_ACCESS, UiKeybindSystem } from "./systems/keybind";
import { spawnKeybindPanel } from "./views/keybind";

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
    after: ["ui.toast"],
    // These two edges used to live on the OTHER side (`ui.navigation` said `after: ["ui.keybind"]`, and
    // `ui.widgets` listed it). A disabled plugin must not leave a dangling name in another plugin's order
    // list, so they are declared here — see P1.23's note in ROADMAP.md.
    before: ["ui.navigation", "ui.widgets"],
    ...UI_KEYBIND_ACCESS,
    run: () => s.uiKeybind.step(),
  });
}

export function createUiKeybindPlugin(s: UiKeybindSystems): Plugin {
  return definePlugin({
    id: "ui-keybind",
    // It renders into the settings panel the ui plugin's views build, and it reads the widget components the
    // ui plugin owns: without the widget layer there is no page to fill.
    // `input` is a REAL dependency: the bind table lives there (plugins/input/keybinds.ts) and this
    // plugin's view reads it to draw the chips and to apply a captured key.
    deps: ["ui", "input"],
    setup(api) {
      // The tab's WIDGETS are this plugin's too (views/keybind.ts). The settings panel asks for them
      // through the KEYBIND_TAB resource: inserted here — install time, i.e. before the views are wired —
      // so a build without this plugin has no tab at all; contributed so the registry reports its owner.
      if (!api.world.hasResource(KEYBIND_TAB)) api.world.insertResource(KEYBIND_TAB, spawnKeybindPanel);
      api.contribute(SLOT_RESOURCES, [KEYBIND_TAB]);
      declareUiKeybindSystems(api, s);
    },
    // The page goes down with the plugin (see UiKeybindSystem.close()).
    stop() {
      s.uiKeybind.close();
    },
  });
}
