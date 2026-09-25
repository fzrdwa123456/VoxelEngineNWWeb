// ===== Plugin: ui-toast =====
// The HUD message: it was the last optional surface in `ui` that needs no mount, which makes it the one
// that can be installed AND uninstalled at runtime in both directions (P1.27 step 2). The message itself was
// already DATA + a system (`TOAST` holds an i18n key or a raw string and a wall-clock deadline, armed by the
// ShowToast command); this moves the OWNERSHIP of that system and of the two widgets to the plugin.
import { SLOT_RESOURCES } from "../../core/extension/slots";
import { definePlugin } from "../../core/plugin/descriptor";
import type { Plugin } from "../../core/plugin/descriptor";
import type { PluginApi } from "../../core/plugin/api";
import { TOAST, createToastState } from "../../data/globals/resources";
import { UI_TOAST_ACCESS, UiToastSystem } from "./systems/toast";
import { spawnToastPanel } from "./views/toast";

/** Pass-through factory: the root builds the instance (it owns the widget handles), the plugin owns what it
 *  is and where it runs. */
export function createToastSystem(...args: ConstructorParameters<typeof UiToastSystem>): UiToastSystem {
  return new UiToastSystem(...args);
}

export { spawnToastPanel } from "./views/toast";

export interface UiToastSystems {
  /** `step()` is the lane's; `close()` is the LIFECYCLE's (the teardown takes the panel down). */
  readonly uiToast: { step(): void; close(): void };
}

export function declareUiToastSystems(api: PluginApi, s: UiToastSystems): void {
  api.system({
    // The HUD message. It writes UI_STATE/UI_TEXT on its OWN two widgets, so its order against the other
    // widget writers has to be declared — and it is declared against the CORE'S SLOT GAPS (P1.27/P1.42), never
    // against another optional surface's system: that name would dangle the moment that plugin is off.
    name: "ui.toast",
    stage: "ui",
    after: ["ui.slot.toast"],
    before: ["ui.slot.keybind"],
    ...UI_TOAST_ACCESS,
    run: () => s.uiToast.step(),
  });
}

export function createUiToastPlugin(s: UiToastSystems): Plugin {
  return definePlugin({
    id: "ui-toast",
    // It writes the widget components the ui plugin owns and is painted by its reconciler.
    deps: ["ui"],
    setup(api) {
      // The message and its deadline are this surface's state, so the plugin owns the resource too: inserted
      // here when the world has not got it (`api.insertResource` is once-semantics, so a re-install keeps the
      // object and boot and hot-plug stay one code path) — exactly like ui-debug's picker state.
      api.insertResource(TOAST, createToastState());
      api.contribute(SLOT_RESOURCES, [TOAST]);
      declareUiToastSystems(api, s);
      // LEAVE NOTHING BEHIND (P1.39): the panel's teardown is filed next to the surface, and the framework
      // runs it on both leave paths (an uninstall, and quitting), in reverse order, exactly once.
      api.onStop(() => s.uiToast.close());
    },
  });
}
