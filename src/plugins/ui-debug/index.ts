// ===== Plugin: ui-debug =====
// The F3 debug panel and the F3+F4 game-mode chord, split out of the `ui` plugin so that turning the DEBUG
// surface off is a manifest line (`plugins.json`) instead of a rebuild. It is the shape every other optional
// ui surface follows: the plugin owns its STATE (PICKER_STATE), the panel it toggles is spawned by the hud
// view it depends on, and it declares its own system here instead of inside `ui`.
//
// THE RULE THIS PLUGIN EXISTS TO DEMONSTRATE: an edge may never name a system that another plugin decides
// whether to install. `ui.toast` and `ui.widgets` used to name `ui.picker` in their own order lists, which
// would have become a dangling name the moment this plugin was disabled — so both edges are declared HERE,
// on the picker, and the ui plugin's own chain is complete without it (its toast follows its inventory, and
// the picker slips in between when it is installed).
import { SLOT_RESOURCES } from "../../core/extension/slots";
import { definePlugin } from "../../core/plugin/descriptor";
import type { PluginApi } from "../../core/plugin/api";
import { PICKER_STATE, createPickerState } from "../../data/globals/resources";
import type { Plugin } from "../../core/plugin/descriptor";
import { UI_PICKER_ACCESS, UiPickerSystem } from "./systems/picker";

/** Pass-through factory: the composition root builds the instance (it wraps the panel it spawned), and this
 *  plugin owns what the system IS. Same shape as the ten `create*System` factories in the ui plugin. */
export function createPickerSystem(...args: ConstructorParameters<typeof UiPickerSystem>): UiPickerSystem {
  return new UiPickerSystem(...args);
}

export { spawnPickerPanel } from "./systems/picker";

export interface UiDebugSystems {
  /** `step()` is the lane's entry point; `close()` is the LIFECYCLE's (the teardown closes the panels). */
  readonly uiPicker: { step(): void; close(): void };
}

export function declareUiDebugSystems(api: PluginApi, s: UiDebugSystems): void {
  api.system({
    // The F3+F4 picker. It writes UI_STATE/UI_TEXT (the picker panel's items and the F3 panel's visibility),
    // and ui.inventory writes the same COMPONENTS on different entities — the conflict model is per component,
    // not per entity, so the order has to be declared. That is a pessimisation (they touch nothing of each
    // other's) and it costs the ui lane its only parallel pair.
    name: "ui.picker",
    stage: "ui",
    after: ["ui.slot.debug"],
    // The slot GAP replaces the edges that used to name `ui.toast`/`ui.widgets` (P1.27; a real scheduler
    // concept since P1.42): a system another OPTIONAL plugin owns must never appear here, and the core's gap
    // gives the same total order while surviving any subset of surfaces being disabled.
    before: ["ui.slot.toast"],
    ...UI_PICKER_ACCESS,
    run: () => s.uiPicker.step(),
  });
}

/** The plugin, built around the system the ROOT constructed (it wraps the panel the hud view spawned).
 *
 *  A FACTORY rather than a constant, and that is exactly what makes this surface HOT-PLUGGABLE: everything
 *  the plugin needs is either in the instances handed to it or in the world, so its `setup` alone is enough
 *  to install it — at boot AND at runtime (`core/plugin/hotplug.ts`). It also OWNS its resource: the boot
 *  table inserts PICKER_STATE for the ordinary case, and a runtime install inserts it here when the world no
 *  longer has it (`api.insertResource` is once-semantics, so boot and hot-plug are one code path). */
export function createUiDebugPlugin(s: UiDebugSystems): Plugin {
  return definePlugin({
    id: "ui-debug",
    // The picker writes widget data (UI_STATE/UI_TEXT, through the ui plugin's components) and toggles the F3
    // panel the hud view spawns, so the ui plugin is a hard dependency: a debug surface without the widget
    // layer has nothing to draw into.
    deps: ["ui"],
    setup(api) {
      api.insertResource(PICKER_STATE, createPickerState());
      api.contribute(SLOT_RESOURCES, [PICKER_STATE]);
      declareUiDebugSystems(api, s);
      // LEAVE NOTHING BEHIND (P1.39): the picker's teardown is filed HERE, next to the surface it closes,
      // instead of in a `stop` hook that has to remember every surface the plugin owns. The framework runs it
      // at the barrier on BOTH leave paths — an uninstall, and quitting — in reverse order, exactly once.
      api.onStop(() => s.uiPicker.close());
    },
  });
}
