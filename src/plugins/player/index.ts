// ===== Plugin: player =====
// The locally driven body: the component schemas it owns, the resources its systems read, the commands
// that may move it, and (in `boot/main.ts`, tagged with this id) the six fixed-lane systems.
//
// NOTE (P1.18b): the SYSTEMS are still constructed and registered by the composition root, because their
// construction needs the injected wiring (the input system's log sink, the interaction's UI callbacks).
// What this file owns today is the DECLARATION — which components/resources/commands exist because this
// plugin exists — and the id the manifest and the schedule report know it by.
import { SLOT_COMMANDS, SLOT_COMPONENTS, SLOT_RESOURCES } from "../../core/extension/slots";
import { definePlugin } from "../../core/plugin/descriptor";
import { SelectSlot, SwapSlots, Teleport } from "../../core/effect/commands";
import {
  INPUT_DIAGNOSTICS,
  INPUT_INTENTS,
  INPUT_STATE,
  INPUT_TIMING,
  LOCAL_PLAYER,
  POINTER,
} from "../../data/globals/resources";
import {
  BODY,
  CONTROL,
  INTERACTION,
  INVENTORY,
  MOTION,
  ORIENTATION,
  PLAYER,
  POSITION,
  PREV_POSITION,
  REACH,
  TARGET_HIT,
  VIEW,
} from "./components";

export const playerPlugin = definePlugin({
  id: "player",
  deps: ["world"],
  setup(api) {
    api.contribute(SLOT_COMPONENTS, [
      POSITION, PREV_POSITION, ORIENTATION, VIEW, MOTION, CONTROL, BODY, REACH, INTERACTION, INVENTORY,
      PLAYER, TARGET_HIT,
    ]);
    api.contribute(SLOT_RESOURCES, [LOCAL_PLAYER, INPUT_STATE, INPUT_TIMING, INPUT_INTENTS, INPUT_DIAGNOSTICS, POINTER]);
    api.contribute(SLOT_COMMANDS, [Teleport, SelectSlot, SwapSlots]);
  },
});
