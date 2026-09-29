// ===== ui, as a DISCOVERED plugin (P1.18b) =====
// The last core plugin to leave the composition root, and the one with the most wiring to narrow. It CONSTRUCTS
// its seven ui-lane systems and declares them from its own `setup`; `declareUiSystems` used to be called by the
// root with an api it fetched out of the install outcome (and the note it printed when the plugin was missing
// lived there too).
//
// WHAT IT NEEDS FROM THE ROOT, and why each one is an instance rather than an import:
//
//   * `registry` — the page host and the HUD host read what OTHER plugins contributed (`SLOT_UI_PAGES`,
//     `SLOT_UI_HUD`). The registry belongs to the framework, not to a plugin, so it arrives by name.
//   * `loadingScreen` — a VIEW. Views stay root-spawned on purpose: spawning is a structural change, so it
//     happens at the point in the resource table the root decides (the screen's tree has to exist before the
//     first `renderUi()`).
//   * `lock` — the native mouse capture is a `host/` object, which a plugin may not import. It wraps the one
//     `PointerLock` instance the root owns.
//   * `uiTrees` — a BOX the root fills once the menus exist (they are built after the install: their callbacks
//     close over the world-entry driver). `ui.navigation` reads it through a getter, never at construction.
//   * `inventoryOn`, `cancelDrag` — closures over two things a plugin may not see: the live plugin set (the
//     framework's) and ANOTHER OPTIONAL PLUGIN's view. `ui-keybind` cannot be a hard dependency: it is
//     hot-pluggable, and a dep (or an edge) on a surface that may be uninstalled is exactly what the core's
//     slot anchors exist to avoid.
//
// The reverse direction is `UI_HANDLES`: the reconciler owns every widget's element, so the bind gesture's drag
// (wired by the root, in `plugins/ui-keybind/views/keybind.ts`) asks it what is under the cursor.
//
// `hot: false`: the ui plugin owns the loading screen and the modal trees. It is REMOVABLE in the mechanical
// sense (the root logs and carries on when it is gone), but a window with no reconciler is a blank window, so
// it is a manifest decision, not a key.
import type { DiscoveredPlugin, PluginHost } from "../../core/plugin/host";
import type { ExtensionRegistry } from "../../core/extension/registry";
import type { World } from "../../core/world";
import { SLOT_UI_HUD, SLOT_UI_PAGES } from "../../core/extension/slots";
import { UI_HANDLES } from "../../data/globals/ui-handles";
import { PLAYER_HANDLES } from "../../data/globals/player-handles";
import { DELAYED_INTENTS } from "../../data/globals/resources";
import { KEYBIND_GESTURE } from "../../data/globals/keybind-gesture";
import { t } from "../../data/assets/i18n";
import { currentFontCss } from "../../data/globals/fonts";
import { currentRootFontPx } from "../../data/globals/uiscale";
import { getBind, isCapturing } from "../input/keybinds";
import {
  createBindingSystem,
  createDelaySystem,
  createHudSystem,
  createLoadingSystem,
  createNavigationSystem,
  createPagesSystem,
  createRenderSystem,
  declareUiSystems,
  uiPlugin,
  type UiSystems,
} from "./index";
import type { NavigationTrees } from "./systems/navigation";
import type { LoadingScreen } from "./views/loading";

/** The instances the root publishes for this plugin, narrowed HERE (the host itself models none of them). */
interface UiHostInstances {
  registry: ExtensionRegistry;
  loadingScreen: LoadingScreen;
  /** The native capture, as `ui.navigation` and `ui.delays` drive it (a `host/` object). */
  lock: {
    relock(reason: string): void;
    retry(reason: string): void;
    reassertCursor(reason: string): void;
    applyCursor(): void;
  };
  /** Filled by the root once the menus exist. Read every frame, never at construction. */
  uiTrees: { trees: NavigationTrees | null };
  /** "Is the inventory layer installed right now?" — the live plugin set belongs to the framework. */
  inventoryOn: () => boolean;
  /** The bind drag's cancellation — a `ui-keybind` view, which may not be a hard dependency. */
  cancelDrag: (reason: string) => void;
}

export function createPlugin(host: PluginHost): DiscoveredPlugin {
  const world: World = host.world;
  const i = host.instances as unknown as UiHostInstances;
  const log = host.log;
  /** The player's input system, published by the player plugin. Read when a DECISION is taken, not now. */
  const playerInput = () => world.resource(PLAYER_HANDLES).input;

  // The reconciler also serves the bind drag (`hitTest`), so its instance is kept to be published.
  const uiRender = createRenderSystem(world, {
    translate: t,
    fontCss: currentFontCss,
    rootFontPx: currentRootFontPx,
    log,
  });
  const s: UiSystems = {
    uiRender,
    uiBindings: createBindingSystem(world, log),
    // The page HOST: it materializes the pages other plugins contributed, so it reads the registry — lazily,
    // because those pages arrive during the very install this plugin is part of.
    uiPages: createPagesSystem(world, { pages: () => i.registry.list(SLOT_UI_PAGES) }),
    uiLoading: createLoadingSystem(world, i.loadingScreen),
    uiHud: createHudSystem(world, { elements: () => i.registry.list(SLOT_UI_HUD), log }),
    // The modal-surface decision-maker: ESC's ladder, the inventory key, the pointer-lock effects. Every
    // platform effect is injected, which is what keeps that module DOM-free.
    navigation: createNavigationSystem(world, {
      get trees(): NavigationTrees {
        if (!i.uiTrees.trees) throw new Error("ui: the modal trees were never wired (boot order)");
        return i.uiTrees.trees;
      },
      inventoryCode: () => getBind("inventory"),
      inventoryOn: i.inventoryOn,
      capturing: isCapturing,
      inWorld: host.inWorld,
      prepareUnlock: () => playerInput().prepareUnlock(),
      dragging: () => world.resource(KEYBIND_GESTURE).drag !== null,
      cancelDrag: i.cancelDrag,
      releaseCapture: () => playerInput().releaseCapture(),
      relock: (reason) => i.lock.relock(reason),
      // "Relock, but not in this key dispatch": the DEADLINE goes into the world and `ui.delays` applies it.
      relockSoon: (reason) => world.resource(DELAYED_INTENTS).schedule("relock", 0, reason),
      applyCursor: () => i.lock.applyCursor(),
      log,
    }),
    // Whatever deadline has passed is applied HERE — after the system that decided it, before the frame is
    // painted. Both halves of that order are forced: it writes the two targets `ui.navigation` writes, and the
    // reconciler has to stay the last system in the lane.
    delays: createDelaySystem(world, {
      relock: (reason) => i.lock.relock(reason),
      lockRetry: (reason) => i.lock.retry(reason),
      cursor: () => i.lock.reassertCursor("delayed"),
      log,
    }),
  };

  return {
    hot: false,
    plugin: {
      id: "ui",
      deps: uiPlugin.deps,
      setup(api) {
        // The widget schemas, the resources and the three commands this plugin owns (P1.18's statement).
        uiPlugin.setup(api);
        // …then the seven systems + the FOUR slot anchors + the page host, DECLARED here (P1.29/P1.42).
        declareUiSystems(api, s);
        // …and what the root drives: the reconciler, which owns the widget elements the bind drag hit-tests.
        api.insertResource(UI_HANDLES, { uiRender });
      },
    },
  };
}
