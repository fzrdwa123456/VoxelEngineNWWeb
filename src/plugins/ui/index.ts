// ===== Plugin: ui =====
// The widget layer: the ten ui-lane systems, the widget component schemas and prefabs, and every resource
// the reconciler and the panels read. It owns the ONE DOM writer (`systems/reconcile.ts`) and the views
// that spawn the trees (`views/`).
import { SLOT_COMMANDS, SLOT_COMPONENTS, SLOT_RESOURCES } from "../../core/extension/slots";
import { definePlugin } from "../../core/plugin/descriptor";
import type { PluginApi } from "../../core/plugin/api";
import type { Entity, World } from "../../core/world";
import { Hud } from "./views/hud";
import { UiRenderSystem } from "./systems/reconcile";
import { UiBindingSystem } from "./systems/bindings";
import { UiPickerSystem } from "./systems/picker";
import { UiToastSystem } from "./systems/toast";
import { UiLoadingSystem } from "./systems/loading";
import { UiKeybindSystem } from "./systems/keybind";
import { UiInventorySystem } from "./systems/inventory";
import { UiHudSystem } from "./systems/hud";
import { UiNavigationSystem } from "./systems/navigation";
import { DelaySystem } from "./systems/delays";
import { Inventory } from "./views/inventory";
import { Menu, type MenuCallbacks } from "./views/menu";
import { MainMenu, type MainMenuCallbacks } from "./views/mainmenu";
import { LoadingScreen } from "./views/loading";
// The ACCESS sets the ten systems declare. They live next to each system (that is where a reader looks for
// "what does this touch"), and the plugin is the module that now assembles them into the schedule.
import { UI_BINDING_ACCESS } from "./systems/bindings";
import { DELAYS_ACCESS } from "./systems/delays";
import { UI_HUD_ACCESS } from "./systems/hud";
import { INVENTORY_VIEW_ACCESS } from "./systems/inventory";
import { UI_KEYBIND_ACCESS } from "./systems/keybind";
import { UI_LOADING_ACCESS } from "./systems/loading";
import { UI_NAVIGATION_ACCESS } from "./systems/navigation";
import { UI_PICKER_ACCESS } from "./systems/picker";
import { UI_RENDER_ACCESS } from "./systems/reconcile";
import { UI_TOAST_ACCESS } from "./systems/toast";
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

/** The ten ui-lane systems, as the PLUGIN knows them: their stage, their edges and what they read and
 *  write. The instances come from the root (each wraps a view the root builds), but the DECLARATION — the
 *  part the architecture cares about — lives here. */
/** The two views this plugin constructs itself (they need nothing but the world). The root keeps the
 *  handles: the toast's panel, the loading screen's stage entities and the F3 panel come from `hud`. */
export interface UiViews {
  readonly hud: Hud;
  readonly loadingScreen: LoadingScreen;
}

export function createUiViews(world: World): UiViews {
  return { hud: new Hud(world), loadingScreen: new LoadingScreen(world) };
}

/** The three views whose construction needs wiring the root assembles (the player handle, and the panels'
 *  callbacks). The root still decides WHEN they are built — the resource order around them is load-bearing
 *  — but the plugin owns what they ARE and how they are constructed. */
export function createInventoryView(world: World, player: Entity): Inventory {
  return new Inventory(world, player);
}

export function createPauseMenu(world: World, cb: MenuCallbacks): Menu {
  return new Menu(world, cb);
}

export function createMainMenu(world: World, cb: MainMenuCallbacks): MainMenu {
  return new MainMenu(world, cb);
}

/** One pass-through factory per ui system. The ROOT still assembles every dependency (that is the wiring,
 *  and where it is built relative to the resource table is load-bearing), but the plugin is the module that
 *  knows these classes exist — a new ui system is registered here now. */
export function createRenderSystem(...args: ConstructorParameters<typeof UiRenderSystem>): UiRenderSystem {
  return new UiRenderSystem(...args);
}

export function createBindingSystem(...args: ConstructorParameters<typeof UiBindingSystem>): UiBindingSystem {
  return new UiBindingSystem(...args);
}

export function createPickerSystem(...args: ConstructorParameters<typeof UiPickerSystem>): UiPickerSystem {
  return new UiPickerSystem(...args);
}

export function createToastSystem(...args: ConstructorParameters<typeof UiToastSystem>): UiToastSystem {
  return new UiToastSystem(...args);
}

export function createLoadingSystem(...args: ConstructorParameters<typeof UiLoadingSystem>): UiLoadingSystem {
  return new UiLoadingSystem(...args);
}

export function createKeybindSystem(...args: ConstructorParameters<typeof UiKeybindSystem>): UiKeybindSystem {
  return new UiKeybindSystem(...args);
}

export function createInventorySystem(...args: ConstructorParameters<typeof UiInventorySystem>): UiInventorySystem {
  return new UiInventorySystem(...args);
}

export function createHudSystem(...args: ConstructorParameters<typeof UiHudSystem>): UiHudSystem {
  return new UiHudSystem(...args);
}

export function createNavigationSystem(...args: ConstructorParameters<typeof UiNavigationSystem>): UiNavigationSystem {
  return new UiNavigationSystem(...args);
}

export function createDelaySystem(...args: ConstructorParameters<typeof DelaySystem>): DelaySystem {
  return new DelaySystem(...args);
}

export interface UiSystems {
  readonly uiHud: { step(): void };
  readonly uiLoading: { step(): void };
  readonly uiInventory: { step(): void };
  readonly uiBindings: { step(): void };
  readonly uiPicker: { step(): void };
  readonly uiToast: { step(): void };
  readonly uiKeybind: { step(): void };
  readonly navigation: { step(): void };
  readonly delays: { step(): void };
  readonly uiRender: { step(): void };
}

export function declareUiSystems(api: PluginApi, s: UiSystems): void {
  api.system({
  // The GAMEPLAY widgets' gate, FIRST in the lane: it decides whether the crosshair and the hotbar are
  // on screen at all, and it writes the same component (UI_STATE) as every writer after it, so the
  // conflict rule demands an order — this is the honest one ("what may the lane show" comes first). It
  // shares the first batch with ui.bindings: that pair touches disjoint components (UI_INPUT vs
  // UI_STATE) and may therefore run in either order.
  name: "ui.hud",
  stage: "ui",
  before: ["ui.loading"],
  ...UI_HUD_ACCESS,
  run: () => s.uiHud.step(),
  });
  api.system({
  // The loading screen (the startup, and a world entry). Registered right after the gameplay gate and
  // before the other widget-data writers: it writes the same components (UI_STATE / UI_TEXT) as all of
  // them, so the conflict rule demands an order and the honest one is "the loading screen is painted
  // before the surfaces it hides behind it".
  name: "ui.loading",
  stage: "ui",
  before: ["ui.inventory"],
  ...UI_LOADING_ACCESS,
  run: () => s.uiLoading.step(),
  });
  api.system({
  name: "ui.inventory",
  stage: "ui",
  ...INVENTORY_VIEW_ACCESS,
  run: () => s.uiInventory.step(),
  });
  api.system({
  // Bound widget values (a slider that shows shared state), resolved before the reconciler reads them.
  // It writes UI_INPUT only, so it shares a batch with ui.inventory (disjoint components).
  name: "ui.bindings",
  stage: "ui",
  ...UI_BINDING_ACCESS,
  run: () => s.uiBindings.step(),
  });
  api.system({
  // The F3+F4 picker. It writes UI_STATE/UI_TEXT (the picker panel's items and the F3 panel's
  // visibility), and ui.inventory writes the same COMPONENTS on different entities — the conflict model
  // is per component, not per entity, so the order has to be declared. That is a pessimisation (they
  // touch nothing of each other's) and it costs the ui lane its only parallel pair.
  name: "ui.picker",
  stage: "ui",
  after: ["ui.inventory"],
  ...UI_PICKER_ACCESS,
  run: () => s.uiPicker.step(),
  });
  api.system({
  // The HUD toast: same component-level conflict as ui.picker, so it follows it. It is the reason the
  // ui lane is pumped while the game loop is stopped (a main-menu toast has no frame to ride).
  name: "ui.toast",
  stage: "ui",
  after: ["ui.picker"],
  ...UI_TOAST_ACCESS,
  run: () => s.uiToast.step(),
  });
  api.system({
  // The bind panels (derived data) and the drag highlight/rubber band, ordered after the other widget
  // writers by the same component-level rule.
  name: "ui.keybind",
  stage: "ui",
  after: ["ui.toast"],
  ...UI_KEYBIND_ACCESS,
  run: () => s.uiKeybind.step(),
  });
  api.system({
  name: "ui.navigation",
  stage: "ui",
  after: ["ui.keybind"],
  ...UI_NAVIGATION_ACCESS,
  run: () => s.navigation.step(),
  });
  api.system({
  name: "ui.delays",
  stage: "ui",
  after: ["ui.navigation"],
  before: ["ui.widgets"],
  ...DELAYS_ACCESS,
  run: () => s.delays.step(),
  });
  api.system({
  // Ordered by a REAL dependency: every system above WRITES widget data (icons, counts, the selected
  // flag, slider values, the picker, the toast, the chips/keycaps, the modal trees) and this one reads
  // all of it before reconciling the elements. Stage order runs the ui lane after the render lane, which
  // is the other half of the guarantee: everything `diagnostics` wrote this frame is already in place.
  name: "ui.widgets",
  stage: "ui",
  after: ["ui.inventory", "ui.bindings", "ui.picker", "ui.toast", "ui.keybind", "ui.navigation"],
  ...UI_RENDER_ACCESS,
  run: () => s.uiRender.step(),
  });
}

export const uiPlugin = definePlugin({
  id: "ui",
  deps: ["player", "input"],
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
