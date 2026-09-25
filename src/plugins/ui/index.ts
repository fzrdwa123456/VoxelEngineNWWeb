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
import { UiLoadingSystem } from "./systems/loading";
import { UiHudSystem } from "./systems/hud";
import { UiNavigationSystem } from "./systems/navigation";
import { DelaySystem } from "./systems/delays";
import { UiPagesSystem } from "./systems/ui-pages";
import { Menu, type MenuCallbacks } from "./views/menu";
import { MainMenu, type MainMenuCallbacks } from "./views/mainmenu";
import { LoadingScreen } from "./views/loading";
// The ACCESS sets the ten systems declare. They live next to each system (that is where a reader looks for
// "what does this touch"), and the plugin is the module that now assembles them into the schedule.
import { UI_BINDING_ACCESS } from "./systems/bindings";
import { UI_PAGES_ACCESS } from "./systems/ui-pages";
import { DELAYS_ACCESS } from "./systems/delays";
import { UI_HUD_ACCESS } from "./systems/hud";
import { UI_LOADING_ACCESS } from "./systems/loading";
import { UI_NAVIGATION_ACCESS } from "./systems/navigation";
import { UI_RENDER_ACCESS } from "./systems/reconcile";
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

export function createLoadingSystem(...args: ConstructorParameters<typeof UiLoadingSystem>): UiLoadingSystem {
  return new UiLoadingSystem(...args);
}

export function createHudSystem(...args: ConstructorParameters<typeof UiHudSystem>): UiHudSystem {
  return new UiHudSystem(...args);
}

export function createNavigationSystem(...args: ConstructorParameters<typeof UiNavigationSystem>): UiNavigationSystem {
  return new UiNavigationSystem(...args);
}

/** The page HOST (P1.29): pass-through like the others — the root builds it, the plugin owns it. */
export function createPagesSystem(...args: ConstructorParameters<typeof UiPagesSystem>): UiPagesSystem {
  return new UiPagesSystem(...args);
}

export function createDelaySystem(...args: ConstructorParameters<typeof DelaySystem>): DelaySystem {
  return new DelaySystem(...args);
}

export interface UiSystems {
  readonly uiHud: { step(): void };
  readonly uiLoading: { step(): void };
  readonly uiBindings: { step(): void };
  readonly navigation: { step(): void };
  readonly delays: { step(): void };
  readonly uiRender: { step(): void };
  readonly uiPages: { step(): void };
}

export function declareUiSystems(api: PluginApi, s: UiSystems): void {
  api.system({
  // THE PAGE HOST (P1.29): the first system of the lane, because it decides what the settings panel IS made
  // of (it materializes pages contributed by plugins through a command) and it paints its own two widgets.
  // It touches no component another system writes, so it conflicts with nothing and batches early.
  name: "ui.pages",
  stage: "ui",
  reads: [],
  writes: [],
  ...UI_PAGES_ACCESS,
  run: () => s.uiPages.step(),
  });
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
  before: ["ui.slot.bag"],
  ...UI_LOADING_ACCESS,
  run: () => s.uiLoading.step(),
  });
  api.system({
  // Bound widget values (a slider that shows shared state), resolved before the reconciler reads them.
  // It writes UI_INPUT only, so it shares a batch with ui.inventory (disjoint components).
  name: "ui.bindings",
  stage: "ui",
  ...UI_BINDING_ACCESS,
  run: () => s.uiBindings.step(),
  });
  // ===== The optional ui surfaces' SLOT ANCHORS (P1.27, extended in P1.31) =====
  // A surface that may be DISABLED cannot be named in another surface's order list: the name would dangle
  // the moment that plugin is turned off, and the boot refuses an unknown name. But two widget WRITERS still
  // have to be ordered (the conflict model is per COMPONENT, not per entity), so the order needs something
  // that ALWAYS exists. These four GAPS are it (P1.27; a real scheduler concept since P1.42): named places
  // among themselves and to the core's own writers. Each optional surface declares "after the anchor before
  // it, before its own anchor", so any subset of them is totally ordered and no surface ever names another.
  //
  // owned by the CORE, one per optional slot. A gap has NO access and NO run: what splits a batch is the
  // declared EDGE, which the batcher honours even between two systems that share no data at all.
  api.system({
  name: "ui.slot.bag",
  stage: "ui",
  after: ["ui.loading"],
  before: ["ui.slot.debug"],
  gap: true,
  // (no run: a GAP is a place in the order, not a worker — P1.42)
  });
  api.system({
  // THE BAG SLOT (P1.31): the inventory layer became an OPTIONAL plugin, and the anchors used to name its
  // system ("ui.inventory") — a name that would dangle the moment that plugin is off. This anchor is the
  // core-owned thing both the bag and the picker order against instead.
  name: "ui.slot.debug",
  stage: "ui",
  after: ["ui.slot.bag"],
  before: ["ui.slot.toast"],
  gap: true,
  // (no run: a GAP is a place in the order, not a worker — P1.42)
  });
  api.system({
  name: "ui.slot.toast",
  stage: "ui",
  after: ["ui.slot.debug"],
  before: ["ui.slot.keybind"],
  gap: true,
  // (no run: a GAP is a place in the order, not a worker — P1.42)
  });
  api.system({
  name: "ui.slot.keybind",
  stage: "ui",
  after: ["ui.slot.toast"],
  before: ["ui.navigation"],
  gap: true,
  // (no run: a GAP is a place in the order, not a worker — P1.42)
  });
  api.system({
  name: "ui.navigation",
  stage: "ui",
  after: ["ui.slot.keybind"],
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
  after: ["ui.bindings", "ui.navigation"],
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
      LOADING_STATE, DELAYED_INTENTS, F3_PANEL, KEY_EVENTS,
      VIEWPORT,
    ]);
    api.contribute(SLOT_COMMANDS, [ShowToast, SetLoadingStage, SetFpsCap]);
  },
});
