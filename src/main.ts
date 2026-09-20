import * as THREE from "three/webgpu";
import { World } from "./ecs/World";
import { CONTROL, HUMANOID_BODY, spawnPlayer } from "./ecs/components/Player";
import { createFont, createFrameCap, createInputDiagnostics, createInputIntentLog, createInputState, createInputTiming, createKeyEventLog, createKeyMap, createLocale, createPickerState, createScale, createToastState, createUiModalState, LOADING_STATE, createLoadingState, DEBUG_LOG, DELAYED_INTENTS, createDelayedIntents, F3_PANEL, FONT, FPS_CAP, INPUT_DIAGNOSTICS, INPUT_INTENTS, INPUT_STATE, INPUT_TIMING, KEY_EVENTS, KEYMAP, LOCALE, canControl, isMenuUi, isModalUi, INVENTORY_WIDGETS, LOCAL_PLAYER, PICKER_STATE, POINTER, TOAST, UI_MODAL, UI_SCALE, VIEWPORT, VOXEL, createPointer, createViewport, type InputDiagnostics } from "./ecs/resources";
import { SetLoadingStage, SetFpsCap, SetMode, ShowToast, Teleport } from "./ecs/commands";
import { INPUT_ACCESS, PlayerInputSystem } from "./ecs/systems/input";
import { CONTROLLER_ACCESS, PlayerControllerSystem } from "./ecs/systems/controller";
import { MOVEMENT_ACCESS, PlayerMovementSystem } from "./ecs/systems/movement";
import { COLLISION_ACCESS, CollisionSystem } from "./ecs/systems/collision";
import { BlockInteractionSystem, INTERACTION_ACCESS } from "./ecs/systems/interaction";
import { CHUNK_STREAM_ACCESS, ChunkStreamSystem } from "./ecs/systems/chunkstream";
import { PositionSnapshotSystem, SNAPSHOT_ACCESS } from "./ecs/systems/snapshot";
import { DiagnosticsSystem, DIAGNOSTICS_ACCESS } from "./ecs/systems/diagnostics";
import { DELAYS_ACCESS, DelaySystem } from "./ecs/systems/delays";
import { CAMERA_VIEW_ACCESS, CameraViewSystem } from "./rendering/camera-view";
import { MenuBackgroundSystem } from "./rendering/menu-background";
import { defaultUiTheme, UI_THEME } from "./ecs/ui/theme";
import { UI_RENDER_ACCESS, UiRenderSystem } from "./ecs/ui/system";
import { createUiActions, UI_ACTIONS } from "./ecs/ui/actions";
import { createUiSources, UI_BINDING_ACCESS, UiBindingSystem, UI_SOURCES } from "./ecs/ui/bindings";
import { CAMERA3D, CANVAS_HOST, CHUNK_MESHES, createChunkMeshCache, createMenuBackground, MENU_BACKGROUND, PERF_SAMPLER, RENDERER3D, SCENE3D, UI_MOUNT } from "./ecs/presentation";
import { createKeybindGesture, KEYBIND_GESTURE, UI_KEYBIND_ACCESS, UiKeybindSystem } from "./ecs/ui/keybind";
import { spawnPickerPanel, UI_PICKER_ACCESS, UiPickerSystem } from "./ecs/ui/picker";
import { UI_TOAST_ACCESS, UiToastSystem } from "./ecs/ui/toast";
import { UI_LOADING_ACCESS, UiLoadingSystem } from "./ecs/ui/loading";
import { UI_HUD_ACCESS, UiHudSystem } from "./ecs/ui/hud";
import { UI_NAVIGATION_ACCESS, UiNavigationSystem, type NavigationTrees } from "./ecs/ui/navigation";
import { LoadingScreen } from "./ui/loading";
import { Inventory } from "./ui/inventory";
import { INVENTORY_VIEW_ACCESS, UiInventorySystem } from "./ecs/ui/inventory";
import { bindKeybindDrag, boundCodes, cancelKeybindDrag, keycapAtPoint, Menu, spawnKeybindLine } from "./ui/menu";
import { MainMenu } from "./ui/mainmenu";
import { Hud } from "./ui/hud";
import { PointerLock } from "./platform/pointerlock";
import { t, loadLang, getLang, onLangChange, type Lang } from "./ui/i18n";
import { loadUIScaleMode, getUIScaleMode, onUIScaleModeChange, currentRootFontPx, uiStage } from "./ui/uiscale";
import { loadFont, getFontId, onFontChange, currentFontCss } from "./ui/fonts";
import { preloadShell, bootReport, initShell, logDebug, showWindow, isGpuVsyncDisabled, setGpuVsyncDisabled, isDiagLogEnabled, setDiagLogEnabled, winFocused, quitApp, onWinFocus, onWinBlur, onWinGeometry, onCaptureLost, readSettings, readSettingsChecked, backupSettingsFile, diffSettings, writeSettings, getWindowMode, setWindowMode, applyWindowModeAtStart, onWindowModeChange, type WindowMode } from "./platform/shell";
import { startRawInput, centerCursor, rawLagLine } from "./platform/rawinput";
import { installWindowGuards } from "./platform/window-guards";
import { adoptViewport, currentViewport } from "./platform/viewport";
import { DebugLogForwarder } from "./platform/debuglog";
import { PerfSampler } from "./platform/perf";
import { loadBinds, getBind, getBindsAll, getCapturing, onBindsChange, isCapturing, buttonToAction, buttonToCode } from "./platform/keybinds";
import { menuBgKind } from "./ui/background";
import { preloadPacks, resolveTexture } from "./rendering/textures";
import { allBlockIds, loadBlockRegistry } from "./blockregistry";
import { VoxelWorld, WORLD_SURFACE_Y } from "./voxel/world";

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
loadLang(locale, readSettings().language);
loadFont(font, readSettings().font);
loadUIScaleMode(uiScale, readSettings().uiScale);
loadBinds(keymap, readSettings().keybinds);
// The "Diagnostic log" switch (settings panel): the periodic DIAGNOSTIC PROBES are on by default, and the
// setting decides whether `logDebug` writes them. Set BEFORE anything logs a probe line, so a file with
// the switch off never sees one.
setDiagLogEnabled(readSettings().diagLog !== false);
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
onLangChange(saveSettings);
onFontChange(saveSettings);
onUIScaleModeChange(saveSettings);
onWindowModeChange(saveSettings);
onBindsChange(saveSettings);

// Block registry: merge every resource pack's blocks.json across the pack chain. Must run
// before the inventory is constructed (its slots are filled from the registry). The voxel
// mesher deliberately does not consult it yet — it draws the built-in checker block.
loadBlockRegistry();

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
world.insertResource(UI_MOUNT, uiStage);
world.insertResource(CHUNK_MESHES, createChunkMeshCache(chunkGroup));
world.insertResource(MENU_BACKGROUND, createMenuBackground());
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
// The startup screen's state: the boot driver publishes the current stage into it (through the
// SetLoadingStage command) and `ui.loading` paints it — the loading screen is UI, so it is data like every
// other surface, and main.ts never builds an element. See ecs/resources.ts.
world.insertResource(LOADING_STATE, createLoadingState());
// The key bind gesture: created HERE and handed to both ends — the document listeners in ui/menu.ts read
// it synchronously (the click shield decides inside the click it swallows), and ui.keybind applies it
// once per frame. One object, two readers, no second copy of the drag state.
const keybindGesture = createKeybindGesture();
world.insertResource(KEYBIND_GESTURE, keybindGesture);
// Widget theme (every UI colour/space token) + the ACTION TABLE (what a clickable widget's id means)
// + the HUD tree. Spawning widgets is a STRUCTURAL change, so it belongs here during wiring or inside a
// command — never inside a system. The action table is a resource because it is world state too: a
// surface registers its handlers there instead of the reconciler knowing about any surface.
world.insertResource(UI_THEME, defaultUiTheme());
world.insertResource(UI_ACTIONS, createUiActions());
world.insertResource(UI_SOURCES, createUiSources());
const hud = new Hud(world);
// The F3 panel's two widget handles, published for diagnostics (which writes the text) — the HUD view
// spawns the tree, the system owns the data written into it.
world.insertResource(F3_PANEL, hud.debugPanelEntities);
const picker = spawnPickerPanel(world);
// The startup screen's tree: spawned hidden during wiring (spawning is a structural change, so it
// belongs here or inside a command) and shown for as long as LOADING_STATE.active says the startup runs.
const loadingScreen = new LoadingScreen(world);

// The device layer takes the canvas from RENDERER3D (the renderer's domElement) and the camera from
// CAMERA3D, the chunk stream takes the CHUNK_MESHES cache — the presentation objects are resources now,
// so no system is handed one. See ecs/presentation.ts.
const input = new PlayerInputSystem(world, logDebug, inWorld);
const controller = new PlayerControllerSystem(world);
const movement = new PlayerMovementSystem(world);
const collision = new CollisionSystem(world);
const cameraView = new CameraViewSystem(world);
const snapshot = new PositionSnapshotSystem(world);
const chunkStream = new ChunkStreamSystem(world);
// The reconciler that owns every widget's DOM element. It mounts roots on the world's UI_MOUNT resource
// (the same element the hand-written HUD/menus used) and gets the i18n lookup injected, so ecs/ never
// imports src/ui/.
// `fontCss` / `rootFontPx` come along for the same reason: the FONT and UI_SCALE resources hold the
// values, and the reconciler — the one system allowed to write the DOM — is what applies them to the
// document root (see its reconcileAppliedStyle).
const uiRender = new UiRenderSystem(world, {
  translate: t,
  fontCss: currentFontCss,
  rootFontPx: currentRootFontPx,
  log: logDebug,
});
// Resolves every BOUND widget's value from its source (ecs/ui/bindings.ts), so a slider that shows
// shared state never holds a private copy of it.
const uiBindings = new UiBindingSystem(world, logDebug);
// The F3+F4 picker: the F3 debug panel and the mode chord are GAMEPLAY UI, so they are gated on
// `inWorld()` — outside a world (the main menu, and the loading screen while a world is built) it
// consumes the key edges and does nothing, and it takes its own panels down. The HUD toast below is
// NOT gated: a main-menu toast is a documented case (the multiplayer placeholder is drawn by the menu
// frame, which is the reason the ui lane can be pumped with no world running).
const uiPicker = new UiPickerSystem(world, {
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
const uiToast = new UiToastSystem(world, hud.toastPanel, hud.toastText);
// The startup screen's painter: it reads LOADING_STATE and writes the boot tree's widgets, so it is in
// the ui lane with the other widget-data writers — that lane is also the only one that runs in `load`
// mode, which is exactly the mode the screen is shown in.
const uiLoading = new UiLoadingSystem(world, loadingScreen);
// The key bind drag's data: derived every frame from the bind table + the GESTURE + the POINTER resource,
// with the platform reads injected so this layer stays free of platform imports (and so the gate can drive
// it with fakes). `line` is the rubber-band WIDGET the view only spawns — the system writes its geometry.
const keybindLine = spawnKeybindLine(world);
const uiKeybind = new UiKeybindSystem(world, {
  boundCodes,
  capturing: getCapturing,
  bindOf: getBind,
  line: keybindLine,
  keycapAt: keycapAtPoint,
});
// The key bind drag asks the UI SYSTEM what is under the cursor: only it owns the elements (the
// hand-written panel kept its own cross-instance table of keycap elements to do this).
bindKeybindDrag({ world, hitTest: (x, y) => uiRender.hitTest(x, y), gesture: keybindGesture });
// No callback into the UI any more: the interaction system reads the entity's INVENTORY component
// itself, so the hand you see and the hand that places a block cannot disagree.
const interaction = new BlockInteractionSystem(world);
scene.add(interaction.outline);
const diagnostics = new DiagnosticsSystem(world);
// The main-menu background step (deliberately not registered in a lane — the MENU frame is its only
// caller, see rendering/menu-background.ts).
const menuBg = new MenuBackgroundSystem(world);

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
const inv = new Inventory(world, player);
// The handles the reconcile writes into (the view only spawns them): `ui.inventory` reads the component
// and writes these widgets, which is why the view is no longer called once per frame.
world.insertResource(INVENTORY_WIDGETS, inv.widgets);
const uiInventory = new UiInventorySystem(world);
// The GAMEPLAY widgets' visibility: the crosshair and the hotbar exist in every mode (they were spawned
// visible and nothing wrote their flag), so one system owns that flag and derives it from "is a world
// running". It needs the hotbar, which is why it is built here rather than with the other UI systems.
const uiHud = new UiHudSystem(world, {
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
world.addSystem({
  // The device layer: pointer-lock state machine + mouse/key/bind capture. The DOM listeners decide
  // nothing for the schedule — they queue intents (input.ts) — and its `after`/`before` edges below are
  // the REAL ones the conflict rule demands: it writes the VIEW the controller settles, and it reads
  // the ORIENTATION/POSITION/BODY the later systems write for its logs.
  //
  // The edge to `motion.snapshot` is a PESSIMISATION, and deliberately kept: the two commute (disjoint
  // writes), so this costs input its own batch 0 instead of sharing it with the snapshot. What it buys
  // is the property the docs state — the drain is the tick's first act — and it leaves the pair
  // `motion.snapshot ~ player.controller`, which the gate replays in both orders, exactly where it was.
  name: "player.input",
  stage: "fixed",
  before: ["motion.snapshot", "player.controller"],
  ...INPUT_ACCESS,
  run: () => input.step(),
});
world.addSystem({
  name: "motion.snapshot",
  stage: "fixed",
  ...SNAPSHOT_ACCESS,
  run: () => snapshot.step(),
});
world.addSystem({
  name: "player.controller",
  stage: "fixed",
  ...CONTROLLER_ACCESS,
  run: () => controller.step(),
});
world.addSystem({
  // BOTH dependencies are real and both are declared: it reads the ORIENTATION that controller
  // writes, and it writes the POSITION that the snapshot had to freeze first. The old single edge
  // (controller after snapshot) ordered the snapshot against the camera instead of against this.
  name: "player.movement",
  stage: "fixed",
  after: ["player.controller", "motion.snapshot"],
  ...MOVEMENT_ACCESS,
  run: (ctx) => movement.step(ctx.dt),
});
world.addSystem({
  name: "player.collision",
  stage: "fixed",
  after: ["player.movement"],
  ...COLLISION_ACCESS,
  run: () => collision.step(),
});
world.addSystem({
  name: "player.interaction",
  stage: "fixed",
  after: ["player.collision"],
  ...INTERACTION_ACCESS,
  run: (ctx) => interaction.step(ctx.dt),
});
// NO edges between the four producers below: they touch disjoint things (the camera, the chunk
// meshes, the hotbar, the F3 panel), which is what the report's "6 parallel pair(s)" means. The old
// cameraView.render -> chunk.stream -> ui.inventory -> diagnostics chain was ordering for no data
// reason at all, and it was hiding that parallelism.
world.addSystem({
  name: "cameraView.render",
  stage: "render",
  ...CAMERA_VIEW_ACCESS,
  run: (ctx) => cameraView.render(ctx.alpha),
});
world.addSystem({
  name: "chunk.stream",
  stage: "render",
  ...CHUNK_STREAM_ACCESS,
  run: () => chunkStream.step(),
});
world.addSystem({
  // The GAMEPLAY widgets' gate, FIRST in the lane: it decides whether the crosshair and the hotbar are
  // on screen at all, and it writes the same component (UI_STATE) as every writer after it, so the
  // conflict rule demands an order — this is the honest one ("what may the lane show" comes first). It
  // shares the first batch with ui.bindings: that pair touches disjoint components (UI_INPUT vs
  // UI_STATE) and may therefore run in either order.
  name: "ui.hud",
  stage: "ui",
  before: ["ui.loading"],
  ...UI_HUD_ACCESS,
  run: () => uiHud.step(),
});
world.addSystem({
  // The loading screen (the startup, and a world entry). Registered right after the gameplay gate and
  // before the other widget-data writers: it writes the same components (UI_STATE / UI_TEXT) as all of
  // them, so the conflict rule demands an order and the honest one is "the loading screen is painted
  // before the surfaces it hides behind it".
  name: "ui.loading",
  stage: "ui",
  before: ["ui.inventory"],
  ...UI_LOADING_ACCESS,
  run: () => uiLoading.step(),
});
world.addSystem({
  name: "ui.inventory",
  stage: "ui",
  ...INVENTORY_VIEW_ACCESS,
  run: () => uiInventory.step(),
});
world.addSystem({
  name: "diagnostics",
  stage: "render",
  ...DIAGNOSTICS_ACCESS,
  run: (ctx) => diagnostics.step(ctx.dt),
});
world.addSystem({
  // Bound widget values (a slider that shows shared state), resolved before the reconciler reads them.
  // It writes UI_INPUT only, so it shares a batch with ui.inventory (disjoint components).
  name: "ui.bindings",
  stage: "ui",
  ...UI_BINDING_ACCESS,
  run: () => uiBindings.step(),
});
world.addSystem({
  // The F3+F4 picker. It writes UI_STATE/UI_TEXT (the picker panel's items and the F3 panel's
  // visibility), and ui.inventory writes the same COMPONENTS on different entities — the conflict model
  // is per component, not per entity, so the order has to be declared. That is a pessimisation (they
  // touch nothing of each other's) and it costs the ui lane its only parallel pair.
  name: "ui.picker",
  stage: "ui",
  after: ["ui.inventory"],
  ...UI_PICKER_ACCESS,
  run: () => uiPicker.step(),
});
world.addSystem({
  // The HUD toast: same component-level conflict as ui.picker, so it follows it. It is the reason the
  // ui lane is pumped while the game loop is stopped (a main-menu toast has no frame to ride).
  name: "ui.toast",
  stage: "ui",
  after: ["ui.picker"],
  ...UI_TOAST_ACCESS,
  run: () => uiToast.step(),
});
world.addSystem({
  // The bind panels (derived data) and the drag highlight/rubber band, ordered after the other widget
  // writers by the same component-level rule.
  name: "ui.keybind",
  stage: "ui",
  after: ["ui.toast"],
  ...UI_KEYBIND_ACCESS,
  run: () => uiKeybind.step(),
});
// ui.navigation steps LAST in the ui lane and needs the modal widget trees, which the surfaces build
// further down — so it is registered HERE (before ui.widgets, which must follow it) and its trees arrive
// through a getter that is filled once they exist. The schedule resolves edges at start(), so an `after`
// naming a system registered later would silently drop the edge.
let navTrees: NavigationTrees | null = null;
const navigation = new UiNavigationSystem(world, {
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
  cancelDrag: (reason) => cancelKeybindDrag(reason),
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
world.addSystem({
  name: "ui.navigation",
  stage: "ui",
  after: ["ui.keybind"],
  ...UI_NAVIGATION_ACCESS,
  run: () => navigation.step(),
});
// The delayed intents (ecs/systems/delays.ts): whatever deadline has passed is applied HERE — after the
// system that decided it, before the frame is painted. Both halves of that order are FORCED rather than
// stylistic: it writes the two targets ui.navigation writes (`pointerLock` / `cursor`), which the schedule
// refuses to leave unordered, and the reconciler must stay the last system in the lane.
const delays = new DelaySystem(world, {
  relock: (reason) => pointerLock.relock(reason),
  lockRetry: (source) => pointerLock.retry(source),
  cursor: () => pointerLock.applyCursor(),
  log: logDebug,
});
world.addSystem({
  name: "ui.delays",
  stage: "ui",
  after: ["ui.navigation"],
  before: ["ui.widgets"],
  ...DELAYS_ACCESS,
  run: () => delays.step(),
});
world.addSystem({
  // Ordered by a REAL dependency: every system above WRITES widget data (icons, counts, the selected
  // flag, slider values, the picker, the toast, the chips/keycaps, the modal trees) and this one reads
  // all of it before reconciling the elements. Stage order runs the ui lane after the render lane, which
  // is the other half of the guarantee: everything `diagnostics` wrote this frame is already in place.
  name: "ui.widgets",
  stage: "ui",
  after: ["ui.inventory", "ui.bindings", "ui.picker", "ui.toast", "ui.keybind", "ui.navigation"],
  ...UI_RENDER_ACCESS,
  run: () => uiRender.step(),
});
// The size the draw last applied to the renderer — this system's own state (it owns the framebuffer).
world.addSystem({
  // Ordered by what it READS: it consumes the camera and the chunk meshes, so the schedule itself
  // keeps it after their producers.
  name: "renderer.draw",
  stage: "render",
  after: ["cameraView.render", "chunk.stream"],
  readsExternal: ["camera3d", "chunkMeshes"],
  writesExternal: ["framebuffer"],
  // It reads the three objects it draws with from the WORLD, not from wiring variables: they are
  // resources now (SCENE3D / CAMERA3D / RENDERER3D — see ecs/presentation.ts). The declared targets
  // above stay as they are: the schedule models those NAMES, not the resource handles.
  // It does NOT resize the canvas: that belongs to the FRAME, not to this lane (see applyViewportSize).
  run: () => world.resource(RENDERER3D).render(world.resource(SCENE3D), world.resource(CAMERA3D)),
});

// (world.start() moved below: ui.navigation needs the widget trees the surfaces build during wiring.)

// Raw mouse input (Rust plugin): takes over view rotation when pointer lock is cancelled with the window partially offscreen.
// **Decided on event arrival, applied ONCE per frame**: `rawDelta` runs the takeover/grace/spike
// decision in every event and accumulates the part that passes; `frame()` calls `input.frameLook()`
// once per frame to queue it as ONE look intent — the view no longer goes through any timer (the old
// 8 ms `setInterval` was stretched to 9-12 ms steps by key events, which is exactly "holding a key
// turns the view unsmoothly").
const rawInput = startRawInput((dx, dy) => input.rawDelta(dx, dy));
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
 *  pause menu. Rust still re-clips the capture rectangle for them (win::reclip_mouse_capture). */
let suppressGeometryUntil = 0;
const suppressGeometryPause = (): void => {
  suppressGeometryUntil = performance.now() + 800;
};

const onSetWindowMode = (mode: WindowMode): void => {
  suppressGeometryPause(); // our own window-mode change is NOT "the user is messing with the window"
  setWindowMode(mode);
    logDebug(`window mode ${mode === "fullscreen" ? "fullscreen" : "windowed"}`);
};

const menu = new Menu(world, {
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
    await loadingStage(0, "world.spawn");
    await loadingStage(0.15, "world.terrain");
    // Generate (no meshing) the spawn window: collision needs real blocks on the very first tick.
    chunkStream.prime(SPAWN.x, SPAWN.z);
    await loadingStage(0.2, "world.chunks");
    await chunkStream.warmUp(paint, (done, total) => {
      // The bar owns almost the whole entry: the GPU was paid for at boot.
      world.commands.send(SetLoadingStage, { progress: total > 0 ? 0.2 + 0.75 * (done / total) : 0.2 });
    });
    await loadingStage(1, "world.ready");
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
const mainMenu = new MainMenu(world, {
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
  mainPanels: mainMenu.panelEntities,
  inventoryPanel: inv.panelEntity,
};

world.start();
for (const line of world.scheduleReport()) logDebug(line);
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
  if (performance.now() < suppressGeometryUntil) return; // our own fullscreen/windowed switch
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
type LoopMode = "load" | "game" | "menu";

let loopMode: LoopMode = "load"; // "load" until the bottom of this file picks a mode, so the first transition always applies
// Fixed-step physics: step size + time accumulator (decoupled from frame timing, MC-style fixed tps)
const PHYS_DT = 1 / 120;
let physAcc = 0;
let renderAcc = 0;

/** The game's frame: advance the simulation at a FIXED step (frame-rate independent movement), gate
 *  drawing and stats on the frame cap, then run the render lane and the ui lane. */
function renderFrame(): void {
  timer.update();
  const delta = Math.min(timer.getDelta(), 0.1);

    // Fixed-step physics advance: movement is independent of frame duration, constant per step (removes movement jitter from uneven frame timing)
  physAcc += delta;
  let steps = 0;
  while (physAcc >= PHYS_DT && steps < 12) {
    world.stepFixed(PHYS_DT);
    physAcc -= PHYS_DT;
    steps++;
  }

  // FPS cap gate: skip rendering and stats until the frame budget is reached (physics already advanced above at fixed steps)
  if (frameCap.cap > 0) {
    const budget = 1 / frameCap.cap;
    renderAcc += delta;
    if (renderAcc < budget) return;
    renderAcc %= budget;
  }

  // Per-frame systems: view interpolation -> chunk meshing -> diagnostics -> draw
  // (alpha = remainder of the physics tick). The ECS command barrier runs first inside render().
  world.render(Math.min(physAcc / PHYS_DT, 1), delta);
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
 */
let appliedViewportW = 0;
let appliedViewportH = 0;
let rendererReady = false;
function applyViewportSize(): void {
  if (!rendererReady) return;
  const vp = world.resource(VIEWPORT);
  if (vp.width <= 0 || vp.height <= 0) return;
  if (vp.width === appliedViewportW && vp.height === appliedViewportH) return;
  appliedViewportW = vp.width;
  appliedViewportH = vp.height;
  renderer.setSize(vp.width, vp.height);
}

/** ===== FRAME diagnostics (one line per second + stall warnings) =====
 *  Why it is needed: `PHYS` (diagnostics) only runs in game mode at a 500 ms granularity, and on its own
 *  it cannot tell "the main thread was occupied for a moment" from "frame time grew overall". This uses
 *  the rAF **real interval** to report once per second: n / avg / max (milliseconds), plus the stall
 *  count and the longest stall — above 80 ms it immediately logs a separate `STALL` line. All three
 *  modes are covered, so "does holding a key to turn the view block" is the one line that answers it. */
const FRAME_STALL_MS = 80;
let frameLast = 0;
let frameN = 0;
let frameSum = 0;
let frameMax = 0;
let frameStalls = 0;
let frameStallMax = 0;
let frameStatAt = 0;
/** Histogram of the per-frame look sample count (index = count, 0..12 folded into the last bucket) + the
 *  min/avg/max of the per-frame mouse pixel equivalent. These two numbers answer what the `LOOK`/`RAWLAG`
 *  lines **cannot**: whether the view advances evenly per frame or in an uneven number of samples per
 *  frame (polling at 8 ms ≈ 1.67 samples/frame → a 2,2,1 pattern; when turning fast that is the
 *  "one notch at a time" the eye sees). */
const framePfBuckets = new Array<number>(13).fill(0);
let framePxMin = Number.POSITIVE_INFINITY;
let framePxMax = 0;
let framePxSum = 0;
let framePxN = 0;
function frameProbe(): void {
  const now = performance.now();
  if (frameLast > 0) {
    const gap = now - frameLast;
    frameN++;
    frameSum += gap;
    if (gap > frameMax) frameMax = gap;
    if (gap > FRAME_STALL_MS) {
      frameStalls++;
      if (gap > frameStallMax) frameStallMax = gap;
      logDebug(`STALL gap=${gap.toFixed(0)}ms mode=${loopMode}`);
    }
  }
  frameLast = now;
  // This frame's mouse: how many samples, how many pixel equivalents (the read clears both)
  const meter = input.takeLookFrameMeter();
  framePfBuckets[Math.min(meter.samples, framePfBuckets.length - 1)]++;
  if (meter.samples > 0) {
    framePxN++;
    framePxSum += meter.px;
    if (meter.px < framePxMin) framePxMin = meter.px;
    if (meter.px > framePxMax) framePxMax = meter.px;
  }
  if (frameStatAt === 0) {
    frameStatAt = now;
    return;
  }
  if (now - frameStatAt < 1000) return;
  // RAWLAG follows the once-per-second line as well (it used to hang off the deleted 8 ms poll, and is
  // driven by the frame probe now).
  const lag = rawLagLine();
  if (lag) logDebug(lag);
  const pf: string[] = [];
  for (let i = 0; i < framePfBuckets.length; i++) if (framePfBuckets[i] > 0) pf.push(`${i}:${framePfBuckets[i]}`);
  logDebug(
    `FRAME n=${frameN} avg=${(frameN > 0 ? frameSum / frameN : 0).toFixed(2)}ms max=${frameMax.toFixed(1)}ms ` +
      `stalls=${frameStalls} stallMax=${frameStallMax.toFixed(0)}ms mode=${loopMode} locked=${input.locked ? 1 : 0} ` +
      `pf=[${pf.join(" ")}] px=${framePxN > 0 ? `${framePxMin.toFixed(1)}/${(framePxSum / framePxN).toFixed(1)}/${framePxMax.toFixed(1)}` : "-"} (${framePxN})`,
  );
  frameStatAt = now;
  frameN = 0;
  frameSum = 0;
  frameMax = 0;
  frameStalls = 0;
  frameStallMax = 0;
  framePfBuckets.fill(0);
  framePxMin = Number.POSITIVE_INFINITY;
  framePxMax = 0;
  framePxSum = 0;
  framePxN = 0;
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
    if (loopMode === "game") renderFrame();
    else if (loopMode === "menu") menuFrame();
    else if (loopMode === "load") loadFrame();
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
  if (loopMode === mode) return;
  loopMode = mode;
}

/** Is a world being simulated? (What the window blur/focus handlers ask: "are we actually playing".) */
function inWorld(): boolean {
  return loopMode === "game";
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
async function loadingStage(
  progress: number,
  key?: string,
  note?: { readonly key: string; readonly value: string },
): Promise<void> {
  world.commands.send(SetLoadingStage, {
    progress,
    ...(key === undefined ? {} : { key }),
    ...(note === undefined ? {} : { noteKey: note.key, noteValue: note.value }),
  });
  world.renderUi(); // the barrier + the ui lane: the same pump a menu frame uses
  await paint();
}

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

async function boot(): Promise<void> {
  const bootStart = performance.now();
  // The root font size is NOT applied here any more. It used to be a hand-written `applyUIScale()` call
  // before the first stage; now the reconciler applies it (with the font pair) on every frame, diffed
  // against what it last wrote — and it does so at the TOP of the step, before it paints a single widget,
  // so the very first stage already renders at the right size and the loading screen needs no special case.
  // ACTIVATE the screen before the first stage — and note this line is load-bearing, not decoration:
  // `ui.loading` only paints while LOADING_STATE.active is true (its root is spawned hidden), so a driver
  // that forgets it leaves the window showing the HUD ALONE — a black page with a crosshair and a
  // hotbar on it, which is exactly how that bug was reported. The command lands on the barrier inside
  // the first stage's renderUi, i.e. before anything is revealed.
  world.commands.send(SetLoadingStage, { active: true });
  // The screen is spawned (hidden) during wiring; this frame is what shows it, and it is also the ONLY
  // place the chain is kicked off. Calling `frame()` directly — instead of scheduling it — keeps this
  // the single place a frame starts from; the call at the END of frame() re-arms it.
  await loadingStage(0, "loading.settings");
  frame();
  // The window is revealed only now, with the loading screen already in the DOM: the manifest hides it
  // at creation ("show": false) precisely so nothing white can flash, and revealing it before the first
  // paint would trade that for a black rectangle.
  showWindow();
  suppressGeometryPause(); // the reveal itself resizes/moves the window
  applyWindowModeAtStart();

  const settings = checkSettingsAtBoot();
  await loadingStage(0.2, "loading.settings", { key: settings.noteKey, value: settings.noteValue });

  await loadingStage(0.3, "loading.gpu");
  await renderer.init();
  // From here the canvas may be sized (a load frame runs before this point) — and the size comes from the
  // VIEWPORT resource like every later resize, so there is ONE rule for "how big is the canvas".
  rendererReady = true;
  applyViewportSize();
  // The canvas host is read back from the world: "where the game's canvas goes" is world state too.
  world.resource(CANVAS_HOST).appendChild(renderer.domElement);
  logDebug(`BOOT graphics ready at ${(performance.now() - bootStart).toFixed(0)}ms`);

  // The world is NOT built here any more: `enterWorld()` does that behind this same screen (see its
  // header). The startup ends as soon as the GPU can draw, so the main menu comes up fast.
  await loadingStage(1, "loading.ready");
  // The main menu is up and nothing is simulated, so the mode becomes MENU; entering a world switches
  // it to "game" (via the `load` mode, while the world is built), and the first game frame draws the 3D
  // world over the black clear below.
  renderer.setClearColor(0x000000);
  renderer.clear();
  mainMenu.show();
  pointerLock.applyCursor();
  setLoopMode("menu");
  // Last, the startup screen comes down. Through the barrier like everything else, so the screen and
  // the menu swap inside ONE ui lane — a direct flag write here would leave a frame showing neither.
  world.commands.send(SetLoadingStage, { active: false });
  logDebug(`BOOT ready in ${(performance.now() - bootStart).toFixed(0)}ms`);
}

void boot().catch((err: unknown) => {
  // Loud, and the startup screen deliberately STAYS up: if the GPU or the world generation failed,
  // showing the main menu would offer buttons that cannot work.
  logDebug(`BOOT failed: ${String((err as Error)?.message ?? err)}`);
});