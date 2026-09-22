// ===== Plugin: input =====
// The device layer's data: the KEYMAP resource (the bind table four systems read every tick) and the
// KEYBIND_GESTURE resource (the rebind drag's state, which used to be a module-level `let`). The keybinds
// module owns the settings file and the validation; the gesture's event-time half lives in
// `plugins/input/bind-gesture.ts`.
import { SLOT_RESOURCES } from "../../core/extension/slots";
import { definePlugin } from "../../core/plugin/descriptor";
import { KEYBIND_GESTURE } from "../../data/globals/keybind-gesture";
import { KEYMAP } from "../../data/globals/resources";

export const inputPlugin = definePlugin({
  id: "input",
  deps: [],
  setup(api) {
    api.contribute(SLOT_RESOURCES, [KEYMAP, KEYBIND_GESTURE]);
  },
});
