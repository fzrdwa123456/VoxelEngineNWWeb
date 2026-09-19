import * as THREE from "three/webgpu";
import { World } from "./ecs/World";
import { CONTROL, HUMANOID_BODY, spawnPlayer } from "./ecs/components/Player";
import { createFont, createFrameCap, createInputState, createKeyEventLog, createKeyMap, createLocale, createPickerState, createScale, createToastState, createUiModalState, LOADING_STATE, createLoadingState, FONT, FPS_CAP, INPUT_STATE, KEY_EVENTS, KEYMAP, LOCALE, canControl, isMenuUi, isModalUi, LOCAL_PLAYER, PICKER_STATE, TOAST, UI_MODAL, UI_SCALE, VOXEL } from "./ecs/resources";
import { SetLoadingStage, SetFpsCap, SetMode, ShowToast, Teleport } from "./ecs/commands";
import { INPUT_ACCESS, PlayerInputSystem } from "./ecs/systems/input";
import { CONTROLLER_ACCESS, PlayerControllerSystem } from "./ecs/systems/controller";
import { MOVEMENT_ACCESS, PlayerMovementSystem } from "./ecs/systems/movement";
import { COLLISION_ACCESS, CollisionSystem } from "./ecs/systems/collision";
import { BlockInteractionSystem, INTERACTION_ACCESS } from "./ecs/systems/interaction";
import { CHUNK_STREAM_ACCESS, ChunkStreamSystem } from "./ecs/systems/chunkstream";
import { PositionSnapshotSystem, SNAPSHOT_ACCESS } from "./ecs/systems/snapshot";
import { DiagnosticsSystem, DIAGNOSTICS_ACCESS } from "./ecs/systems/diagnostics";
import { CAMERA_VIEW_ACCESS, CameraViewSystem } from "./rendering/camera-view";
import { defaultUiTheme, UI_THEME } from "./ecs/ui/theme";
import { UI_RENDER_ACCESS, UiRenderSystem } from "./ecs/ui/system";
import { createUiActions, UI_ACTIONS } from "./ecs/ui/actions";
import { createUiSources, UI_BINDING_ACCESS, UiBindingSystem, UI_SOURCES } from "./ecs/ui/bindings";
import { createKeybindGesture, KEYBIND_GESTURE, UI_KEYBIND_ACCESS, UiKeybindSystem } from "./ecs/ui/keybind";
import { spawnPickerPanel, UI_PICKER_ACCESS, UiPickerSystem } from "./ecs/ui/picker";
import { UI_TOAST_ACCESS, UiToastSystem } from "./ecs/ui/toast";
import { UI_LOADING_ACCESS, UiLoadingSystem } from "./ecs/ui/loading";
import { UI_HUD_ACCESS, UiHudSystem } from "./ecs/ui/hud";
import { UI_NAVIGATION_ACCESS, UiNavigationSystem, type NavigationTrees } from "./ecs/ui/navigation";
import { LoadingScreen } from "./ui/loading";
import { Inventory, INVENTORY_VIEW_ACCESS } from "./ui/inventory";
import { bindKeybindDrag, boundCodes, hideKeybindLine, Menu, showKeybindLine } from "./ui/menu";
import { MainMenu } from "./ui/mainmenu";
import { Hud } from "./ui/hud";
import { PointerLock } from "./platform/pointerlock";
import { t, loadLang, getLang, onLangChange, type Lang } from "./ui/i18n";
import { loadUIScaleMode, getUIScaleMode, onUIScaleModeChange, applyUIScale, uiStage } from "./ui/uiscale";
import { loadFont, getFontId, onFontChange } from "./ui/fonts";
import { preloadShell, bootReport, initShell, logDebug, showWindow, isGpuVsyncDisabled, setGpuVsyncDisabled, winFocused, quitApp, onWinFocus, onWinBlur, readSettings, readSettingsChecked, backupSettingsFile, diffSettings, writeSettings, getWindowMode, setWindowMode, applyWindowModeAtStart, onWindowModeChange, type WindowMode } from "./platform/shell";
import { startRawInput, centerCursor } from "./platform/rawinput";
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

// ===== Tauri：同步前置（这个 port 唯一一处启动顺序上的改动）=====
// 原 NW.js 版这里不用等任何东西：require("node:fs") 是同步的，nw.Window 也已经在了。
// Tauri 的命令是**异步**的，而下面 loadLang/loadFont/loadBinds 以及整个 UI 都同步读设置与资源包，
// 所以先把这两样一次性取进内存：
//   preloadShell() -> settings / 窗口模式 / vsync 开关（之后 readSettings() 读内存，保持同步）
//   preloadPacks() -> resourcepacks + mods 的全部字节（之后 resolveTexture() 保持同步）
// 顶层 await 需要 ESM（index.html 本来就是 <script type="module">）。
// **包一层 try/catch**：这里抛出去的话整个模块就死了，而那时 initShell() 还没跑，
// 错误最后不会落到任何地方 —— 现象是"进程活着、没有窗口、日志 0 字节"的静默失败。
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
const saveSettings = (fpsCapOverride?: number): void => {
    // Read-modify-write merge, avoids clobbering other settings (windowMode etc.)
  const s = readSettings();
  s.language = getLang();
  s.font = getFontId();
  s.uiScale = getUIScaleMode();
  s.windowMode = getWindowMode();
  s.keybinds = getBindsAll();
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

const app = document.getElementById("app")!;

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
// 光标策略要读它（canControl），所以留一个引用
const inputState = createInputState();
world.insertResource(INPUT_STATE, inputState);
world.insertResource(UI_MODAL, uiModal);
world.insertResource(VOXEL, voxel);
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
const picker = spawnPickerPanel(world);
// The startup screen's tree: spawned hidden during wiring (spawning is a structural change, so it
// belongs here or inside a command) and shown for as long as LOADING_STATE.active says the startup runs.
const loadingScreen = new LoadingScreen(world);

const input = new PlayerInputSystem(world, renderer.domElement, logDebug);
const controller = new PlayerControllerSystem(world);
const movement = new PlayerMovementSystem(world);
const collision = new CollisionSystem(world);
const cameraView = new CameraViewSystem(world, camera);
const snapshot = new PositionSnapshotSystem(world);
const chunkStream = new ChunkStreamSystem(world, chunkGroup);
// The reconciler that owns every widget's DOM element. It mounts roots on uiStage (the same element the
// hand-written HUD/menus used) and gets the i18n lookup injected, so ecs/ never imports src/ui/.
const uiRender = new UiRenderSystem(world, { mount: uiStage, translate: t, log: logDebug });
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
// The bind panels' data: derived every frame from the bind table, with the platform reads injected so
// this layer stays free of platform imports (and so the gate can drive it with fakes).
const uiKeybind = new UiKeybindSystem(world, {
  boundCodes,
  capturing: getCapturing,
  bindOf: getBind,
  showLine: showKeybindLine,
  hideLine: hideKeybindLine,
});
// The key bind drag asks the UI SYSTEM what is under the cursor: only it owns the elements (the
// hand-written panel kept its own cross-instance table of keycap elements to do this).
bindKeybindDrag({ world, hitTest: (x, y) => uiRender.hitTest(x, y), gesture: keybindGesture });
// No callback into the UI any more: the interaction system reads the entity's INVENTORY component
// itself, so the hand you see and the hand that places a block cannot disagree.
const interaction = new BlockInteractionSystem(world);
scene.add(interaction.outline);
const diagnostics = new DiagnosticsSystem(world, {
  perf,
  hud,
  renderer,
  debugLog: dbgFwd,
  queues: input,
  logDebug,
});

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
  run: () => inv.sync(),
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
  // 原生捕获：不走 document.exitPointerLock（见 platform/mousecapture.ts）
  exitPointerLock: () => input.releaseCapture(),
  centerCursor,
  relock: (reason) => pointerLock.relock(reason),
  relockSoon: (reason) => setTimeout(() => pointerLock.relock(reason), 0),
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
world.addSystem({
  // Ordered by what it READS: it consumes the camera and the chunk meshes, so the schedule itself
  // keeps it after their producers.
  name: "renderer.draw",
  stage: "render",
  after: ["cameraView.render", "chunk.stream"],
  readsExternal: ["camera3d", "chunkMeshes"],
  writesExternal: ["framebuffer"],
  run: () => renderer.render(scene, camera),
});

// (world.start() moved below: ui.navigation needs the widget trees the surfaces build during wiring.)

// Raw mouse input (Rust plugin): takes over view rotation when pointer lock is cancelled with the window partially offscreen.
// The 8 ms poll now lives in the device layer (`input.startRawPolling`), which is where a device cadence
// belongs; whether the deltas are USED is decided inside input.applyRawInput (discarded when locked/in menus).
const rawInput = startRawInput();
input.startRawPolling(rawInput);
// **必须等 ready 落地再赋值。** 原版 startRawInput() 是同步 NAPI，available 当场为真，
// 所以这里原来是 `input.rawInputActive = rawInput.available` 一行同步赋值；Tauri 版它是
// `invoke("rawinput_start").then()` 才置真的，同步读会**永久**拿到 false ——
// 后果是原生鼠标捕获永远不启用（退回浏览器的 requestPointerLock，又撞上 ESC 解锁 + 冷却），
// 同时 raw-input 的视角接管也一起失效。这个坑真踩过。
void rawInput.ready.then((ok) => {
  input.rawInputActive = ok;
  logDebug(
    `RAWINPUT active=${ok} -> 鼠标捕获走${ok ? "**原生 ClipCursor**（不碰浏览器指针锁定）" : "浏览器 requestPointerLock（原始输入不可用）"}`,
  );
});

// Pointer lock manager: referenced by the menu callbacks; declared with let then assigned, avoiding a circular dependency
let pointerLock: PointerLock;

pointerLock = new PointerLock({
  input,
  isUiModal: uiOpen,
  // 光标的判据：玩家**真的在控制鼠标**才隐藏。不能用 !isUiModal —— 加载界面不占模态面，
  // 那样会让加载界面把光标藏起来（历史遗留 bug）。
  canControl: () => canControl(inputState, uiModal),
  logDebug,
});

// Diagnostics: record pointer lock state changes (locked/unlocked done) to verify cursor-centering races
document.addEventListener("pointerlockchange", () => {
    logDebug(`LOCKCHANGE ${document.pointerLockElement ? "locked" : "unlocked"}`);
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

// Window mode: runtime enter/leaveFullscreen switch (no restart); exiting fullscreen goes through the settings panel "windowed"
const onSetWindowMode = (mode: WindowMode): void => {
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
  pointerLock.relock("world entered");
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
onWinBlur(() => {
  // 诊断：**无条件**记录一次（原来那行只在真的开菜单时才打，看不到"事件有没有来"）
  logDebug(`WINFOCUS blur inWorld=${inWorld()} uiOpen=${uiOpen()} locked=${input.locked}`);
  input.prepareUnlock();
  // 交出鼠标：原生捕获要在这里放掉（Rust 侧失焦也会兜底释放）
  input.releaseCapture();
  if (inWorld() && !uiOpen()) {
    menu.show();
    pointerLock.applyCursor();
        logDebug("BLUR lost focus -> pause menu");
  }
});
onWinFocus(() => {
  // 诊断：**无条件**记录一次
  logDebug(`WINFOCUS focus inWorld=${inWorld()} uiOpen=${uiOpen()} locked=${input.locked}`);
  // 切回来先把光标补回来：Chromium 缓存的 cursor 可能还是失焦前那个 NULL（见 reapplyCursor 的说明）
  pointerLock.reapplyCursor();
  if (inWorld() && !uiOpen() && !input.locked) {
        pointerLock.relock("window focus");
        logDebug("FOCUS focused -> relock");
  }
});

// ESC's DEFAULT ACTION is still blocked here, because a preventDefault can only happen in the event that
// must be cancelled — but the DECISION is `ui.navigation`'s: it reads the Escape EDGE the device layer
// publishes and steps back through the navigation state (UI_MODAL). This listener used to hold a
// five-branch if-chain over four private view fields.
document.addEventListener("keydown", (ev) => {
  if (ev.code !== "Escape") return;
  ev.preventDefault();  // #7907: block the default unlock; we control menu open/close
});

// (F3+F4 / F3 is `ui.picker`; the mouse-button binds, the ESC ladder and the inventory key are
// `player.input` (the edge) + `ui.navigation` (the decision) — see those files.)

// Right-click is a game action (place), so the browser's default context menu must never appear:
// in a pointer-locked window it interrupts the frame and pulls the cursor away for a moment.
// This is the ONLY place contextmenu is handled anywhere in the codebase. It does not affect
// rebinding — the bind-capture path in ui/menu.ts works off mousedown, not contextmenu.
document.addEventListener("contextmenu", (ev) => ev.preventDefault());

// Space shield: whenever any UI is open, Space's browser default (scroll the nearest
// scrollable ancestor of the focused element — e.g. the keybind chip list after clicking
// a chip) is swallowed. Gameplay Space (no UI open) is unaffected; capture mode still
// receives the event and binds it via its own handler (double preventDefault is harmless).
document.addEventListener(
  "keydown",
  (ev) => {
    if (ev.code !== "Space") return;
    const anyUiOpen = uiOpen();
    if (anyUiOpen) ev.preventDefault();
  },
  true,
);

scene.add(new THREE.AmbientLight(0xffffff, 0.5));
// Directional light: ambient alone lights every face of a block identically, which renders the
// chunk geometry flat and unreadable. Same setup as rendering/blockicons.ts.
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(1, 1.5, 0.75);
scene.add(sun);
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (menuBgCamera) {
    menuBgCamera.aspect = window.innerWidth / window.innerHeight;
    menuBgCamera.updateProjectionMatrix();
  }
});

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
  renderMenuBackground();
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

/** One frame. The mode picks the body; the chain re-arms itself, and the try/catch keeps ONE bad frame
 *  from killing the loop for good (a broken chain used to freeze the picture until a restart). */
function frame(): void {
  try {
    if (loopMode === "game") renderFrame();
    else if (loopMode === "menu") menuFrame();
    else if (loopMode === "load") loadFrame();
  } catch (err) {
    logDebug(`frame error: ${String((err as Error)?.message || err)}`);
  }
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

// ===== Main-menu panorama background (a MENU frame's background step) =====
// Equirectangular panorama on a sphere's inner wall; the camera sits fixed at the center rotating slowly
// around Y (MC main-menu style panning). It is not a loop of its own any more: a MENU frame calls this,
// and the check below is what makes it a no-op when the background mode has no panorama. Shares the
// renderer and the camera aspect with the game view (see the resize handler).
let menuBgScene: THREE.Scene | null = null;
let menuBgCamera: THREE.PerspectiveCamera | null = null;
let menuBgYaw = 0;
let menuBgLastMs = 0;

function renderMenuBackground(): void {
  if (menuBgKind() !== "panorama") return;
  if (!menuBgScene) {
        // Lazy init: SphereGeometry's default UV is equirectangular; scale(-1,1,1) flips to the inner wall without mirroring
    menuBgScene = new THREE.Scene();
    const tex = new THREE.TextureLoader().load(resolveTexture("backgrounds/panorama.png"));
    tex.colorSpace = THREE.SRGBColorSpace;
    const geo = new THREE.SphereGeometry(50, 64, 32);
    geo.scale(-1, 1, 1);
    menuBgScene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex })));
    menuBgCamera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 100);
    menuBgLastMs = performance.now();
  }
  const now = performance.now();
  menuBgYaw += Math.min((now - menuBgLastMs) / 1000, 0.1) * 0.03;  // Slow spin ~0.03 rad/s, a full turn in ~3.5 min
  menuBgLastMs = now;
  menuBgCamera!.quaternion.setFromEuler(new THREE.Euler(0, menuBgYaw, 0));
  renderer.render(menuBgScene!, menuBgCamera!);
}

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
  // The root font size first: the startup screen is sized in rem like every other surface, and the
  // scale mode that decides it was loaded from the settings file at the top of this file.
  applyUIScale();
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
  applyWindowModeAtStart();

  const settings = checkSettingsAtBoot();
  await loadingStage(0.2, "loading.settings", { key: settings.noteKey, value: settings.noteValue });

  await loadingStage(0.3, "loading.gpu");
  await renderer.init();
  renderer.setSize(window.innerWidth, window.innerHeight);
  app.appendChild(renderer.domElement);
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