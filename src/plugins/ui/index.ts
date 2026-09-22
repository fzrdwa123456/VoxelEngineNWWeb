// ===== Plugin: ui =====
// The widget layer: the ten ui-lane systems, the widget component schemas and prefabs, and every resource
// the reconciler and the panels read. It owns the ONE DOM writer (`systems/reconcile.ts`) and the views
// that spawn the trees (`views/`).
import { SLOT_COMMANDS, SLOT_COMPONENTS, SLOT_RESOURCES } from "../../core/extension/slots";
import { definePlugin } from "../../core/plugin/descriptor";
import { SetFpsCap, SetLoadingStage, ShowToast } from "../../core/effect/commands";
import { UI_THEME } from "../../data/assets/theme";
import { UI_ACTIONS } from "../../data/globals/actions";
import { UI_MOUNT } from "../../data/globals/gfx";
import { UI_PAINT } from "../../data/globals/paint";
import {
  DELAYED_INTENTS,
  F3_PANEL,
  FONT,
  INVENTORY_WIDGETS,
  KEY_EVENTS,
  LOADING_STATE,
  LOCALE,
  PICKER_STATE,
  TOAST,
  UI_MODAL,
  UI_SCALE,
  VIEWPORT,
} from "../../data/globals/resources";
import { UI_SOURCES } from "../../data/globals/sources";
import {
  UI_ACTION,
  UI_BIND,
  UI_IMAGE,
  UI_INPUT,
  UI_LAYOUT,
  UI_LOOK,
  UI_ORDER,
  UI_STATE,
  UI_TEXT,
  UI_TIP,
  UI_TREE,
} from "./components";

export const uiPlugin = definePlugin({
  id: "ui",
  deps: ["player", "render"],
  setup(api) {
    api.contribute(SLOT_COMPONENTS, [
      UI_TREE, UI_TEXT, UI_LOOK, UI_STATE, UI_ACTION, UI_INPUT, UI_LAYOUT, UI_IMAGE, UI_TIP, UI_BIND,
    ]);
    api.contribute(SLOT_RESOURCES, [
      UI_MOUNT, UI_PAINT, UI_THEME, UI_ACTIONS, UI_SOURCES, UI_ORDER, UI_MODAL, UI_SCALE, LOCALE, FONT,
      TOAST, PICKER_STATE, LOADING_STATE, DELAYED_INTENTS, INVENTORY_WIDGETS, F3_PANEL, KEY_EVENTS,
      VIEWPORT,
    ]);
    api.contribute(SLOT_COMMANDS, [ShowToast, SetLoadingStage, SetFpsCap]);
  },
});
