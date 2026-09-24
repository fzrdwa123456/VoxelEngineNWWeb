import * as THREE from "three/webgpu";
import { World } from "../core/world";
import { CONTROL, HUMANOID_BODY, INVENTORY_SLOTS, spawnPlayer } from "../plugins/player/components";
import { createFont, createFrameCap, createFrameProbe, createInputDiagnostics, createInputIntentLog, createInputState, createInputTiming, createKeyEventLog, createKeyMap, createLocale, createLoopState, createPickerState, createScale, createToastState, createUiModalState, FRAME_PROBE, LOOP_STATE, type LoopMode, LOADING_STATE, createLoadingState, DEBUG_LOG, DELAYED_INTENTS, createDelayedIntents, F3_PANEL, FONT, FPS_CAP, INPUT_DIAGNOSTICS, INPUT_INTENTS, INPUT_STATE, INPUT_TIMING, KEY_EVENTS, KEYMAP, LOCALE, canControl, isMenuUi, isModalUi, INVENTORY_WIDGETS, LOCAL_PLAYER, PICKER_STATE, POINTER, TOAST, UI_MODAL, UI_SCALE, VIEWPORT, VOXEL, createPointer, createViewport, type InputDiagnostics } from "../data/globals/resources";
import { SetLoadingStage, SetFpsCap, SetMode, ShowToast, Teleport } from "../core/effect/commands";
import { INPUT_ACCESS, PlayerInputSystem } from "../plugins/player/systems/input";
import { CONTROLLER_ACCESS, PlayerControllerSystem } from "../plugins/player/systems/controller";
import { MOVEMENT_ACCESS, PlayerMovementSystem } from "../plugins/player/systems/movement";
import { COLLISION_ACCESS, CollisionSystem } from "../plugins/player/systems/collision";
import { BlockInteractionSystem, INTERACTION_ACCESS } from "../plugins/player/systems/interaction";
import { BlockOutlineSystem, OUTLINE_ACCESS } from "../plugins/render/systems/outline";
import { BOOT_FLOW, createBootFlow, type BootStage } from "../data/globals/boot";
import { runBootFlow, type BootFlowDeps } from "../core/flow/boot";
import { CHUNK_STREAM_ACCESS, ChunkStreamSystem } from "../plugins/render/systems/chunk-stream";
import { PositionSnapshotSystem, SNAPSHOT_ACCESS } from "../plugins/player/systems/snapshot";
import { DiagnosticsSystem, DIAGNOSTICS_ACCESS } from "../plugins/render/systems/diagnostics";
import { DELAYS_ACCESS, DelaySystem } from "../plugins/ui/systems/delays";
import { CAMERA_VIEW_ACCESS, CameraViewSystem } from "../plugins/render/systems/camera";
import { MenuBackgroundSystem } from "../plugins/render/systems/menu-background";
import { defaultUiTheme, UI_THEME } from "../data/assets/theme";
import { UI_RENDER_ACCESS, UiRenderSystem } from "../plugins/ui/systems/reconcile";
import { createUiActions, UI_ACTIONS } from "../data/globals/actions";
import { createUiOrder, UI_ORDER } from "../plugins/ui/components";
import { createUiPaint, UI_PAINT } from "../data/globals/paint";
import { createUiSources, UI_SOURCES } from "../data/globals/sources";
import { UI_BINDING_ACCESS, UiBindingSystem } from "../plugins/ui/systems/bindings";
import { BLOCK_OUTLINE, CAMERA3D, CANVAS_HOST, CHUNK_MATERIAL, CHUNK_MESHES, ICON_BAKE, MENU_BACKGROUND, PERF_SAMPLER, RENDERER3D, SCENE3D, UI_MOUNT } from "../data/globals/gfx";
import { createBlockOutline, createChunkMaterial, createChunkMeshCache, createIconBake, createMenuBackground, createUiMount } from "../host/browser/presentation";
import { createKeybindGesture, KEYBIND_GESTURE } from "../data/globals/keybind-gesture";
// The key bind PAGE is its own plugin too (P1.25), and hot-pluggable like the debug surface: the factory
// below is called once, and the value goes into both the boot list and the runtime catalogue.
import { createKeybindSystem, createUiKeybindPlugin } from "../plugins/ui-keybind";
import { spawnPickerPanel } from "../plugins/ui-debug/systems/picker";
// The F3/F4 DEBUG surface is its own plugin, and it is HOT-PLUGGABLE: the factory is called further down with
// the instance the root constructs, and that ONE value goes into both the boot's plugin list and the runtime
// catalogue. A plugin is hot-pluggable exactly when its `setup` alone is enough to install it.
import { createPickerSystem, createUiDebugPlugin } from "../plugins/ui-debug";
import { HOT_PLUG, type HotPlugHost } from "../core/plugin/hotplug";
import { SLOT_UI_PAGES } from "../core/extension/slots";
import { UI_PAGE_HOSTS, UI_PAGES_MOUNTED } from "../data/globals/ui-pages";
import type { Plugin } from "../core/plugin/descriptor";
import type { Entity } from "../core/world";
// The HUD message is its own plugin (P1.27 step 2) and needs NO mount: its panel is a TOP-LEVEL widget, so
// it can be plugged in and out at runtime in BOTH directions (unlike the key bind tab, which lives inside a
// view's layout). The root still spawns the widgets — it does the wiring — through the plugin's helper.
import { createToastSystem, createUiToastPlugin, spawnToastPanel } from "../plugins/ui-toast";
import { UI_LOADING_ACCESS, UiLoadingSystem } from "../plugins/ui/systems/loading";
import { UI_HUD_ACCESS, UiHudSystem } from "../plugins/ui/systems/hud";
import { UI_NAVIGATION_ACCESS, UiNavigationSystem, type NavigationTrees } from "../plugins/ui/systems/navigation";
import { LoadingScreen } from "../plugins/ui/views/loading";
import { Inventory } from "../plugins/ui/views/inventory";
import { INVENTORY_VIEW_ACCESS, UiInventorySystem } from "../plugins/ui/systems/inventory";
import { Menu, spawnMenuBackdrop } from "../plugins/ui/views/menu";
// The bind page's widgets and its drag gesture belong to the ui-keybind plugin (P1.26), so the root wires
// them from THERE: the ui plugin exports none of it any more.
import { bindKeybindDrag, boundCodes, cancelKeybindDrag, keycapAtPoint, spawnKeybindLine } from "../plugins/ui-keybind/views/keybind";
import { MainMenu } from "../plugins/ui/views/mainmenu";
import { Hud } from "../plugins/ui/views/hud";
import { PointerLock } from "../host/browser/pointerlock";
import { t, loadLang, getLang, i18nStringsState, I18N_STRINGS, type Lang } from "../data/assets/i18n";
import { loadUIScaleMode, getUIScaleMode, currentRootFontPx } from "../data/globals/uiscale";
import { loadFont, getFontId, currentFontCss } from "../data/globals/fonts";
import { preloadShell, bootReport, initShell, logDebug, showWindow, isGpuVsyncDisabled, setGpuVsyncDisabled, isDiagLogEnabled, setDiagLogEnabled, winFocused, quitApp, onWinFocus, onWinBlur, onWinGeometry, onCaptureLost, readSettings, readSettingsChecked, backupSettingsFile, diffSettings, writeSettings, getWindowMode, setWindowMode, applyWindowModeAtStart, onWindowModeChange, type WindowMode } from "../host/desktop/shell";
import { shellState, SHELL_STATE } from "../data/globals/shell";
import { startRawInput, centerCursor } from "../host/browser/rawinput";
import { installWindowGuards } from "../host/browser/window-guards";
// The platform halves the PLUGINS are not allowed to import: the composition root hands them in as
// the injected dependencies of the two systems that need them (input capture, icon baking).
import { captureMouse, releaseMouse } from "../host/browser/mousecapture";
import { iconCacheKey, peekBlockIcon, requestBlockIcon } from "../host/browser/blockicons";
import { ChunkGeometry, getChunkMaterial } from "../host/browser/chunkmesh";
import { adoptViewport, currentViewport, onViewportChange } from "../host/browser/viewport";
import { DebugLogForwarder } from "../host/desktop/debuglog";
import { PerfSampler } from "../core/services/perf";
import { loadBinds, getBind, getBindsAll, getCapturing, isCapturing, buttonToAction, buttonToCode, setBind, endCapture, adoptKeybindGesture } from "../plugins/input/keybinds";
// The configuration CHANGE BUS: a config value announces itself through here (the notification is
// behaviour; the values live under data/). The root subscribes to persist each one.
import { onConfigChange } from "../core/services/bus";
import { menuBgKind, menuBgState, MENU_BG_KIND } from "../data/assets/background";
import { resolveAllBytes, resolveTexture } from "../data/assets/textures";
import { preloadPacks } from "../host/desktop/packs";
import { DEFAULT_LANGUAGES } from "../plugins/content-default";
import { allBlockIds, blockRegistryState, BLOCK_REGISTRY, loadBlockRegistry } from "../data/assets/blockregistry";
import { VoxelWorld, WORLD_SURFACE_Y } from "../data/world/world";
// ===== The plugin system =====
// The registry the plugins contribute into, the manifest that decides which of them are installed, and
// the six plugins themselves (each owns its declarations; the systems are still built below and
// contributed under their plugin's id).
import { ExtensionRegistry } from "../core/extension/registry";
import { SLOT_RESOURCES, SLOT_SYSTEMS } from "../core/extension/slots";
import { installPlugins, startPlugins, stopPlugins } from "../core/plugin/lifecycle";
import type { SystemDef } from "../core/flow/schedule";
import { MANIFEST_FILE, isEnabled, readManifest, unknownPlugins } from "./manifest";
import { worldPlugin } from "../plugins/world";
import { createPlayerPlugin } from "../plugins/player";
import { createRenderPlugin } from "../plugins/render";
import { createDiagnosticsPlugin } from "../plugins/diagnostics";
import {
  createRenderSystem,
  createBindingSystem,
  createLoadingSystem,
  createInventorySystem,
  createHudSystem,
  createPagesSystem,
  createNavigationSystem,
  createDelaySystem,
  createInventoryView,
  createMainMenu,
  createPauseMenu,
  createUiViews,
  declareUiSystems,
  uiPlugin,
} from "../plugins/ui";
import { inputPlugin } from "../plugins/input";
import { contentDefaultPlugin } from "../plugins/content-default";

// Pixel font (Fusion Pixel, OFL open source): proportional font for general UI, monospace for F3/count panels
import "@fontsource/fusion-pixel-12px-proportional-sc";
import "@fontsource/fusion-pixel-12px-monospaced-sc";

// ===== Tauri: the synchronous preload (the ONE startup-order change in this port) =====
// The NW.js build had nothing to wait for here: require("node:fs") is synchronous and nw.Window was
// already there. A Tauri command is **asynchronous**, while loadLang/loadFont/loadBinds below and the
// whole UI read settings and resource packs synchronously, so these two are fetched up front, once:
//   preloadShell() -> settings / window mode / vsync switch (readSettings() stays synchronous, from memory)
//   preloadPacks() -> every byte of resourcepacks + mods (resolveTexture() stays synchronous after it)
// Top-level await needs ESM (index.html is a <script type="module"> already).
// **Wrap it in try/catch**: a throw out of here kills the whole module while initShell() has not run
// yet, and the error then lands nowhere — the symptom is the silent failure "process alive, no window,
// 0-byte log".
try {
  await preloadShell();
  await preloadPacks();
} catch (err) {
  const msg = `preload failed: ${String(err)}`;
  bootReport(msg);
  try {
    document.title = `VoxelEngine [${msg}]`;
  } catch {
    /* ignore */
  }
  throw err;
}

initShell();
// Settings: loaded from settings.json at startup (language/font/UI scale/window mode/keybinds, before any UI is built), written back on change.
// The VALUES are resources (see ecs/resources.ts): the config modules own the FILES and this object is
// the one owner of the value in force — `movement`/`interaction`/`input` ask the bind table every tick and
// the reconciler re-derives every widget's text from the language every frame, so both are declared world
// state. They are created here (before the World exists, because the loaders run before any surface is
// built) and inserted into the World with the other resources below.
const locale = createLocale();
const font = createFont();
const uiScale = createScale();
const keymap = createKeyMap();
// The data modules RETURN their summaries and this root prints them: a `data/` file has no side effects,
// and "the packs merged N blocks" is exactly the kind of evidence the composition root owns the sink for.
// The language SET is CONTENT: it is the content plugin's declaration, not a literal in the i18n module.
// The plugin's runtime contribution cannot drive this (the install happens after the config phase), so the
// root passes the declaration itself — and a manifest that disables the plugin leaves the set empty, which
// keeps the locale's own default (the boot must not depend on content being installed).
logDebug(loadLang(locale, readSettings().language, DEFAULT_LANGUAGES));
loadFont(font, readSettings().font);
loadUIScaleMode(uiScale, readSettings().uiScale);
loadBinds(keymap, readSettings().keybinds);
// The "Diagnostic log" switch (settings panel): the periodic DIAGNOSTIC PROBES are on by default, and the
// setting decides whether `logDebug` writes them. Set BEFORE anything logs a probe line, so a file with
// the switch off never sees one.
const diagLogAtBoot = readSettings().diagLog !== false;
setDiagLogEnabled(diagLogAtBoot);
// …and RECORD which state this run booted in. This line is an EVENT, not a probe (its prefix is not in
// platform/shell.ts's table), so it is written either way — which is the whole point: a log with no probe
// lines is otherwise ambiguous, "the switch is off" and "the probes never registered / stopped working"
// look identical to whoever reads it. It is written once, here, before anything else can log a probe.
logDebug(
  `DIAGLOG probes ${diagLogAtBoot ? "enabled" : "disabled"} at boot ` +
    `(settings.json diagLog=${diagLogAtBoot}${diagLogAtBoot ? "" : "; no probe lines in this run"})`,
);
const saveSettings = (fpsCapOverride?: number): void => {
    // Read-modify-write merge, avoids clobbering other settings (windowMode etc.)
  const s = readSettings();
  s.language = getLang();
  s.font = getFontId();
  s.uiScale = getUIScaleMode();
  s.windowMode = getWindowMode();
  s.keybinds = getBindsAll();
  s.diagLog = isDiagLogEnabled();
  // The override exists because the frame cap reaches the world through a COMMAND, which applies at
  // the next barrier: persisting the resource here would write the PREVIOUS value to disk. Every other
  // setting is a config singleton, so it is already settled when this runs.
  s.fpsCap = fpsCapOverride ?? world.resource(FPS_CAP).cap;
  writeSettings(s);
};
onConfigChange("lang", saveSettings);
onConfigChange("font", saveSettings);
onConfigChange("uiScale", saveSettings);
onWindowModeChange(saveSettings);
onConfigChange("binds", saveSettings);

// Block registry: merge every resource pack's blocks.json across the pack chain. Must run
// before the inventory is constructed (its slots are filled from the registry). The voxel
// mesher deliberately does not consult it yet — it draws the built-in checker block.
// (the data module returns the summary line; this root owns the log sink)
const blockRegistryReport = loadBlockRegistry();
if (blockRegistryReport) logDebug(blockRegistryReport);

// The canvas host: the element the renderer's canvas gets attached to. Like the UI mount root, it is a
// RESOURCE (ecs/presentation.ts) — the boot driver reads it back from the world rather than closing over
// a wiring variable.
const canvasHost = document.getElementById("app")!;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);
// No fog: the scene is deliberately unfogged so the whole streamed world stays visible. The
// trade-off is that the rim of the chunk window (~(RENDER_RADIUS_CHUNKS+1)*32 = 288 blocks, see
// ecs/systems/chunkstream.ts) is visible as the edge of the world — raise that radius to push it
// further out. The main-menu panorama is a separate scene and is unaffected either way.

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 5000);
camera.position.set(1, 2.6, 1);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGPURenderer({
  antialias: true,
  powerPreference: "high-performance",
  trackTimestamp: true,
});
// NOTE: the renderer is CONSTRUCTED here (every system that needs its canvas resolves it in its own
// constructor) but INITIALISED in the boot driver at the bottom of this file, together with
// `setSize`/`appendChild`/`showWindow`. That is deliberate and it is the whole reason the startup
// screen can exist: `await renderer.init()` is the longest single step of the startup, and it used to
// run BEFORE `showWindow()` — so the window stayed hidden through the GPU handshake, the world
// generation and the first chunk meshes, and the user watched nothing. Nothing between here and the
// driver draws: the first frame the loop runs is a `load` frame, which pumps the ui lane only.

// ===== Presentation state the ECS systems take as constructor dependencies =====
// (Declared here rather than next to the loop because every system resolves what it needs in its
// CONSTRUCTOR: the wiring order below is therefore explicit instead of accidental. The HUD is built
// further down, once the World exists — it spawns widget entities.)
const perf = new PerfSampler();
const dbgFwd = new DebugLogForwarder();

// ===== ECS composition: resources, entity, systems =====
// Everything here is the composition root. Order matters only where it is DECLARED (the
// after/before constraints below), and world.start() verifies those before the loops run.
const world = new World();

// Spawn resting on the generated world: WORLD_SURFACE_Y is the first air layer above the fill,
// so feet start exactly on the surface. One constant shared with the world-entry Teleport below,
// so the initial spawn and the re-entry position can never drift apart.
const SPAWN = new THREE.Vector3(0.5, WORLD_SURFACE_Y + HUMANOID_BODY.eyeHeight, 0.5);
// The starting hotbar comes from the registry (mod blocks appear automatically), so the ECS layer
// never has to import blockregistry.ts.
const player = spawnPlayer(world, SPAWN, allBlockIds());

// Voxel world: one mesh per visible chunk lives in this group.
const voxel = new VoxelWorld();
const chunkGroup = new THREE.Group();
scene.add(chunkGroup);

// Resources BEFORE systems: every system resolves what it needs from them in its constructor.
// UI_MODAL is the ONE answer to "does a modal UI own the mouse right now". The UI surfaces publish
// into it from their own show()/hide() (see the Inventory/Menu/MainMenu wiring below) and
// canControl() reads it, so a seventh surface cannot be silently missed at five OR sites — and the
// freeze no longer waits for the asynchronous pointerlockchange.
const uiModal = createUiModalState();
// The frame cap (0 = unlimited): a RESOURCE, because the frame gate below reads it every frame and
// diagnostics prints it into the F3 panel — see ecs/resources.ts. Loaded from settings.json here;
// `onFpsCap` writes it back. Physics still advances at fixed steps either way: only drawing and the
// stats sample are gated.
const frameCap = createFrameCap(Number(readSettings().fpsCap ?? 0));
world.insertResource(FPS_CAP, frameCap);
/** Does any modal surface own the mouse right now? */
const uiOpen = (): boolean => isModalUi(uiModal);
/** A MENU is open (not counting the inventory, which the inventory key must still be able to toggle) */
const menuOpen = (): boolean => isMenuUi(uiModal);
world.insertResource(LOCAL_PLAYER, player);
// The cursor policy reads it (canControl), so keep a reference
const inputState = createInputState();
world.insertResource(INPUT_STATE, inputState);
// The race guards' own state (ecs/resources.ts::InputTiming): which mousemove is the synthetic
// lock-instant one, whether the unlock was ours, the grace deadline, the offscreen cache, the
// diagnostic counters. It used to be private fields of player.input; the LOGIC did not move with them
// (iron rule 3), only the place the facts live — so a test and the gate can read them.
world.insertResource(INPUT_TIMING, createInputTiming());
// The input system's SPACE/MOUSE diagnostic log: written by the device layer, forwarded and printed by
// diagnostics — one log with two readers, so it is a resource rather than one system handing itself to
// another.
world.insertResource(INPUT_DIAGNOSTICS, createInputDiagnostics());
// The device intents waiting for the tick (`player.input` is the only writer AND the only reader; the
// array is world state so the queue is inspectable, and `step()` drains it in place).
world.insertResource(INPUT_INTENTS, createInputIntentLog());
// The pointer's last known position (published by the device layer; read by the key bind drag).
world.insertResource(POINTER, createPointer());
// The DELAYED INTENTS: "do this in a moment" as data (an absolute wall-clock deadline), applied by
// `ui.delays` once per frame. Four `setTimeout`s used to be the only way to say it — closing the backpack
// relocking the mouse, the lock manager's 1300 ms retry, and the cursor re-asserts after the window
// regained focus or after the menu/Apps key. See ecs/resources.ts for why the deadline is a resource.
const delayedIntents = createDelayedIntents();
world.insertResource(DELAYED_INTENTS, delayedIntents);
// The window's size (VIEWPORT): published by the ONE resize listener in platform/viewport.ts, read by the
// camera (its projection) and by the draw (the renderer's size). Adopting installs the listener and
// publishes the current size at once, so the first frame is already correct.
const viewport = createViewport();
world.insertResource(VIEWPORT, viewport);
// The HOST state the shell owns (platform/shell.ts): the settings snapshot, the log-flush deadline, the
// diagnostic-probe switch and the foreground flag. It used to be four module-level `let`s there; the
// object is created by that module (a log line may be written before this body runs) and inserted here,
// so the host's state is world data too.
world.insertResource(SHELL_STATE, shellState());
// The ASSET caches, which are data as well: the built dictionaries, the merged block registry and the
// pack chain's background memo. Each module creates its object at import time (all three are read before
// the World exists) and this is where they become named resources.
world.insertResource(I18N_STRINGS, i18nStringsState());
world.insertResource(BLOCK_REGISTRY, blockRegistryState());
world.insertResource(MENU_BG_KIND, menuBgState());
adoptViewport(viewport);
// The debug-log sink. A structural adapter over the two platform entry points, so diagnostics reads it
// from the world and takes NO constructor arguments (see ecs/resources.ts::DebugLogSink).
world.insertResource(DEBUG_LOG, { forward: (q: InputDiagnostics) => dbgFwd.forward(q), line: logDebug });
world.insertResource(UI_MODAL, uiModal);
world.insertResource(VOXEL, voxel);
// ===== Presentation resources: the three.js / GPU / DOM objects, owned by the world =====
// These were CONSTRUCTOR DEPENDENCIES: the scene, the camera, the renderer, the frame-time sampler, the
// canvas host, the UI mount root and the chunk-mesh group used to be handed to each system that needed
// one. They are world state like everything else here, so they are RESOURCES and each system resolves
// what it uses in its own constructor body. See ecs/presentation.ts for what that buys — and for the one
// thing it deliberately does NOT change: the access declarations still name these objects as targets
// (`camera3d`, `chunkMeshes`, …), because the schedule's conflict model is keyed by those NAMES, not by
// resource handles.
world.insertResource(SCENE3D, scene);
world.insertResource(CAMERA3D, camera);
world.insertResource(RENDERER3D, renderer);
world.insertResource(PERF_SAMPLER, perf);
world.insertResource(CANVAS_HOST, canvasHost);
world.insertResource(UI_MOUNT, createUiMount());
world.insertResource(CHUNK_MESHES, createChunkMeshCache(chunkGroup));
world.insertResource(MENU_BACKGROUND, createMenuBackground());
// The item-icon baker's state: the offscreen WebGPURenderer + the two caches (ecs/presentation.ts).
// It used to be four module-level `let`s in rendering/blockicons.ts, and the bake's completion wrote the
// inventory's UI_IMAGE component from a promise continuation — a component write outside any lane. The
// state is a resource now and the inventory notices a finished bake on its next run.
world.insertResource(ICON_BAKE, createIconBake());
// The ONE chunk material (a GPU object, created on first use because the pack chain must be installed):
// it used to be a module-level `let` in rendering/chunkmesh.ts.
world.insertResource(CHUNK_MATERIAL, createChunkMaterial());
// The block target outline's mesh: built HERE because a three.js object is wiring, and registered as a
// resource so the render-lane system that paints it resolves it instead of being handed it. The fixed
// lane writes only the TARGET_HIT component. The geometry is a unit box 0.002 larger than a block, so the
// wireframe sits just outside the block's faces instead of z-fighting with them.
const outlineBox = new THREE.BoxGeometry(1.002, 1.002, 1.002);
const outlineMesh = new THREE.LineSegments(
  new THREE.EdgesGeometry(outlineBox),
  new THREE.LineBasicMaterial({ color: 0xffffff }), // white reads on both checker colours
);
outlineBox.dispose();
outlineMesh.visible = false;
// matrixAutoUpdate off: block.outline positions the box and calls updateMatrix() itself (it only moves
// when the target changes, so there is nothing for three.js to recompute per frame).
outlineMesh.matrixAutoUpdate = false;
scene.add(outlineMesh);
world.insertResource(BLOCK_OUTLINE, createBlockOutline(outlineMesh));
// The configuration resources loaded above: the bind table and the language are read on the tick by
// systems that declare them (`readsExternal`), so they belong to the world rather than to a module.
world.insertResource(KEYMAP, keymap);
world.insertResource(LOCALE, locale);
world.insertResource(FONT, font);
world.insertResource(UI_SCALE, uiScale);
// The three UI-facing resources the widget surfaces publish through:
//   KEY_EVENTS    key edges, published by the device layer (ecs/systems/input.ts) and consumed by
//                 ui.picker — a Set of held keys cannot say "F3 went down just now"
//   PICKER_STATE  the F3+F4 picker's own state (open/sel/held keys), which used to be private fields
//                 of a class that listened to the DOM itself
//   TOAST         the HUD message and its wall-clock deadline, so the toast survives its caller and
//                 expires while the game is paused (the main menu is where it is most visible)
world.insertResource(KEY_EVENTS, createKeyEventLog());
world.insertResource(PICKER_STATE, createPickerState());
world.insertResource(TOAST, createToastState());
// THE PAGE HOST (P1.29): where pages may be mounted (filled by the views during wiring) and what is mounted
// right now (the host system's diff state). Both belong to the ROOT, inserted before any plugin is installed.
world.insertResource(UI_PAGE_HOSTS, []);
world.insertResource(UI_PAGES_MOUNTED, new Map());
// The startup screen's state: the boot driver publishes the current stage into it (through the
// SetLoadingStage command) and `ui.loading` paints it — the loading screen is UI, so it is data like every
// other surface, and main.ts never builds an element. See ecs/resources.ts.
world.insertResource(LOADING_STATE, createLoadingState());
// The key bind gesture: created HERE and handed to both ends — the document listeners in ui/menu.ts read
// it synchronously (the click shield decides inside the click it swallows), and ui.keybind applies it
// once per frame. One object, two readers, no second copy of the drag state.
const keybindGesture = createKeybindGesture();
world.insertResource(KEYBIND_GESTURE, keybindGesture);
// The rebind CAPTURE is part of that resource now (`capturing`), so platform/keybinds.ts only needs a
// pointer to it — adopted here, before any listener can ask "is a capture running".
adoptKeybindGesture(keybindGesture);
// Widget theme (every UI colour/space token) + the ACTION TABLE (what a clickable widget's id means)
// + the HUD tree. Spawning widgets is a STRUCTURAL change, so it belongs here during wiring or inside a
// command — never inside a system. The action table is a resource because it is world state too: a
// surface registers its handlers there instead of the reconciler knowing about any surface.
world.insertResource(UI_THEME, defaultUiTheme());
world.insertResource(UI_ACTIONS, createUiActions());
world.insertResource(UI_SOURCES, createUiSources());
// The UI layer's PAINT state (ecs/ui/paint.ts): the reconciler's element tables and per-widget "last
// written" cache, the loading/toast/HUD/keybind/inventory/navigation diff caches and the bindings'
// reported-source set. They used to be private fields of eight classes — state inside behaviour, reset
// nowhere and invisible to the schedule, to a test and to the log. Inserted before the first frame.
world.insertResource(UI_PAINT, createUiPaint(INVENTORY_SLOTS));
// The ONE frame loop's own state (`LOOP_STATE`) and the FRAME probe's accumulators (`FRAME_PROBE`):
// the mode, the accumulators, the canvas size last applied, the geometry-suppression deadline and the
// dozen probe counters used to be module-level `let`s in this file. Resolved into local aliases here so
// the loop's body keeps reading the way it always did.
world.insertResource(LOOP_STATE, createLoopState());
world.insertResource(FRAME_PROBE, createFrameProbe());
// The boot / world-entry FLOW (ecs/boot.ts): which flow is running, its stage list and the settings
// note the second stage reports. The drivers in this file only START a flow; the walk itself is that
// module's, and the sequence is data.
world.insertResource(BOOT_FLOW, createBootFlow());
const loop = world.resource(LOOP_STATE);
const probe = world.resource(FRAME_PROBE);
const bootFlow = world.resource(BOOT_FLOW);
// The widget tree's creation counter (UI_TREE.order). It is inserted BEFORE the first spawn below —
// spawnUiNode draws every order from it, and a missing resource would throw on the first widget.
world.insertResource(UI_ORDER, createUiOrder());
// The ui plugin owns its views: it declares them and constructs the two that need only the world. The root
// keeps the handles it wires by hand (the toast's panel, the loading screen's stage entities).
const { hud, loadingScreen } = createUiViews(world);
// The F3 panel's two widget handles, published for diagnostics (which writes the text) — the HUD view
// spawns the tree, the system owns the data written into it.
world.insertResource(F3_PANEL, hud.debugPanelEntities);
const picker = spawnPickerPanel(world);
// The startup screen's tree: spawned hidden during wiring (spawning is a structural change, so it
// belongs here or inside a command) and shown for as long as LOADING_STATE.active says the startup runs.

// The device layer takes the canvas from RENDERER3D (the renderer's domElement) and the camera from
// CAMERA3D, the chunk stream takes the CHUNK_MESHES cache — the presentation objects are resources now,
// so no system is handed one. See ecs/presentation.ts.
const renderPlugin = createRenderPlugin({
  world,
  mesh: { createGeometry: () => new ChunkGeometry(), getMaterial: getChunkMaterial },
});
const { chunkStream, cameraView, outline, menuBg } = renderPlugin.systems;
// The reconciler that owns every widget's DOM element. It mounts roots on the world's UI_MOUNT resource
// (the same element the hand-written HUD/menus used) and gets the i18n lookup injected, so ecs/ never
// imports src/ui/.
// `fontCss` / `rootFontPx` come along for the same reason: the FONT and UI_SCALE resources hold the
// values, and the reconciler — the one system allowed to write the DOM — is what applies them to the
// document root (see its reconcileAppliedStyle).
const uiRender = createRenderSystem(world, {
  translate: t,
  fontCss: currentFontCss,
  rootFontPx: currentRootFontPx,
  log: logDebug,
});
// Resolves every BOUND widget's value from its source (ecs/ui/bindings.ts), so a slider that shows
// shared state never holds a private copy of it.
const uiBindings = createBindingSystem(world, logDebug);
// The F3+F4 picker: the F3 debug panel and the mode chord are GAMEPLAY UI, so they are gated on
// `inWorld()` — outside a world (the main menu, and the loading screen while a world is built) it
// consumes the key edges and does nothing, and it takes its own panels down. The HUD toast below is
// NOT gated: a main-menu toast is a documented case (the multiplayer placeholder is drawn by the menu
// frame, which is the reason the ui lane can be pumped with no world running).
const uiPicker = createPickerSystem(world, {
  panel: picker.panel,
  items: picker.items,
  debugPanel: hud.debugPanelEntity,
  // The player's mode and how to change it: a component read and the SetMode COMMAND, injected so the
  // picker system itself only ever writes widget data.
  readMode: () => world.get(player, CONTROL)?.mode ?? "walk",
  applyMode: (mode) => world.commands.send(SetMode, { entity: player, mode }),
  inWorld,
  log: logDebug,
});
const toastPanel = spawnToastPanel(world);
const uiToast = createToastSystem(world, toastPanel.panel, toastPanel.body);
// The page host. `pages` is late-bound on purpose: the registry is declared further down the file, and this
// getter is only ever called from the lane.
const uiPages = createPagesSystem(world, { pages: () => registry.list(SLOT_UI_PAGES) });
// The startup screen's painter: it reads LOADING_STATE and writes the boot tree's widgets, so it is in
// the ui lane with the other widget-data writers — that lane is also the only one that runs in `load`
// mode, which is exactly the mode the screen is shown in.
const uiLoading = createLoadingSystem(world, loadingScreen);
// The key bind drag's data: derived every frame from the bind table + the GESTURE + the POINTER resource,
// with the platform reads injected so this layer stays free of platform imports (and so the gate can drive
// it with fakes). `line` is the rubber-band WIDGET the view only spawns — the system writes its geometry.
const keybindLine = spawnKeybindLine(world);
// The key bind tab's entry buttons, one per settings panel: the VIEW spawns them hidden and `ui.keybind`
// shows them, so this is filled once both menus exist (further down) and handed over by reference.
const keybindEntries: Entity[] = [];
const uiKeybind = createKeybindSystem(world, {
  boundCodes,
  capturing: getCapturing,
  bindOf: getBind,
  // The bind itself is applied by THIS system now (it drains the queued device decisions), so the writes
  // are injected like the reads: the event listener only reports what happened.
  setBind,
  endCapture,
  log: logDebug,
  line: keybindLine,
  entries: keybindEntries,
  keycapAt: keycapAtPoint,
});
// The key bind drag asks the UI SYSTEM what is under the cursor: only it owns the elements (the
// hand-written panel kept its own cross-instance table of keycap elements to do this).
bindKeybindDrag({
  log: logDebug, world, hitTest: (x, y) => uiRender.hitTest(x, y), gesture: keybindGesture });
// No callback into the UI any more: the interaction system reads the entity's INVENTORY component
// itself, so the hand you see and the hand that places a block cannot disagree. It writes the local
// player's TARGET_HIT component; `block.outline` (render lane) draws the wireframe from it — the mesh
// was this system's field until the refactor, which is why nothing here touches the scene.
// The main-menu background step (deliberately not registered in a lane — the MENU frame is its only
// caller, see rendering/menu-background.ts).

// Inventory VIEW (toggled with E; freezes the PLAYER and releases the mouse while open). It owns NO
// game state: the stacks and the selection are the player's INVENTORY component, and this object only
// renders them and asks for changes with commands. Built here because `ui.inventory` reconciles it
// every frame.
//
// Opening the backpack does NOT stop the game loop, and it does not stop PHYSICS either. The world
// keeps streaming, simulating and drawing behind the panel; the LOCAL PLAYER keeps its body — it
// still falls, lands and carries its velocity — and loses only its INTENT: canControl() goes false,
// so controller/interaction skip it and `movement` drops its keys while still integrating gravity.
// (Skipping the whole integration instead used to hang an airborne player in mid-air, which read as
// "opening a bag turns gravity off".) NPCs were never affected: they do not care about our pointer.
// This block used to call stopLoop()/startLoop(), which froze the whole world for as long as the
// backpack was open — a global pause nobody asked for, in exchange for opening a bag.
// The backpack's open/closed state is `UI_MODAL.inventory` (flipped by ui.navigation from the E key or
// its mouse bind) and its panel is painted from that state, so this view has no callback any more. The
// pointer-lock effects that used to live in the callback (release on open, relock on close) are
// edge-triggered from the same state inside ui.navigation.
// The menu FROST (P1.30): a full-screen frosted layer that `ui.navigation` shows while any modal is up.
const menuBackdrop = spawnMenuBackdrop(world);
const inv = createInventoryView(world, player);
// The handles the reconcile writes into (the view only spawns them): `ui.inventory` reads the component
// and writes these widgets, which is why the view is no longer called once per frame.
world.insertResource(INVENTORY_WIDGETS, inv.widgets);
const uiInventory = createInventorySystem(world, { key: iconCacheKey, peek: peekBlockIcon, request: requestBlockIcon });
// The GAMEPLAY widgets' visibility: the crosshair and the hotbar exist in every mode (they were spawned
// visible and nothing wrote their flag), so one system owns that flag and derives it from "is a world
// running". It needs the hotbar, which is why it is built here rather than with the other UI systems.
const uiHud = createHudSystem(world, {
  crosshair: hud.crosshairEntity,
  hotbar: inv.hotbarEntity,
  inWorld,
});

// ===== System registration =====
// Registration order IS the default execution order; `after`/`before` state the constraints that are
// actually load-bearing, and world.start() throws at boot if they cannot be satisfied — the order
// used to exist only as a comment.
//   fixed : player.input (drain the device events of the last frame into CONTROL/VIEW/MOTION — the
//           tick's FIRST act) -> motion.snapshot (freeze PREV_POSITION for every entity that has one)
//           -> controller (apply the view deltas) -> movement -> collision (re-integrates and resolves
//           what movement wrote) -> interaction (raycasts from the settled pose)
//   render: camera interpolation -> chunk meshing -> diagnostics -> draw
//   ui    : inventory view -> widget reconciler (both DOM; run LAST, and also on their own pump while
//           the game loop is stopped — the main menu is that state, and the pump is what makes a
//           main-menu toast appear at all)
// The command barrier at the top of world.render()/world.renderUi() is what lets a UI view show a
// selection the user just made: the command is applied before the view reconciles.
// ACCESS is declared per system (in each system's own module) and the schedule derives the batches
// from it: two systems may run in either order exactly when their access sets and their declared
// edges allow it. world.start() throws if a dependency is undeclared, and the report below logs what
// is actually parallel.
// NO edges between the four producers below: they touch disjoint things (the camera, the chunk
// meshes, the hotbar, the F3 panel), which is what the report's "6 parallel pair(s)" means. The old
// cameraView.render -> chunk.stream -> ui.inventory -> diagnostics chain was ordering for no data
// reason at all, and it was hiding that parallelism.
// ===== Plugins: the registry, the manifest, the install =====
// (This block sits HERE — after every resource is inserted and before the first registration — because a
//  plugin factory CONSTRUCTS its systems and a system resolves its resources in the constructor. Moving it
//  above the resource table is a boot-order bug that no gate can catch: it throws on the first frame.)
// `plugins/` is the LAYOUT; this is what makes it a plugin system. Each plugin declares what it OWNS into
// the registry, and the manifest (read from the pack chain like any other content file) decides which
// plugins this run installs. The SYSTEM definitions still live in this file — they close over the wiring
// built above — but every one of them is contributed UNDER ITS PLUGIN'S ID, so turning a plugin off in
// plugins.json keeps its systems out of the schedule entirely.
const registry = new ExtensionRegistry();
// The player plugin is built FIRST: it constructs the six fixed-lane systems and declares them, and the
// root keeps the handles it still wires by hand.
const playerPlugin = createPlayerPlugin({
  world,
  log: logDebug,
  // Late-bound on purpose: `inWorld` is declared further down the file, and the plugin only calls it.
  inWorld: () => inWorld(),
  mouse: { capture: (dom) => captureMouse(dom), release: releaseMouse },
});
const { input, snapshot, controller, movement, collision, interaction } = playerPlugin.systems;

// ===== The hot-plug host (P1.24) =====
// Which plugins may be installed WITHOUT a restart, and the door the `HotPlugPlugin` command reads. Note WHO
// builds the plugin: the ROOT does, from the instance it constructed — and the plugin still declares its own
// system, because that is the property that makes it hot-pluggable at all. It is the SAME value the boot
// installs below, so the boot path and the runtime path cannot drift apart.
const uiDebugPlugin = createUiDebugPlugin({ uiPicker });
const uiToastPlugin = createUiToastPlugin({ uiToast });
const uiKeybindPlugin = createUiKeybindPlugin({ uiKeybind }, keybindEntries);
// The catalogue order is the LANE order of the optional surfaces (debug -> toast -> keybind), which is what
// the core's slot anchors encode; the list itself is only what may be installed at runtime.
const hotCatalog: readonly Plugin[] = [uiDebugPlugin, uiToastPlugin, uiKeybindPlugin];
const livePlugins = new Set<string>();
const hotHost: HotPlugHost = {
  world,
  registry,
  log: logDebug,
  catalog: (id) => hotCatalog.find((p) => p.id === id) ?? null,
  installed: () => [...livePlugins],
  // The reverse-dependency guard has to see the BOOT's plugins too (`render` deps on `ui`, and `ui` is not
  // hot-pluggable), so this looks the id up in the whole list. Late-bound on purpose: PLUGINS is declared just
  // below, and this is only ever called after the boot.
  depsOf: (id) => PLUGINS.find((p) => p.id === id)?.deps ?? [],
  markInstalled: (id) => {
    livePlugins.add(id);
  },
  markUninstalled: (id) => {
    livePlugins.delete(id);
  },
};
world.insertResource(HOT_PLUG, hotHost);

const PLUGINS = [
  contentDefaultPlugin,
  worldPlugin,
  playerPlugin.plugin,
  renderPlugin.plugin,
  createDiagnosticsPlugin(world),
  uiPlugin,
  uiDebugPlugin,
  uiToastPlugin,
  uiKeybindPlugin,
  inputPlugin,
];
const manifestRead = readManifest(resolveAllBytes(MANIFEST_FILE), logDebug);
const manifest = manifestRead.manifest;
const unknownPluginIds = unknownPlugins(manifest, PLUGINS.map((p) => p.id));
if (unknownPluginIds.length > 0) {
  logDebug(`${MANIFEST_FILE}: unknown plugin id(s) ignored: [${unknownPluginIds.join(", ")}]`);
}
// The manifest line comes FIRST so the log reads in the order the decisions were made: which list was
// used, then what installing it did, then who ended up owning what.
logDebug(
  `PLUGINS manifest from ${manifestRead.source}: ` +
    `[${manifest.plugins.map((p) => `${p.id}${p.enabled ? "" : "=off"}`).join(", ")}]`,
);
const installOutcome = installPlugins(PLUGINS, {
  world,
  registry,
  log: logDebug,
  enabled: (id) => isEnabled(manifest, id),
});
// The hot-plug host's "installed right now" set starts as the boot's list: everything plugged in later is
// added by `hotInstall`, everything unplugged is removed by `hotUninstall`, and the reverse-dependency guard
// reads this list — so it sees the boot's plugins and the runtime ones in one place.
for (const id of installOutcome.installed) livePlugins.add(id);
for (const line of registry.report()) logDebug(`REGISTRY ${line}`);
/** Contribute one system under its plugin's id. A plugin the manifest disabled contributes NOTHING. */
const contributeSystem = (owner: string, def: SystemDef): void => {
  if (!installOutcome.has(owner)) return;
  registry.contribute(SLOT_SYSTEMS, owner, [def]);
};
// ui.navigation steps LAST in the ui lane and needs the modal widget trees, which the surfaces build
// further down — so it is registered HERE (before ui.widgets, which must follow it) and its trees arrive
// through a getter that is filled once they exist. The schedule resolves edges at start(), so an `after`
// naming a system registered later would silently drop the edge.
let navTrees: NavigationTrees | null = null;
const navigation = createNavigationSystem(world, {
  get trees(): NavigationTrees {
    if (!navTrees) throw new Error("navTrees not wired");
    return navTrees;
  },
  inventoryCode: () => getBind("inventory"),
  capturing: isCapturing,
  // "A world is running" — the pause menu and the backpack are refused while the loading screen is up
  // (the startup, and the world being built behind it during an entry).
  inWorld,
  prepareUnlock: () => input.prepareUnlock(),
  // A key bind DRAG owns ESC while it is live: this system (the ONE decision-maker for ESC) cancels it
  // instead of stepping back through the ladder.
  dragging: () => keybindGesture.drag !== null,
  cancelDrag: (reason) => cancelKeybindDrag(reason, logDebug),
  // Native capture: does NOT go through `document.exitPointerLock` (see platform/mousecapture.ts)
  exitPointerLock: () => input.releaseCapture(),
  centerCursor,
  relock: (reason) => pointerLock.relock(reason),
  // "Relock, but not in this key dispatch": the DEADLINE goes into the world and `ui.delays` applies it
  // (it used to be a `setTimeout(…, 0)` here — a timer owned by the composition root).
  relockSoon: (reason) => delayedIntents.schedule("relock", 0, reason),
  applyCursor: () => pointerLock.applyCursor(),
  log: logDebug,
});
// The delayed intents (ecs/systems/delays.ts): whatever deadline has passed is applied HERE — after the
// system that decided it, before the frame is painted. Both halves of that order are FORCED rather than
// stylistic: it writes the two targets ui.navigation writes (`pointerLock` / `cursor`), which the schedule
// refuses to leave unordered, and the reconciler must stay the last system in the lane.
const delays = createDelaySystem(world, {
  relock: (reason) => pointerLock.relock(reason),
  lockRetry: (source) => pointerLock.retry(source),
  cursor: () => pointerLock.applyCursor(),
  log: logDebug,
});
// The size the draw last applied to the renderer — this system's own state (it owns the framebuffer).

// (world.start() moved below: ui.navigation needs the widget trees the surfaces build during wiring.)

// Raw mouse input (Rust plugin): takes over view rotation when pointer lock is cancelled with the window partially offscreen.
// **Decided on event arrival, applied ONCE per frame**: `rawDelta` runs the takeover/grace/spike
// decision in every event and accumulates the part that passes; `frame()` calls `input.frameLook()`
// once per frame to queue it as ONE look intent — the view no longer goes through any timer (the old
// 8 ms `setInterval` was stretched to 9-12 ms steps by key events, which is exactly "holding a key
// turns the view unsmoothly").
// The transport counters live in the INPUT_DIAGNOSTICS resource (a system may not own module-level
// counters, and the device layer may not import one): `player.input` prints them as RAWLAG once a second.
const rawInput = startRawInput((dx, dy) => input.rawDelta(dx, dy), world.resource(INPUT_DIAGNOSTICS).raw);
// **The assignment must wait for ready to settle.** In the original, startRawInput() was a synchronous
// NAPI call, so `available` was true on the spot and this line used to be a synchronous assignment,
// `input.rawInputActive = rawInput.available`; the Tauri port only sets it in
// `invoke("rawinput_start").then()`, and a synchronous read gets **permanently** false. The consequence
// is that native mouse capture never enables (falling back to the browser's requestPointerLock, which
// runs into ESC unlock + the cooldown) and the raw-input view takeover dies with it. That trap was hit.
void rawInput.ready.then((ok) => {
  input.rawInputActive = ok;
  logDebug(
    `RAWINPUT active=${ok} -> mouse capture uses ${ok ? "**native ClipCursor** (browser pointer lock untouched)" : "the browser requestPointerLock path (raw input unavailable)"}`,
  );
});

// Pointer lock manager: referenced by the menu callbacks; declared with let then assigned, avoiding a circular dependency
let pointerLock: PointerLock;

pointerLock = new PointerLock({
  input,
  // The cursor value it last applied lives in the device state resource (INPUT_STATE.appliedCursor).
  state: inputState,
  isUiModal: uiOpen,
  // The cursor test: hide it only while the player **really is controlling the mouse**. `!isUiModal`
  // will not do — the loading screen holds no modal surface, so that would make the loading screen
  // hide the cursor (a legacy bug).
  canControl: () => canControl(inputState, uiModal),
  // Capture only opens while foregrounded (native ClipCursor does not look at focus; the browser's
  // requestPointerLock refuses on its own anyway).
  focused: winFocused,
  logDebug,
  // Both of these are **delayed intents**, not timers of this module: the deadline goes into
  // DELAYED_INTENTS and is applied by `ui.delays`.
  scheduleRetry: (delayMs, source) => delayedIntents.schedule("lockRetry", delayMs, source),
  scheduleCursor: (delayMs) => delayedIntents.schedule("cursor", delayMs),
});

// The window-level guards (pointerlockchange log, ESC/contextmenu preventDefault, the Space shield) are
// device-layer listeners that must decide INSIDE the event, so they live in `platform/window-guards.ts`
// and are installed here with the two facts they need. The composition root holds no listener of its own.
installWindowGuards({
  isUiModal: uiOpen,
  log: logDebug,
  applyCursor: () => pointerLock.applyCursor(),
  // The menu/Apps key's re-assert schedule (0/32/80 ms after the immediate write) is a DELAYED INTENT now:
  // the listener cancels the default and records the deadlines, `ui.delays` applies them once per frame.
  scheduleCursor: (delayMs) => delayedIntents.schedule("cursor", delayMs),
});

// Settings callbacks (shared by the pause menu and main menu)
const onFpsCap = (cap: number): void => {
  // The cap is BOTH world state (the frame gate reads the resource every frame) and a setting. The world
  // half goes through the barrier as a command — this used to be a direct `frameCap.cap = cap` from a UI
  // callback, the last world value changed outside a system run — and the config half is written here,
  // because configuration is not world state. `saveSettings(cap)` takes the value because the command
  // has not applied yet: reading the resource would persist the previous cap.
  world.commands.send(SetFpsCap, { cap });
  saveSettings(cap);
    logDebug(`FPS cap set to ${cap === 0 ? "unlimited" : cap}`);
};
const onToggleGpuVsync = (disabled: boolean): boolean => {
  const ok = setGpuVsyncDisabled(disabled);
  // A COMMAND, not a view call: the message and its deadline are world state (ecs/ui/toast.ts), and the
  // key is passed through untranslated so a language switch re-translates a toast that is already up.
  world.commands.send(ShowToast, {
    key: ok ? (disabled ? "toast.vsyncOff" : "toast.vsyncOn") : "toast.vsyncFail",
  });
    logDebug(`GPU vsync ${disabled ? "disabled" : "enabled"} ${ok ? "written to manifest, restart to apply" : "write failed"}`);
  return ok;
};

/** The "Diagnostic log" switch in the settings panel: it only controls whether the **diagnostic probe
 *  lines** reach the disk (see the prefix filter in platform/shell.ts::logDebug), touches no game state
 *  and needs no restart. On by default. */
const onToggleDiagLog = (on: boolean): boolean => {
  setDiagLogEnabled(on);
  saveSettings();
  // This line itself is **not** a probe (its prefix is not in the table), so it is still written after
  // the switch is turned off — which leaves exactly the record of who turned it off.
  logDebug(`DIAGLOG probes ${on ? "enabled" : "disabled (probe lines stop being written)"}`);
  return true;
};

// Window mode: runtime enter/leaveFullscreen switch (no restart); exiting fullscreen goes through the settings panel "windowed"
/** Until when a geometry change must NOT be treated as "the user is messing with the window". Windows
 *  emits a burst of Resized/Moved events for a programmatic window-mode switch (and for the fullscreen
 *  transition), and pausing on those would be a regression: switching to fullscreen must not open the
 *  pause menu. Rust still re-clips the capture rectangle for them (win::reclip_mouse_capture).
 *  The deadline is LOOP_STATE.suppressGeometryUntil (ecs/resources.ts) — the loop's own data. */
const suppressGeometryPause = (): void => {
  loop.suppressGeometryUntil = performance.now() + 800;
};

const onSetWindowMode = (mode: WindowMode): void => {
  suppressGeometryPause(); // our own window-mode change is NOT "the user is messing with the window"
  setWindowMode(mode);
    logDebug(`window mode ${mode === "fullscreen" ? "fullscreen" : "windowed"}`);
};

const menu = createPauseMenu(world, {
  // The three platform capabilities a view may not import itself (see SettingsCallbacks).
  log: logDebug,
  onViewportChange,
  onWindowModeChange,
  // The pause menu PUBLISHES its navigation state into UI_MODAL itself, and ui.navigation paints it —
  // so no call site has to remember to say so, and a sub-panel needs no flag of its own.
  onResume: () => {
        // Back to game: relock the mouse (cooldown after ESC, auto-retry on failure)
        pointerLock.relock("menu resume");
    pointerLock.applyCursor();
        logDebug("RESUME back to game -> relock");
  },
  onFpsCap,
  onToggleGpuVsync,
  isGpuVsyncDisabled: () => isGpuVsyncDisabled(),
  onToggleDiagLog,
  isDiagLogEnabled: () => isDiagLogEnabled(),
  getFpsCap: () => frameCap.cap,
  getWindowMode: () => getWindowMode(),
  onSetWindowMode,
  onToMainMenu: () => {
        // Back to main menu: leave the game loop for the MENU mode (which also clears to black and
        // restarts the panorama — setLoopMode owns all three), then show the menu.
    setLoopMode("menu");
    renderer.setClearColor(0x000000);
    renderer.clear();
    mainMenu.show();
    pointerLock.applyCursor();
        logDebug("MENU back to main menu");
  },
});

// ===== Entering a world: the ONE place a world is built =====
// There is no world-entry loading screen in the old sense and no boot-time preload any more: the
// SPAWN WINDOW IS GENERATED AND MESHED HERE, behind the same screen the startup uses (`LOADING_STATE` +
// `ui.loading`, whose text is a stage key and whose bar is data). Why here and not at boot:
//   * the startup no longer spends ~1.6 s building a world the user may never enter (it reaches the
//     main menu right after the GPU is ready), and chunk data is only allocated if a world is entered;
//   * the work is where the user expects to wait for it, and a screen that covers real work is honest —
//     the boot screen used to cover it, which made "entering a world" instant but the STARTUP long;
//   * a future world type, save game or respawn simply has more to do in the same place.
// The loop is put in `load` mode (the ui lane only: nothing simulated, nothing drawn) until the
// world is ready, which is what keeps the screen up with no panorama drawn behind it.
/** Enter the world: build the window around the spawn point behind the loading screen, then play.
 *  A RE-entry into a window that is still built skips the screen entirely (see `needsWarmUp`). */
async function enterWorld(mode: string): Promise<void> {
  const entryStart = performance.now();
  // The menu stops owning the display first: `hide()` publishes into UI_MODAL, so ui.navigation takes
  // it down in the same ui lane that paints the screen.
  mainMenu.hide();
  // Back to spawn. Through the barrier — and it has to be applied BEFORE the warm-up, because
  // `chunkStream.step()` reads POSITION to decide which window to build.
  world.commands.send(Teleport, { entity: player, x: SPAWN.x, y: SPAWN.y, z: SPAWN.z });
  logDebug(`MAINMENU entering singleplayer (world type: ${mode === "noise" ? "noise" : "superflat"})`);

  if (chunkStream.needsWarmUp(SPAWN.x, SPAWN.z)) {
    // ACTIVATE the screen: the same trap as the startup's first stage — the root is spawned hidden and
    // `ui.loading` paints nothing while LOADING_STATE.active is false (which the END of boot() left it as).
    // Forgetting this line is invisible to a type-checker and to every "is the screen painted" test
    // that drives the system rather than the driver, which is why the gate now asserts it per driver.
    // The NOTE is cleared in the same breath: it belongs to the startup's settings check, and a stale
    // "repaired settings" line has no business on a world entry.
    world.commands.send(SetLoadingStage, { active: true, noteKey: "", noteValue: "" });
    // …and the loop has to BE in `load` mode for the whole entry: the entry is driven from the main
    // menu, so without this line every frame in between is a MENU frame, which draws the panorama
    // behind an opaque screen for nothing (and `loadFrame` — the mode's own body — would never run).
    setLoopMode("load");
    // The entry's stages, as DATA (ecs/boot.ts): the work of a stage runs after its own announcement has
    // been painted, so the bar never claims to be doing something it has not started.
    const stages: readonly BootStage[] = [
      { progress: 0, key: "world.spawn" },
      {
        progress: 0.15,
        key: "world.terrain",
        // Generate (no meshing) the spawn window: collision needs real blocks on the very first tick.
        run: () => chunkStream.prime(SPAWN.x, SPAWN.z),
      },
      {
        progress: 0.2,
        key: "world.chunks",
        run: () =>
          chunkStream.warmUp(paint, (done, total) => {
            // The bar owns almost the whole entry: the GPU was paid for at boot.
            world.commands.send(SetLoadingStage, { progress: total > 0 ? 0.2 + 0.75 * (done / total) : 0.2 });
          }),
      },
      { progress: 1, key: "world.ready" },
    ];
    await runBootFlow(bootFlow, "world", stages, flowDeps);
    logDebug(`WORLD ready at ${(performance.now() - entryStart).toFixed(0)}ms`);
  } else {
    // Nothing to build: the world is already on screen behind the menu, so it comes back at once.
    world.renderUi(); // the barrier applies the Teleport before the first game frame reads it
    logDebug("WORLD already warm, entering without a screen");
  }

  // Hand the display over in ONE ui lane: the screen comes down and the world is drawn by the very
  // next frame (a game frame draws the scene BEFORE its ui lane runs, so there is no empty frame).
  world.commands.send(SetLoadingStage, { active: false });
  setLoopMode("game");
  pointerLock.applyCursor();
  // Entering a world **must be foregrounded** to capture. Switching to another app during the load
  // would make this relock open native capture on a **background** window (the cursor clamped into that
  // screen region while another app is over it; raw input is collected in the background too, so the
  // view keeps turning; and the cursor is globally hidden) — and **no** blur event will come to rescue
  // it, because focus was lost long ago. So the treatment is "not foreground ⇒ pause": into the pause
  // menu at once, and on switching back onWinFocus sees a UI open and does not auto-capture (a menu
  // does not auto-close, resume manually — the existing convention).
  if (winFocused()) {
    pointerLock.relock("world entered");
  } else {
    menu.show();
    logDebug("WORLD entered while not foreground -> pause menu (no capture)");
  }
}

// Main menu: singleplayer picks a world type then enters; multiplayer placeholder; settings/exit
const mainMenu = createMainMenu(world, {
  log: logDebug,
  onViewportChange,
  onWindowModeChange,
  // Same contract as the pause menu: the surface publishes, ui.navigation paints.
  onStartSingle: (mode) => {
    // The world is BUILT here now (see enterWorld): nothing about it is done at startup any more, so
    // the Teleport, the loading screen and the first game frame are one sequence.
    void enterWorld(mode).catch((err: unknown) => {
      logDebug(`WORLD entry failed: ${String((err as Error)?.message ?? err)}`);
    });
  },
  onMultiplayer: () => {
    // The main menu is the state where the game loop is STOPPED and only the ui pump runs, so the toast
    // is put on screen by the ui lane (world.renderUi) — a DOM write from here would be reconciled by
    // nothing. The key, not t(key): a language switch retranslates it live.
    world.commands.send(ShowToast, { key: "toast.multiPlaceholder" });
        logDebug("MAINMENU multiplayer (placeholder)");
  },
  onExit: () => {
        logDebug("MAINMENU quit");
    // Tear-down: every plugin that STARTED gets its `stop`, in reverse install order (a plugin may depend
    // on one installed before it). This is the quit path; a future uninstall calls the same function.
    stopPlugins(installOutcome, startedPlugins, logDebug);
    quitApp();
  },
  getFpsCap: () => frameCap.cap,
  onFpsCap,
  isGpuVsyncDisabled,
  onToggleGpuVsync,
  isDiagLogEnabled,
  onToggleDiagLog,
  getWindowMode,
  onSetWindowMode,
});

// ===== ui.navigation's widget trees (registered above, wired here) =====
// The state machine is in the schedule from boot; these are the handles it paints.
navTrees = {
  pauseRoot: menu.rootEntity,
  pauseMain: menu.mainPanelEntity,
  pausePanels: menu.panelEntities,
  mainRoot: mainMenu.rootEntity,
  mainMain: mainMenu.mainPanelEntity,
  genPanel: mainMenu.genPanelEntity,
  backdrop: menuBackdrop,
  mainPanels: mainMenu.panelEntities,
  inventoryPanel: inv.panelEntity,
};

// Everything the installed plugins contributed, contributed order — the schedule resolves and verifies
// the order from the declared after/before edges, so the registration order carries no meaning.
// The ui lane's ten declarations belong to the ui PLUGIN (plugins/ui/index.ts): the root builds the
// instances (they wrap the views it creates) and the plugin says what they are, where they run and what
// they touch. One call, before the schedule is fed from the registry.
const uiApi = installOutcome.apiOf("ui");
// The ui plugin is OPTIONAL for the boot: the manifest may disable it, and the engine then runs with
// nothing painting the screen (the views are widget DATA — without the ui systems nothing turns them into
// DOM). What it must not do is crash, which is what an unconditional apiOf("ui")! did.
if (!uiApi) {
  logDebug("PLUGIN ui is not installed - the ui lane is off: nothing will be painted (the loading screen and the menus are ui surfaces)");
} else {
  declareUiSystems(uiApi, {
  uiPages, uiHud, uiLoading, uiInventory, uiBindings, navigation, delays, uiRender,
});
}

// The DEBUG surface's system is declared by the plugin itself now (`createUiDebugPlugin`), which is what makes
// it installable at runtime: there is no root-side `declare…(api, instances)` call left for boot to run and
// hot-plug to miss. Disabling it in the manifest, or unplugging it with F8, removes exactly that surface.

for (const def of registry.list(SLOT_SYSTEMS)) world.addSystem(def);

world.start();
for (const line of world.scheduleReport()) logDebug(line);
// START phase (P1.19): `setup` may only CONTRIBUTE — the schedule and the resource table are still being
// assembled while it runs. The world is started now, so a plugin that asked for a `start` hook is told the
// assembly is done (and one whose `start` throws is disabled without taking the boot down). `stopPlugins`
// is the mirror image, wired for the quit path and for a future uninstall.
const startedPlugins = startPlugins(installOutcome, logDebug);
if (startedPlugins.failed.length > 0) {
  logDebug(`PLUGIN start failures: [${startedPlugins.failed.map((f) => `${f.id}: ${f.error}`).join("; ")}]`);
}
// NOTE: the spawn window (chunkStream.prime + warmUp) is generated and MESHED by the boot driver at
// the bottom of this file, not here: it is one of the startup stages the loading screen covers, and
// doing it before `showWindow()` was half of why the startup looked like a hang.

// Window leaves the foreground (minimized/switched away/clicking another window): immediately show the pause menu (only while actually playing).
// Re-focus: while playing with no UI open, auto-relock (MC behavior: an open menu does not auto-close, resume manually).
/** The window is GONE — either it lost focus, or the native capture was torn down because we are not in the
 *  foreground any more (Rust's `capture_foreground_check`). ONE handler for both: to the game they mean the
 *  same thing. Hand the mouse back, and pause if the player was playing. */
const onWindowLost = (reason: string): void => {
  logDebug(`${reason} inWorld=${inWorld()} uiOpen=${uiOpen()} locked=${input.locked}`);
  input.prepareUnlock();
  // Hand the mouse back: native capture is released here (Rust also releases it as a fallback on
  // blur / not foreground).
  input.releaseCapture();
  if (inWorld() && !uiOpen()) {
    menu.show();
    pointerLock.applyCursor();
    logDebug(`${reason} -> pause menu`);
  }
};
onWinBlur(() => onWindowLost("WINFOCUS blur"));
onCaptureLost(() => onWindowLost("CAPTURELOST not foreground"));
onWinFocus(() => {
  // Diagnostics: record it once, **unconditionally**
  logDebug(`WINFOCUS focus inWorld=${inWorld()} uiOpen=${uiOpen()} locked=${input.locked}`);
  // On switching back, restore the cursor first: Chromium's cached cursor may still be the NULL from
  // before the blur (see the note on reapplyCursor).
  pointerLock.reapplyCursor();
  if (inWorld() && !uiOpen() && !input.locked) {
        pointerLock.relock("window focus");
        logDebug("FOCUS focused -> relock");
  }
});

// Window GEOMETRY changed (resized / moved / DPI scale). **This is not "the mouse left the app":** dragging
// a border or the title bar keeps the window focused and the cursor inside its rect (over the NON-CLIENT
// area), so neither blur nor mouseleave fires — while the native capture's ClipCursor rectangle quietly goes
// stale. That combination is exactly the reported bug: start a resize-drag while a world is loading, the
// entry locks the mouse on top of it, and from then on the drag AND the view rotation both work, with the
// cursor roaming the window afterwards.
//
// So the treatment is the BLUR treatment (hand the mouse back, pause if the player was playing), triggered
// by the only reliable signal there is. Rust re-clips the rectangle on the way here, which covers the
// suppressed case (our own window-mode switch keeps the capture on).
onWinGeometry(() => {
  if (performance.now() < loop.suppressGeometryUntil) return; // our own fullscreen/windowed switch
  // NOT IN A WORLD: nothing is captured and there is nothing to pause, so do (and LOG) nothing. This used
  // to run on every geometry event regardless of the mode, which meant hundreds of debug.log lines for one
  // window drag at the main menu (and a pointless native-capture release per event).
  if (!inWorld()) return;
  const open = uiOpen();
  // …and a menu already owns the mouse: release anything stale, but do not pause (there is nothing to
  // pause) and do not log per event — a drag would flood the log the same way.
  input.prepareUnlock();
  input.releaseCapture();
  if (open) return;
  logDebug(`WINGEOM locked=${input.locked}`);
  menu.show();
  pointerLock.applyCursor();
  logDebug("GEOMETRY changed -> pause menu");
});

// The ESC preventDefault, the contextmenu block and the Space shield are installed by
// `installWindowGuards` above (platform/window-guards.ts): a preventDefault can only happen in the event
// that must be cancelled, so they are device-layer listeners rather than anything a lane could run — but
// they are no longer the composition root's. The DECISIONS stay where they were: `ui.navigation` reads the
// Escape EDGE and steps back through UI_MODAL; the mouse-button binds and the inventory key are
// `player.input`'s (the edge) + `ui.navigation`'s (the decision); `F3`/`F3+F4` are `ui.picker`'s.

scene.add(new THREE.AmbientLight(0xffffff, 0.5));
// Directional light: ambient alone lights every face of a block identically, which renders the
// chunk geometry flat and unreadable. Same setup as rendering/blockicons.ts.
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(1, 1.5, 0.75);
scene.add(sun);
// The window resize handler that used to live here is GONE: it reached into the camera and the GPU
// device the moment the event arrived, and it was one of TWO resize listeners (ui/uiscale.ts kept the
// other). platform/viewport.ts owns the single listener now and only PUBLISHES the VIEWPORT resource;
// the camera's projection is reconciled by cameraView.render and the renderer's size by the draw below.
// The menu-background camera reads the same resource in its own step (rendering/menu-background.ts).

const timer = new THREE.Timer();
timer.connect(document);  // Page Visibility API: delta=0 when minimized/background, auto-reset on resume

// ===== The frame loop: ONE rAF chain, and the MODE decides what a frame DOES =====
// There used to be THREE chains — the game loop, the ui pump and the menu panorama — each with its own
// start/stop pair, and a mode transition had to start one and stop the others. That is how "the loop is
// stopped" and "the ui lane is pumped" became hard to reason about separately. The process now has ONE
// chain: it is started once (the boot block at the bottom of this file calls `frame()`) and never
// restarted or cancelled, `setLoopMode()` only writes the mode, and the next frame obeys it.
//   * "game": fixed-step physics + the render lane + the ui lane (all inside world.render)
//   * "menu": nothing is simulated and the last world frame stays on screen; the ui lane alone is
//             pumped — the main menu is the one state where the user still clicks things while the
//             simulation is stopped — plus the panorama background when that mode has one
//   * "load": a LOADING SCREEN is up — the startup, and an entry into a world while its spawn window is
//             built — so the ui lane alone runs: the screen is widget data and there is nothing to
//             simulate or draw yet (the renderer does not even exist during the startup's first stages).
//             It is called `load` and not `boot` because it serves both flows (it was `boot` while it
//             was only the startup's mode, and the name was a lie once a world entry used it too).
// The loop's own state is a RESOURCE (`LOOP_STATE`, ecs/resources.ts): the mode, the two accumulators,
// the size the canvas was last set to and the geometry-suppression deadline used to be seven module-level
// `let`s here. The frame BODY stays this file's (a rAF callback is not a lane) — what moved is its state.
// Fixed-step physics: step size (decoupled from frame timing, MC-style fixed tps)
const PHYS_DT = 1 / 120;

/** The game's frame: advance the simulation at a FIXED step (frame-rate independent movement), gate
 *  drawing and stats on the frame cap, then run the render lane and the ui lane. */
function renderFrame(): void {
  timer.update();
  const delta = Math.min(timer.getDelta(), 0.1);

    // Fixed-step physics advance: movement is independent of frame duration, constant per step (removes movement jitter from uneven frame timing)
  loop.physAcc += delta;
  let steps = 0;
  while (loop.physAcc >= PHYS_DT && steps < 12) {
    world.stepFixed(PHYS_DT);
    loop.physAcc -= PHYS_DT;
    steps++;
  }

  // FPS cap gate: skip rendering and stats until the frame budget is reached (physics already advanced above at fixed steps)
  if (frameCap.cap > 0) {
    const budget = 1 / frameCap.cap;
    loop.renderAcc += delta;
    if (loop.renderAcc < budget) return;
    loop.renderAcc %= budget;
  }

  // Per-frame systems: view interpolation -> chunk meshing -> diagnostics -> draw
  // (alpha = remainder of the physics tick). The ECS command barrier runs first inside render().
  world.render(Math.min(loop.physAcc / PHYS_DT, 1), delta);
}

// ===== A MENU frame: the ui lane alone, plus the panorama background =====
// MENU mode halts the simulation AND the draw, which is what keeps the last world frame on screen — and
// the main menu is the one state where the user still interacts with the UI while that is true. So a
// menu frame pumps the `ui` stage on its own (see the three-lane note in ecs/core/schedule.ts).
// Without it the multiplayer placeholder said nothing: showToast() wrote component data that nothing
// ever reconciled into the DOM, because the only reconciler rode the stopped render lane.
// (The open backpack is NOT one of these states: it no longer stops the loop at all — it holds only
//  the local player, so its commands and its DOM are serviced by the ordinary frame. The menu frame's
//  command barrier is what used to be needed for it, back when it did stop the loop.)
// Cheap by construction: an empty command queue plus a query over a dozen UI entities.
function menuFrame(): void {
  menuBg.step();
  world.renderUi();
}

// ===== A LOAD frame: the ui lane alone — a loading screen is up =====
// Two flows put the screen up (the startup, and building a world behind it when one is entered) and
// both sit in this mode until they are done. It is a real body rather than "nothing yet": the screen is
// widget data like any other surface, so it needs the reconciler, and the reconciler lives in the ui
// lane. Nothing else may run here — `renderer` does not exist during the startup's first stages, and
// during a world entry there is nothing worth drawing yet (the screen covers the viewport anyway).
function loadFrame(): void {
  world.renderUi();
}

/** The canvas follows the WINDOW, once per frame, in EVERY mode — this is the frame's first act.
 *
 *  WHY IT IS HERE AND NOT IN THE DRAW. The one resize listener (`platform/viewport.ts`) only publishes the
 *  VIEWPORT resource; somebody has to apply it to the renderer, and that somebody must run in the modes
 *  where the render lane does NOT: a MENU frame is the panorama step plus the ui lane, and a LOAD frame is
 *  the ui lane alone — neither draws, so a size applied by `renderer.draw` was applied ONLY in a game. The
 *  symptom was exact and was reported: resize at the main menu and the panorama's canvas kept its old
 *  pixel size (the drawing surface, not the projection — the menu camera's aspect IS reconciled, in
 *  MenuBackgroundSystem), so the background stopped scaling until a world was entered.
 *
 *  The size is applied only when it CHANGED, and only after `renderer.init()` — the renderer is
 *  constructed during wiring but initialised behind the loading screen, and a load frame runs before that.
 *  Both facts (`appliedViewportW/H`, `rendererReady`) are fields of LOOP_STATE (ecs/resources.ts). */
function applyViewportSize(): void {
  if (!loop.rendererReady) return;
  const vp = world.resource(VIEWPORT);
  if (vp.width <= 0 || vp.height <= 0) return;
  if (vp.width === loop.appliedViewportW && vp.height === loop.appliedViewportH) return;
  loop.appliedViewportW = vp.width;
  loop.appliedViewportH = vp.height;
  renderer.setSize(vp.width, vp.height);
}

/** ===== FRAME diagnostics (one line per second + stall warnings) =====
 *  Why it is needed: `PHYS` (diagnostics) only runs in game mode at a 500 ms granularity, and on its own
 *  it cannot tell "the main thread was occupied for a moment" from "frame time grew overall". This uses
 *  the rAF **real interval** to report once per second: n / avg / max (milliseconds), plus the stall
 *  count and the longest stall — above 80 ms it immediately logs a separate `STALL` line. All three
 *  modes are covered, so "does holding a key to turn the view block" is the one line that answers it.
 *  Every counter is a field of the FRAME_PROBE resource (ecs/resources.ts) — the probe's accounts used to
 *  be a dozen module-level `let`s here. */
const FRAME_STALL_MS = 80;
function frameProbe(): void {
  const now = performance.now();
  if (probe.last > 0) {
    const gap = now - probe.last;
    probe.n++;
    probe.sum += gap;
    if (gap > probe.max) probe.max = gap;
    if (gap > FRAME_STALL_MS) {
      probe.stalls++;
      if (gap > probe.stallMax) probe.stallMax = gap;
      logDebug(`STALL gap=${gap.toFixed(0)}ms mode=${loop.mode}`);
    }
  }
  probe.last = now;
  // This frame's mouse: how many samples, how many pixel equivalents (the read clears both)
  const meter = input.takeLookFrameMeter();
  probe.pfBuckets[Math.min(meter.samples, probe.pfBuckets.length - 1)]++;
  if (meter.samples > 0) {
    probe.pxN++;
    probe.pxSum += meter.px;
    if (meter.px < probe.pxMin) probe.pxMin = meter.px;
    if (meter.px > probe.pxMax) probe.pxMax = meter.px;
  }
  if (probe.statAt === 0) {
    probe.statAt = now;
    return;
  }
  if (now - probe.statAt < 1000) return;
  // (The RAWLAG line is printed by `player.input` itself now, right after LOOK: the transport counters
  // moved into INPUT_DIAGNOSTICS, so the system that owns them is the one that formats them.)
  const pf: string[] = [];
  for (let i = 0; i < probe.pfBuckets.length; i++) {
    if (probe.pfBuckets[i] > 0) pf.push(`${i}:${probe.pfBuckets[i]}`);
  }
  logDebug(
    `FRAME n=${probe.n} avg=${(probe.n > 0 ? probe.sum / probe.n : 0).toFixed(2)}ms max=${probe.max.toFixed(1)}ms ` +
      `stalls=${probe.stalls} stallMax=${probe.stallMax.toFixed(0)}ms mode=${loop.mode} locked=${input.locked ? 1 : 0} ` +
      `pf=[${pf.join(" ")}] px=${probe.pxN > 0 ? `${probe.pxMin.toFixed(1)}/${(probe.pxSum / probe.pxN).toFixed(1)}/${probe.pxMax.toFixed(1)}` : "-"} (${probe.pxN})`,
  );
  probe.statAt = now;
  probe.n = 0;
  probe.sum = 0;
  probe.max = 0;
  probe.stalls = 0;
  probe.stallMax = 0;
  probe.pfBuckets.fill(0);
  probe.pxMin = Number.POSITIVE_INFINITY;
  probe.pxMax = 0;
  probe.pxSum = 0;
  probe.pxN = 0;
}

/** One frame. The mode picks the body; the chain re-arms itself, and the try/catch keeps ONE bad frame
 *  from killing the loop for good (a broken chain used to freeze the picture until a restart). */
function frame(): void {
  try {
    applyViewportSize(); // before the mode body: the canvas follows the window whoever is drawing
    // THE LOOK IS APPLIED ONCE PER FRAME, here, before any fixed step: the raw deltas that arrived since
    // the last frame become ONE `look` intent, so a frame's rotation is exactly that frame's mouse
    // movement. It used to be an 8 ms `setInterval` poll feeding several intents per frame, which the
    // browser's input-task priority stretched to 9-12 ms as soon as a key was held (measured: `pf` went
    // from "90% of frames at exactly 2 samples" to a 0/1/2/3 spread) — the judder the user reported.
    input.frameLook();
    if (loop.mode === "game") renderFrame();
    else if (loop.mode === "menu") menuFrame();
    else if (loop.mode === "load") loadFrame();
  } catch (err) {
    logDebug(`frame error: ${String((err as Error)?.message || err)}`);
  }
  // Diagnostics go last: what it measures is the full "this frame to the next" period (a blocked frame
  // body counts into it as well).
  frameProbe();
  requestAnimationFrame(frame);
}

// ===== Loop state: the ONE place that decides what is running =====
// `setLoopMode` is idempotent and is a PURE mode write: the frame chain is already running, so there is
// nothing here to start or stop, and a caller cannot double-start or half-stop anything. Every call site
// says which state it wants (boot, entering a world, back to the main menu) instead of which one to
// leave — it used to be stopLoop()/startLoop(), where stopping had the SIDE EFFECT of starting the ui
// pump and starting then had to undo it two lines later.
function setLoopMode(mode: LoopMode): void {
  if (loop.mode === mode) return;
  loop.mode = mode;
}

/** Is a world being simulated? (What the window blur/focus handlers ask: "are we actually playing".) */
function inWorld(): boolean {
  return loop.mode === "game";
}

// ===== Main-menu background =====
// It is `rendering/menu-background.ts` now: a SYSTEM OBJECT whose state is the MENU_BACKGROUND resource
// (ecs/presentation.ts). The scene, the camera and the two spin numbers used to be four module-level
// `let`s here with this free function beside them — state with no owner, reachable by the menu frame only
// through a closure. The object is built with the other systems below, and a MENU frame calls its step().

logDebug(`BOOT render=rAF(60Hz) winFocused=${winFocused()}`);

// ===== Boot: put the startup screen up, do the slow work behind it, then show the main menu =====
// THE ORDER IS THE FEATURE. Everything below used to happen while the window was still hidden, so the
// startup was a black (or stale) rectangle for as long as it took: `await renderer.init()`, the spawn
// window's generation, and the first ~100 frames of chunk meshing. Now the window is revealed as soon
// as the startup screen has been painted, and each stage below is announced BEFORE its work runs — the
// screen is state (`LOADING_STATE`) and a stage goes through the command barrier + a paint, so what the
// user reads is what the process is doing at that moment.

/** Yield one MACROTASK so the browser can paint what the last frame wrote. Deliberately not a second
 *  requestAnimationFrame chain — the process owns exactly ONE (see the loop above) — and not a
 *  microtask either: a timer task boundary is what lets the compositor present the loading screen
 *  before the GPU handshake and the chunk meshing block the thread. */
function paint(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}
/** Announce a stage, reconcile it NOW and let it paint. `key` is omitted for a stage that only moves
 *  the bar, `note` for the one stage that has something to report. Shared by BOTH flows the screen
 *  serves — the startup and entering a world — which is why it is not named after either. */
function announceStage(stage: BootStage): void {
  world.commands.send(SetLoadingStage, {
    progress: stage.progress,
    ...(stage.key === undefined ? {} : { key: stage.key }),
    ...(stage.withNote ? { noteKey: bootFlow.noteKey, noteValue: bootFlow.noteValue } : {}),
  });
  world.renderUi(); // the barrier + the ui lane: the same pump a menu frame uses
}

/** The walker's dependencies: the loading screen is driven through the COMMAND barrier (which only this
 *  root may do) and the yield is a macrotask (see ecs/boot.ts::BootFlowDeps). */
const flowDeps: BootFlowDeps = {
  announce: announceStage,
  paint: () =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    }),
  now: () => performance.now(),
};

/** Validate the settings FILE against the values that actually took force, repair what cannot be
 *  used, write the corrected file back and report it.
 *
 *  Every config module already validates its own field and silently falls back to a default when it
 *  cannot (`loadLang` ignores a language that is not zh/en/ja, `sanitizeFrameCap` turns a hand-edited
 *  `fpsCap: 1` into 30, `loadBinds` drops a code it does not know). That is the right thing to do at
 *  LOAD time, but it left the file saying one thing while the game used another — so the bad value
 *  survived on disk, unreported, and every launch had to guess again. Comparing the two is what turns
 *  "the game quietly uses 30" into "fpsCap was repaired to 30, on disk, and here is the list".
 *
 *  `inForce` doubles as the SCHEMA: its keys are the settings the engine knows. Anything else in the
 *  file is reported and KEPT — a newer build (or a mod) may have written it, and an older build must
 *  not trim it. */
function checkSettingsAtBoot(): { noteKey: string; noteValue: string } {
  const inForce: Record<string, unknown> = {
    language: getLang(),
    font: getFontId(),
    uiScale: getUIScaleMode(),
    windowMode: getWindowMode(),
    fpsCap: frameCap.cap,
    keybinds: getBindsAll(),
    diagLog: isDiagLogEnabled(),
  };
  const checked = readSettingsChecked();
  if (checked.problem) {
    // Unreadable file. Keep the bytes — a hand-edit typo is worth recovering — and rebuild a complete,
    // valid file from the values in force, so the next launch cannot fail the same way.
    const backup = backupSettingsFile();
    writeSettings({ ...inForce });
    logDebug(`SETTINGS ${checked.problem}; copied to ${backup} and rebuilt from the values in force`);
    return { noteKey: "loading.rebuilt", noteValue: backup };
  }
  const report = diffSettings(checked.settings, inForce);
  if (report.fixed.length === 0 && report.unknown.length === 0) {
    logDebug("SETTINGS ok");
    return { noteKey: "", noteValue: "" };
  }
  if (report.fixed.length > 0) writeSettings(report.merged);
  logDebug(
    `SETTINGS repaired: ${report.fixed.join(", ") || "none"}` +
      (report.unknown.length > 0 ? `; unknown settings kept: ${report.unknown.join(", ")}` : ""),
  );
  // A repair is what the user needs to see; unknown keys are only worth a line when they are all there
  // is to say (nothing was broken, but the file has something this build does not know).
  return report.fixed.length > 0
    ? { noteKey: "loading.fixed", noteValue: report.fixed.join(", ") }
    : { noteKey: "loading.unknown", noteValue: report.unknown.join(", ") };
}

/** The STARTUP flow, as DATA. The order IS the feature and it is now readable in one place; each stage's
 *  work runs after its own announcement has been painted (ecs/boot.ts::runBootFlow). The root font size
 *  is NOT applied here any more: the reconciler applies it (with the font pair) at the top of every frame,
 *  diffed against what it last wrote, so the very first stage already renders at the right size. */
const BOOT_STAGES: readonly BootStage[] = [
  {
    progress: 0,
    key: "loading.settings",
    run: () => {
      // The screen is spawned (hidden) during wiring; this frame is what shows it, and it is also the ONLY
      // place the chain is kicked off. Calling `frame()` directly — instead of scheduling it — keeps this
      // the single place a frame starts from; the call at the END of frame() re-arms it.
      frame();
      // The window is revealed only now, with the loading screen already in the DOM: the manifest hides it
      // at creation ("show": false) precisely so nothing white can flash, and revealing it before the first
      // paint would trade that for a black rectangle.
      showWindow();
      suppressGeometryPause(); // the reveal itself resizes/moves the window
      applyWindowModeAtStart();
      // The settings check's OUTCOME is data (bootFlow.note*), because the stage after this one reports it.
      const settings = checkSettingsAtBoot();
      bootFlow.noteKey = settings.noteKey;
      bootFlow.noteValue = settings.noteValue;
    },
  },
  { progress: 0.2, key: "loading.settings", withNote: true },
  {
    progress: 0.3,
    key: "loading.gpu",
    run: async () => {
      await renderer.init();
      // From here the canvas may be sized (a load frame runs before this point) — and the size comes from
      // the VIEWPORT resource like every later resize, so there is ONE rule for "how big is the canvas".
      loop.rendererReady = true;
      applyViewportSize();
      // The canvas host is read back from the world: "where the game's canvas goes" is world state too.
      world.resource(CANVAS_HOST).appendChild(renderer.domElement);
      logDebug(`BOOT graphics ready at ${(performance.now() - bootFlow.startedAt).toFixed(0)}ms`);
    },
  },
  {
    progress: 1,
    key: "loading.ready",
    // The startup ENDS here: the world is not built at boot any more (`enterWorld()` does that behind this
    // same screen), so the main menu comes up as soon as the GPU can draw. The mode becomes MENU, and the
    // first game frame draws the 3D world over the black clear.
    run: () => {
      renderer.setClearColor(0x000000);
      renderer.clear();
      mainMenu.show();
      pointerLock.applyCursor();
      setLoopMode("menu");
      // Last, the startup screen comes down. Through the barrier like everything else, so the screen and
      // the menu swap inside ONE ui lane — a direct flag write here would leave a frame showing neither.
      world.commands.send(SetLoadingStage, { active: false });
    },
  },
];

async function boot(): Promise<void> {
  const bootStart = performance.now();
  // ACTIVATE the screen before the first stage — and note this line is load-bearing, not decoration:
  // `ui.loading` only paints while LOADING_STATE.active is true (its root is spawned hidden), so a driver
  // that forgets it leaves the window showing the HUD ALONE — a black page with a crosshair and a
  // hotbar on it, which is exactly how that bug was reported. The command lands on the barrier inside
  // the first stage's renderUi, i.e. before anything is revealed.
  world.commands.send(SetLoadingStage, { active: true });
  await runBootFlow(bootFlow, "boot", BOOT_STAGES, flowDeps);
  logDebug(`BOOT ready in ${(performance.now() - bootStart).toFixed(0)}ms`);
}

void boot().catch((err: unknown) => {
  // Loud, and the startup screen deliberately STAYS up: if the GPU or the world generation failed,
  // showing the main menu would offer buttons that cannot work.
  logDebug(`BOOT failed: ${String((err as Error)?.message ?? err)}`);
});