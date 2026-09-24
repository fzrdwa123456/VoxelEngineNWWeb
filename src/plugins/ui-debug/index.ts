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
import { PICKER_STATE } from "../../data/globals/resources";
import { UI_PICKER_ACCESS, UiPickerSystem } from "./systems/picker";

/** Pass-through factory: the composition root builds the instance (it wraps the panel it spawned), and this
 *  plugin owns what the system IS. Same shape as the ten `create*System` factories in the ui plugin. */
export function createPickerSystem(...args: ConstructorParameters<typeof UiPickerSystem>): UiPickerSystem {
  return new UiPickerSystem(...args);
}

export { spawnPickerPanel } from "./systems/picker";

export interface UiDebugSystems {
  readonly uiPicker: { step(): void };
}

export function declareUiDebugSystems(api: PluginApi, s: UiDebugSystems): void {
  api.system({
    // The F3+F4 picker. It writes UI_STATE/UI_TEXT (the picker panel's items and the F3 panel's visibility),
    // and ui.inventory writes the same COMPONENTS on different entities — the conflict model is per component,
    // not per entity, so the order has to be declared. That is a pessimisation (they touch nothing of each
    // other's) and it costs the ui lane its only parallel pair.
    name: "ui.picker",
    stage: "ui",
    after: ["ui.inventory"],
    // The two edges that used to live in the ui plugin. `ui.toast` and `ui.widgets` conflict with this system
    // (same components, different entities), so a path has to exist — declared from THIS side it survives
    // disabling the plugin, from the other side it would not.
    before: ["ui.toast", "ui.widgets"],
    ...UI_PICKER_ACCESS,
    run: () => s.uiPicker.step(),
  });
}

export const uiDebugPlugin = definePlugin({
  id: "ui-debug",
  // The picker writes widget data (UI_STATE/UI_TEXT, through the ui plugin's components) and toggles the F3
  // panel the hud view spawns, so the ui plugin is a hard dependency: a debug surface without the widget layer
  // has nothing to draw into.
  deps: ["ui"],
  setup(api) {
    // The picker's open/sel/held-key state — it was the ui plugin's resource until the surface moved out.
    api.contribute(SLOT_RESOURCES, [PICKER_STATE]);
  },
});
