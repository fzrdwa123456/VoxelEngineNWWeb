import * as THREE from "three/webgpu";
import { NULL_ENTITY, World } from "../core/world";
import { HUMANOID_BODY, INVENTORY_SLOTS, spawnPlayer } from "../plugins/player/components";
import { createFont, createFrameCap, createFrameProbe, createInputDiagnostics, createInputIntentLog, createInputState, createInputTiming, createKeyEventLog, createKeyMap, createLocale, createLoopState, createPickerState, createScale, createToastState, createUiModalState, FRAME_PROBE, LOOP_STATE, type LoopMode, LOADING_STATE, createLoadingState, DEBUG_LOG, DELAYED_INTENTS, createDelayedIntents, F3_PANEL, FONT, FPS_CAP, INPUT_DIAGNOSTICS, INPUT_INTENTS, INPUT_STATE, INPUT_TIMING, KEY_EVENTS, KEYMAP, LOCALE, canControl, isMenuUi, isModalUi, INVENTORY_WIDGETS, LOCAL_PLAYER, PICKER_STATE, POINTER, TOAST, UI_MODAL, UI_SCALE, VIEWPORT, VOXEL, createPointer, createViewport, paceFrame, pacingTargetHz, refreshHzFromMilliHz, type InputDiagnostics } from "../data/globals/resources";
import { DEFAULT_LOD } from "../data/world/lod";
import { createFadeOptions, createWorldSize, FADE_OPTIONS, WORLD_SIZE, type WorldSizeState } from "../data/globals/resources";
import { SetFadeOption, SetFpsCap, SetVsync, SetWorldSize, ShowToast } from "../data/globals/commands";
import { Teleport } from "../plugins/player/commands";
// (every import of "../plugins/player/systems/input" was dead after P1.18b: the plugin owns it now)
// (every import of "../plugins/player/systems/controller" was dead after P1.18b: the plugin owns it now)
// (every import of "../plugins/player/systems/movement" was dead after P1.18b: the plugin owns it now)
// (every import of "../plugins/player/systems/collision" was dead after P1.18b: the plugin owns it now)
// (every import of "../plugins/player/systems/interaction" was dead after P1.18b: the plugin owns it now)
// (every import of "../plugins/render/systems/outline" was dead after P1.18b: the plugin owns it now)
import { BOOT_FLOW, createBootFlow } from "../data/globals/boot";
// (every import of "../plugins/render/systems/chunk-stream" was dead after P1.18b: the plugin owns it now)
// (every import of "../plugins/player/systems/snapshot" was dead after P1.18b: the plugin owns it now)
// (every import of "../plugins/render/systems/diagnostics" was dead after P1.18b: the plugin owns it now)
// (every import of "../plugins/ui/systems/delays" was dead after P1.18b: the plugin owns it now)
// (every import of "../plugins/render/systems/camera" was dead after P1.18b: the plugin owns it now)
import { MenuBackgroundSystem } from "../plugins/render/systems/menu-background";
import { defaultUiTheme, UI_THEME } from "../data/assets/theme";
// (every import of "../plugins/ui/systems/reconcile" was dead after P1.18b: the plugin owns it now)
import { createUiActions, UI_ACTIONS } from "../data/globals/actions";
import { createUiOrder, UI_ORDER } from "../plugins/ui/components";
import { createUiPaint, UI_PAINT } from "../data/globals/paint";
import { createUiSources, UI_SOURCES } from "../data/globals/sources";
// (every import of "../plugins/ui/systems/bindings" was dead after P1.18b: the plugin owns it now)
import { BLOCK_OUTLINE, CAMERA3D, CANVAS_HOST, CHUNK_MATERIAL, CHUNK_MESHES, ICON_BAKE, MENU_BACKGROUND, PERF_SAMPLER, RENDERER3D, SCENE3D, UI_MOUNT } from "../data/globals/gfx";
import { createBlockOutline, createChunkMaterial, createChunkMeshCache, createIconBake, createMenuBackground, createUiMount } from "../host/browser/presentation";
import { createKeybindGesture, KEYBIND_GESTURE } from "../data/globals/keybind-gesture";
// The key bind PAGE is its own plugin too (P1.25), and hot-pluggable like the debug surface: the factory
// below is called once, and the value goes into both the boot list and the runtime catalogue.
// (the ui-keybind plugin builds its own rubber band, drag wiring and system: see plugins/ui-keybind/plugin.ts)
// (the ui-debug plugin spawns its own picker panel: see plugins/ui-debug/plugin.ts)
// The F3/F4 DEBUG surface is its own plugin, and it is HOT-PLUGGABLE: the factory is called further down with
// the instance the root constructs, and that ONE value goes into both the boot's plugin list and the runtime
// catalogue. A plugin is hot-pluggable exactly when its `setup` alone is enough to install it.
// (the ui-debug plugin constructs its own picker system: see plugins/ui-debug/plugin.ts)
import { HOT_PLUG, type HotPlugHost } from "../core/plugin/hotplug";
import { SLOT_BLOCKS, SLOT_LANGUAGES, SLOT_UI_HUD } from "../core/extension/slots";
import { UI_HUD_PAINTED } from "../data/globals/ui-hud";
import { UI_PAGE_HOSTS, UI_PAGES_MOUNTED } from "../data/globals/ui-pages";
import type { Plugin } from "../core/plugin/descriptor";
import type { Entity } from "../core/world";
// The HUD message is its own plugin (P1.27 step 2) and needs NO mount: its panel is a TOP-LEVEL widget, so
// it can be plugged in and out at runtime in BOTH directions (unlike the key bind tab, which lives inside a
// view's layout). The root still spawns the widgets — it does the wiring — through the plugin's helper.
// (the ui-toast plugin owns its panel and its system now: see plugins/ui-toast/plugin.ts)
// (every import of "../plugins/ui/systems/loading" was dead after P1.18b: the plugin owns it now)
// (every import of "../plugins/ui/systems/hud" was dead after P1.18b: the plugin owns it now)
import { type NavigationTrees } from "../plugins/ui/systems/navigation";
// (every import of "../plugins/ui/views/loading" was dead after P1.18b: the plugin owns it now)
// The INVENTORY layer is its own plugin (P1.31): the bag, the hotbar they share data with, and their system.
// (the ui-inventory plugin builds its own view, widget handles and system: see plugins/ui-inventory/plugin.ts)
import { Menu, spawnMenuBackdrop } from "../plugins/ui/views/menu";
// The bind page's widgets and its drag gesture belong to the ui-keybind plugin (P1.26), so the root wires
// them from THERE: the ui plugin exports none of it any more.
import { cancelKeybindDrag } from "../plugins/ui-keybind/views/keybind";
import { MainMenu } from "../plugins/ui/views/mainmenu";
// (every import of "../plugins/ui/views/hud" was dead after P1.18b: the plugin owns it now)
import { PointerLock } from "../host/browser/pointerlock";
import { t, loadLang, getLang, i18nStringsState, I18N_STRINGS } from "../data/assets/i18n";
import { loadUIScaleMode, getUIScaleMode } from "../data/globals/uiscale";
import { loadFont, getFontId } from "../data/globals/fonts";
import { preloadShell, bootReport, cursorBoot, cursorTrace, initShell, logDebug, showWindow, shellInfo, queryDisplayRefreshMilliHz, isDiagLogEnabled, setDiagLogEnabled, winFocused, winWindowMoving, windowSessionActiveNow, quitApp, onWinFocus, onWinBlur, onWinGeometry, onCaptureLost, readSettings, writeSettings, getWindowMode, setWindowMode, onWindowModeChange, type WindowMode } from "../host/desktop/shell";
import { shellState, SHELL_STATE } from "../data/globals/shell";
import { startRawInput } from "../host/browser/rawinput";
import { installWindowGuards } from "../host/browser/window-guards";
// The platform halves the PLUGINS are not allowed to import: the composition root hands them in as
// the injected dependencies of the two systems that need them (input capture, icon baking).
import { captureMouse, releaseMouse } from "../host/browser/mousecapture";
import { iconCacheKey, peekBlockIcon, requestBlockIcon } from "../host/browser/blockicons";
import { ChunkGeometry, getChunkMaterial } from "../host/browser/chunkmesh";
import { RENDER_HANDLES } from "../data/globals/render-handles";
import { PLAYER_HANDLES } from "../data/globals/player-handles";
import { UI_HANDLES, INVENTORY_HANDLES } from "../data/globals/ui-handles";
import { adoptViewport, onViewportChange } from "../host/browser/viewport";
import { DebugLogForwarder } from "../host/desktop/debuglog";
import { PerfSampler } from "../core/services/perf";
import { loadBinds, getBindsAll, adoptKeybindGesture } from "../plugins/input/keybinds";
// The configuration CHANGE BUS: a config value announces itself through here (the notification is
// behaviour; the values live under data/). The root subscribes to persist each one.
import { onConfigChange, notifyConfigChange } from "../core/services/bus";
import { menuBgState, MENU_BG_KIND } from "../data/assets/background";
import {
  getEnabledPacks,
  normalizeEnabledPacks,
  resolveAllBytes,
  resolveTexture,
  setEnabledPacks,
} from "../data/assets/textures";
import { preloadPacks, rescanPacks } from "../host/desktop/packs";
// ===== The pack RELOAD's imports (P1.49ab) =====
// The reload re-runs the CONTENT PHASE: rescan (Rust) -> install the chain -> re-derive what the chain
// declares (languages, the block table, the palette) -> drop the caches those derived -> mark the chunks
// stale. Every piece below is one of those steps, and every one of them already existed for the BOOT: the
// reload is the same path with a different trigger, which is what makes it small.
import { installPacks, type PackSnapshotPayload } from "../data/assets/textures";
import { PACK_RELOAD, createPackReloadState } from "../data/globals/resources";

import { allBlockIds, buildBlockRegistry, blockRegistryState, BLOCK_REGISTRY } from "../data/assets/blockregistry";
import { discoveredBlockIds, discoveredBlockLayers } from "../data/assets/blocks";
import { VoxelWorld, WORLD_SURFACE_Y } from "../data/world/world";
// ===== The plugin system =====
// The registry the plugins contribute into, the manifest that decides which of them are installed, and
// the six plugins themselves (each owns its declarations; the systems are still built below and
// contributed under their plugin's id).
import { ExtensionRegistry } from "../core/extension/registry";
import { SLOT_SYSTEMS } from "../core/extension/slots";
import { installPlugins, startPlugins, stopPlugins } from "../core/plugin/lifecycle";
import type { SystemDef } from "../core/flow/schedule";
import { MANIFEST_FILE, isEnabled, readManifest, unknownPlugins } from "./manifest";
import { discoverPlugins } from "./plugin-catalog";
// THE UI TABLES' IMPLEMENTATION (P1.18d): the kernel declares the shape (`UiTablesHook`), this layer does the
// work, because the two tables are data — see core/plugin/ui-tables.ts. It is injected into the installer and
// into the hot-plug host below, the same way the log sink is.
import { uiTables } from "./ui-tables";
import { createStageDriver } from "./drivers/stage";
import { createWorldEntry } from "./drivers/world-entry";
import { createPackReloadDriver } from "./drivers/pack-reload";
import { createStartupDriver } from "./drivers/startup";
import type { PluginHost } from "../core/plugin/host";
// The render plugin's MESHER type (a `host/` object the root builds and hands in as a host instance).
import type { ChunkMeshFactory, MeshWorkerPool } from "../plugins/render";
import { createMeshWorkerPool } from "../host/browser/mesh-pool";
// (the diagnostics, world, player, input and content-default plugins are DISCOVERED now: each folder owns a
//  `plugin.ts` that builds it from the host's instances — see `boot/plugin-catalog.ts` and P1.18b.)
import { createMainMenu, createPauseMenu, createUiViews } from "../plugins/ui";
// (every import of "../plugins/input" was dead after P1.18b: the plugin owns it now)
// (every import of "../plugins/content-default" was dead after P1.18b: the plugin owns it now)

// Pixel font (Fusion Pixel, OFL open source): proportional font for general UI, monospace for F3/count panels
import "@fontsource/fusion-pixel-12px-proportional-sc";
import "@fontsource/fusion-pixel-12px-monospaced-sc";

// ===== Tauri: the synchronous preload (the ONE startup-order change in this port) =====
// The NW.js build had nothing to wait for here: require("node:fs") is synchronous and nw.Window was
// already there. A Tauri command is **asynchronous**, while loadLang/loadFont/loadBinds below and the
// whole UI read settings and resource packs synchronously, so these two are fetched up front, once:
//   preloadShell() -> settings / window mode / the display's refresh rate (readSettings() stays synchronous,
//                     from memory)
//   preloadPacks() -> every byte of resourcepacks + mods (resolveTexture() stays synchronous after it)
// Top-level await needs ESM (index.html is a <script type="module"> already).
// **Wrap it in try/catch**: a throw out of here kills the whole module while initShell() has not run
// yet, and the error then lands nowhere — the symptom is the silent failure "process alive, no window,
// 0-byte log".
// The chain the engine is on RIGHT NOW. Kept so a reload that fails half-way can put it back (MC's
// `rollbackResourcePacks`); null only before the startup install.
let lastGoodSnapshot: PackSnapshotPayload | null = null;

/** THE SELECTION, MIGRATED (P1.49ae). The chain is built from an ENABLED list now, so a pack on disk that is not
 *  named there is available-but-off — that is what makes a newly dropped pack start disabled (MC's rule).
 *
 *  An ABSENT key is the migration case (and a first run): the packs the folder holds become the selection and the
 *  list is written back AT ONCE. Writing it back matters — a migration kept only in memory would run again on the
 *  next launch, and a pack dropped in between would silently become enabled, which is exactly the behaviour this
 *  key exists to end. An empty ARRAY is a real answer ("nothing selected") and is respected.
 *
 *  The old negative key is honoured once and then dropped: `disabledPacks` named what the user had switched off,
 *  so the migration is "everything on disk MINUS that list". */
function resolveEnabledPacks(snap: PackSnapshotPayload): string[] {
  const file = readSettings() as { enabledPacks?: unknown; disabledPacks?: unknown };
  if (Array.isArray(file.enabledPacks)) return normalizeEnabledPacks(file.enabledPacks);
  const switchedOff = normalizeEnabledPacks(file.disabledPacks);
  const onDisk = snap.resourcepacks.map((e) => e.name);
  const picked = onDisk.filter((name) => !switchedOff.includes(name));
  const next: Record<string, unknown> = { ...file, enabledPacks: picked };
  delete next.disabledPacks;
  writeSettings(next);
  logDebug(
    `SETTINGS enabledPacks seeded from the folder ` +
      `(${file.disabledPacks === undefined ? "no list in the file: first run or upgrade" : "migrated from disabledPacks"}): ` +
      `[${picked.join(", ")}]`,
  );
  return picked;
}

try {
  await preloadShell();
  // THE STARTUP INSTALL IS THE SAME PATH A RELOAD TAKES (P1.49ab): rescan -> install, and the snapshot is
  // KEPT.
  try {
    lastGoodSnapshot = await rescanPacks();
    logDebug(installPacks(lastGoodSnapshot, resolveEnabledPacks(lastGoodSnapshot)));
  } catch (packErr) {
    logDebug(`PACKS preload failed (engine fallbacks only): ${String(packErr)}`);
  }
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
// It is the content plugin's declaration (discovered from the pack chain, contributed at INSTALL time), so
// the load cannot happen in this config block — the extension point is still empty here. It sits below the
// plugin block instead; a manifest that disables the content plugin leaves the set empty, which keeps the
// locale's own default (the boot must not depend on content being installed). The other loaders stay here:
// only the language set is content.
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
/** Persist the settings in force.
 *
 *  **A value that arrives through a COMMAND must be HANDED here, not read back**: a command applies at the next
 *  barrier, so reading the resource inside this function writes the PREVIOUS value to disk — and a pushed
 *  label/slider is only refreshed when its panel opens, so the file and the screen then disagree until the next
 *  launch. That is what `justSet` is for: the two settings the frame pacing owns (both are read by the loop
 *  every frame, so both must go through the barrier). */
const saveSettings = (justSet: { cap?: number; vsync?: boolean; fadeLod?: boolean; fadeChunks?: boolean; worldXZ?: number } = {}): void => {
    // Read-modify-write merge, avoids clobbering other settings (windowMode etc.)
  const s = readSettings();
  s.language = getLang();
  s.font = getFontId();
  s.uiScale = getUIScaleMode();
  s.windowMode = getWindowMode();
  s.keybinds = getBindsAll();
  s.diagLog = isDiagLogEnabled();
  // The two appearance fades travel with every save for the same reason the packs do: the value in force is
  // the one the render lane is reading, so a save must never write something else (P2.01).
  s.fadeLod = justSet.fadeLod ?? fadeOptions.lod;
  s.fadeChunks = justSet.fadeChunks ?? fadeOptions.chunks;
  // …and the world size (P2.02): the value in force, handed in when it arrives through a command.
  s.worldXZ = justSet.worldXZ ?? worldSize.chunksX;
  s.fpsCap = justSet.cap ?? world.resource(FPS_CAP).cap;
  // The vertical-sync switch is a setting like the rest now (P1.86): it used to live in its own
  // `config/vsync.json`, which no settings check ever validated, and it only took effect at the next launch.
  s.vsync = justSet.vsync ?? world.resource(FPS_CAP).vsync;
  // The switched-off resource packs travel with every save (P1.49aa): the value in force is the one the
  // chain was installed with, so a save can never lose it.
  s.enabledPacks = getEnabledPacks();
  writeSettings(s);
};
onConfigChange("lang", saveSettings);
onConfigChange("font", saveSettings);
onConfigChange("uiScale", saveSettings);
onWindowModeChange(saveSettings);
onConfigChange("binds", saveSettings);

// Block registry: the engine-side table, built from what the CONTENT PLUGIN declared (P1.37). It used to be
// merged HERE, in the config phase, before the plugins existed — which is why "which blocks does this install
// have" could not be content. The build now sits BELOW the plugin block, next to the language load; the voxel
// mesher still does not consult the table (it draws the built-in checker block).
// The startup ITEMS are seeded from the same discovery the plugin declares from (see `spawnPlayer` below):
// the player entity is spawned up here, before the install, so it cannot ask the registry.
// The registry BUILD moved below the plugin block — see "the block table is the install's statement too".
// (nothing to log here any more: the registry is built after the install, from the declarations)

// The canvas host: the element the renderer's canvas gets attached to. Like the UI mount root, it is a
// RESOURCE (ecs/presentation.ts) — the boot driver reads it back from the world rather than closing over
// a wiring variable.
const canvasHost = document.getElementById("app")!;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);
// No fog: the scene is deliberately unfogged so the whole streamed world stays visible. The
// trade-off is that the rim of the LOD ladder (its outermost rung, up to 7168 blocks out — see
// data/world/lod.ts) is visible as the edge of the world: it is the FAR PLANE below that decides how
// much of it is drawn at all. The main-menu panorama is a separate scene and is unaffected either way.

// THE CAMERA'S NEAR/FAR PLANES ARE PART OF THE LOD'S RANGE (P2.04). `far` is the back face of the view
// frustum: anything beyond it is not drawn AND is culled away as a whole object, so a ladder that reaches
// further than `far` is built, paid for and never seen — which is exactly what the six-rung ladder did to
// its own outermost rung while this was 5000 (rung 6 reaches 7168, rung 5 3584). `far` is 12000 now, i.e.
// past the ladder's 7168-block reach (and its ~10138-block corner).
// `near` is what the DEPTH BUFFER's precision hinges on, and it may NOT grow — the limit is NOT the 0.3
// half-width of the body, it is where the FRUSTUM reaches a wall you are touching. That wall is 0.3 blocks
// to the SIDE, so it only enters the picture at a depth of `0.3 / tan(halfFovH)` — ≈0.22 with a 16:9 window
// and LESS the wider the window gets — and a `near` above that clips a sliver of wall at the LEFT and RIGHT
// screen edges: you look THROUGH the wall standing beside you (measured: `near` 0.25 did exactly that, and it
// is why this is 0.1 again). 0.1 is below every aspect this window can have, and the precision it gives up is
// the precision the engine always had: the longer far plane costs far less than that would (the depth
// resolution near the eye is dominated by `near`, while the (far-near)/far term barely moves). If distance
// z-fighting ever shows up, the answer is `logarithmicDepthBuffer: true` — which this three build's WebGPU
// backend supports — NOT a bigger `near`.
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 12000);
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
// The starting items are the pack chain's DISCOVERY, not the registry: this entity is spawned before the
// plugins install, and the registry is assembled from the DECLARATIONS (P1.37) — one source, two readers.
const player = spawnPlayer(world, SPAWN, discoveredBlockIds());

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
// The frame PACING (P1.86): the cap (0 = unlimited) AND whether to lock to the display's refresh. Both are
// RESOURCES, because the loop reads them every frame — see ecs/resources.ts. Loaded from the settings file
// here; `onFpsCap`/`onSetVsync` write them back. Physics still advances at fixed steps either way: only
// drawing and the stats sample are gated. The refresh rate is the PLATFORM's answer (milli-Hz), read from
// the preload snapshot and re-asked whenever the window mode changes.
const frameCap = createFrameCap(
  Number(readSettings().fpsCap ?? 0),
  readSettings().vsync !== false,
  shellInfo().displayRefreshMilliHz,
);
world.insertResource(FPS_CAP, frameCap);
// The APPEARANCE FADE (P2.01 → P2.05): ONE switch, and it answers for EVERY chunk — real chunks and every LOD
// rung alike (a chunk appeared → fade in, it left → fade out). P2.01/P2.04 split it per ring and then restricted
// it to the outermost rung, which turned out to be a distinction the player has no reason to make. A resource,
// because `chunk-stream` reads it every step; the settings panel sends SetFadeOption to change it.
const fadeOptions = createFadeOptions(readSettings().fadeLod, readSettings().fadeChunks);
world.insertResource(FADE_OPTIONS, fadeOptions);
// THE WORLD SIZE (P2.02): the lap the noise, the torus and the LOD rings share. A resource, because the
// world-entry driver reads it to decide whether the lap has to change before it builds a world; the world-type
// panel changes it through `SetWorldSize`. ONE number in the file (`worldXZ`, in chunks) for both axes, so a
// hand-edited file cannot ask for a rectangular world the UI has no way to show.
const worldSize: WorldSizeState = createWorldSize(readSettings().worldXZ);
world.insertResource(WORLD_SIZE, worldSize);
/** Does any modal surface own the mouse right now? */
const uiOpen = (): boolean => isModalUi(uiModal);
/** A MENU is open (not counting the inventory, which the inventory key must still be able to toggle) */
const menuOpen = (): boolean => isMenuUi(uiModal);
world.insertResource(LOCAL_PLAYER, player);
// The cursor policy reads it (canControl), so keep a reference
const inputState = createInputState();
world.insertResource(INPUT_STATE, inputState);
// The race guards' own state (ecs/resources.ts::InputTiming): which mouse event is the synthetic
// capture-instant one, the grace deadline, the diagnostic counters. It used to be private fields of
// player.input; the LOGIC did not move with them
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
world.insertResource(UI_HUD_PAINTED, new Map());
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
// The F3+F4 DEBUG surface (the picker panel and its system) is the ui-debug PLUGIN's now (P1.18c): it spawns
// its own panel and constructs its own system in `plugins/ui-debug/plugin.ts`, and takes only the F3 panel
// entity from here (that widget belongs to the ui plugin's HUD view, which the root spawns).
// The startup screen's tree: spawned hidden during wiring (spawning is a structural change, so it
// belongs here or inside a command) and shown for as long as LOADING_STATE.active says the startup runs.

// The device layer takes the canvas from RENDERER3D (the renderer's domElement) and the camera from
// CAMERA3D, the chunk stream takes the CHUNK_MESHES cache — the presentation objects are resources now,
// so no system is handed one. See ecs/presentation.ts.
const chunkMeshFactory: ChunkMeshFactory = { createGeometry: () => new ChunkGeometry(), getMaterial: getChunkMaterial };
// …AND THE MESHING WORKER POOL (P1.18h): chunk meshing is the engine's densest per-frame CPU work, and it is
// independent per chunk, so it runs on `hardwareConcurrency - 1` workers. The pool is a `host/` object (it
// creates Workers), handed in as a host instance like the mesher itself; if the environment has no Worker the
// pool reports 0 and the chunk stream keeps meshing on this thread. The results are applied inside the render
// lane (`chunk.stream` drains them), so nothing touches the scene from a worker callback. A worker that FAILS
// later is reported to debug.log and dropped (P1.18i) — a dead worker must not look like a slow world.
const meshPool: MeshWorkerPool = createMeshWorkerPool({ log: logDebug });
// THE RENDER HANDLES COME FROM THE PLUGIN THAT PUBLISHES THEM (P1.45): the render plugin is DISCOVERED
// now, so the root no longer CONSTRUCTS it - but the boot driver still primes and warms the chunk stream,
// and the published resource is how it reaches the very instance the plugin registered.
// The reconciler that owns every widget's DOM element — it is the UI plugin's now (P1.18b), so the root reads
// it through the handle the plugin publishes. It mounts roots on the world's UI_MOUNT resource (the same
// element the hand-written HUD/menus used) and gets the i18n lookup injected, so `core/` never imports `ui/`.
// The F3+F4 picker: the F3 debug panel and the mode chord are GAMEPLAY UI, so they are gated on
// `inWorld()` — outside a world (the main menu, and the loading screen while a world is built) it
// consumes the key edges and does nothing, and it takes its own panels down. The HUD toast below is
// NOT gated: a main-menu toast is a documented case (the multiplayer placeholder is drawn by the menu
// frame, which is the reason the ui lane can be pumped with no world running).
// (the ui-debug plugin owns its picker panel and its system now: see plugins/ui-debug/plugin.ts)
// The TOAST panel and its system are the ui-toast PLUGIN's now (P1.18c): it spawns its own panel and
// constructs its own system in `plugins/ui-toast/plugin.ts`, which is where the other optional surfaces are
// heading too. The root no longer builds an instance for `host.instances` to hand over.
// The page host and the startup screen's painter are the UI plugin's systems now (P1.18b): it constructs them
// from the registry and the views the root spawns (see plugins/ui/plugin.ts).
// The key bind tab's entry buttons, one per settings panel: the VIEW (in the menus, which the root builds)
// spawns them hidden and `ui.keybind` shows them, so this is filled once both menus exist (further down) and
// handed to the plugin by reference — the ONE piece of the key bind surface the root still owns.
const keybindEntries: Entity[] = [];
// THE RUBBER BAND, THE DRAG WIRING AND THE BIND SYSTEM are the ui-keybind PLUGIN's now (P1.18c): it spawns its
// own widget, wires its own drag and constructs its own system in `plugins/ui-keybind/plugin.ts`. What it takes
// from here is the entry array above (the menus fill it) and the host's log sink. The drag still asks the
// reconciler what is under the cursor — through `UI_HANDLES`, which the ui plugin publishes.
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
// The MENU FROST (P1.30): a full-screen frosted layer that `ui.navigation` shows while any modal is up.
const menuBackdrop = spawnMenuBackdrop(world);
// THE BACKPACK (the bag, the hotbar it shares data with, and their system) is entirely the ui-inventory
// plugin's now (P1.18c): it builds its view, its widget handles and its system in
// `plugins/ui-inventory/plugin.ts`, and publishes the one entity `ui.navigation` paints (INVENTORY_HANDLES).
// The root keeps only what is HIS: the frost layer above, and the trees box below.
// THE GAMEPLAY HUD — and the host that OWNS it (P1.34): the crosshair and the hotbar used to be spawned
// during wiring and merely hidden outside a world. Now each one is BUILT by `ui.hud` when its element is
// mounted and DESPAWNED with it, so the HUD is as dynamic as the plugin set: F11 removes the strip's element
// and the host takes it down; installing it again BUILDS a new one. Spawning is a STRUCTURAL change, so it
// happens at a barrier (the host defers it).
// "Is the inventory layer installed right now" — the SAME set `hotInstall`/`hotUninstall` maintain. Only the
// BAG's gate reads it (ui.navigation's E key and its mouse bind): the strip is that plugin's OWN element, so it
// does not need to be asked about at all. The UI plugin reads this through a host instance.
const inventoryOn = (): boolean => livePlugins.has("ui-inventory");
// THE HUD TABLE (P1.32/P1.34, plugin-owned elements in P1.35) is read by the UI plugin's `ui.hud` straight
// from the registry (SLOT_UI_HUD) — the root contributes NO element of its own any more (P1.48).
// The MODAL TREES `ui.navigation` paints are built further down (the menus' callbacks close over the world
// driver), so they travel to the plugin in this BOX: it reads `.trees` every frame, never at construction.
const uiTrees: { trees: NavigationTrees | null } = { trees: null };

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
world.insertResource(PACK_RELOAD, createPackReloadState());
const registry = new ExtensionRegistry();
// ===== The plugin system =====
// (The player plugin is built FIRST — see `plugins/player/index.ts`. The root keeps the handles it still wires
// by hand: the input system the raw-input thread and the frame loop drive, and the views it spawns.)

// ===== The hot-plug host (P1.24) =====
// Which plugins may be installed WITHOUT a restart, and the door the `HotPlugPlugin` command reads. Note WHO
// builds the plugin: the plugin's own `plugin.ts` does, from the instances the host publishes — and the plugin
// still declares its own system, because that is the property that makes it hot-pluggable at all. It is the
// SAME value the boot installs below, so the boot path and the runtime path cannot drift apart.
// THE PLUGIN CATALOGUE IS DISCOVERED (P1.40): `plugins/<id>/plugin.ts` is the opt-in, so the four optional
// surfaces are no longer listed here and adding a plugin folder does not touch this file. The HOST publishes
// what a plugin may need BY NAME (see core/plugin/host.ts); each plugin's own plugin.ts narrows it to its
// factory's types, which is why the root can hand over instances it does not model.
// THE PLAYER PLUGIN IS DISCOVERED TOO (P1.18b): it constructs its six fixed-lane systems itself and publishes
// the ONE the root drives (PLAYER_HANDLES) — the platform halves it may not import (the native mouse capture)
// arrive here as a host instance.
const pluginHost: PluginHost = {
  world,
  log: logDebug,
  inWorld: () => inWorld(),
  instances: {
    keybindEntries,
    chunkMeshFactory,
    meshPool,
    mouseCapture: { capture: (dom: HTMLElement) => captureMouse(dom), release: releaseMouse },
    // The F3 DEBUG PANEL widget: it belongs to the ui plugin's HUD VIEW, whose construction is the root's
    // (spawning is a structural change, and `diagnostics` reads the handles before the plugins are built), so
    // ui-debug gets the entity as an instance — the same one the ui plugin has.
    f3Panel: hud.debugPanelEntity,
    // The block ICON BAKER (three.js + a render target = a `host/` object a plugin may not import): the same
    // three functions the root used to hand the ui-inventory system directly.
    iconSource: { key: iconCacheKey, peek: peekBlockIcon, request: requestBlockIcon },
    // ===== The UI plugin's instances (P1.18b) =====
    // The framework's registry (the page host and the HUD host read what other plugins contributed), the
    // loading-screen VIEW the root spawns, the modal-trees box the root fills further down, and the two
    // closures over things a plugin may not see (the live plugin set; `ui-keybind`'s drag, which is optional).
    registry,
    loadingScreen,
    uiTrees,
    inventoryOn,
    cancelDrag: (reason: string) => cancelKeybindDrag(reason, logDebug),
    // The native capture is a `host/` object: this proxies the ONE PointerLock the root owns (it is created
    // below, because it holds the input system the player plugin publishes — only ever CALLED from a lane).
    lock: {
      relock: (reason: string) => pointerLock.relock(reason),
      retry: (reason: string) => pointerLock.retry(reason),
      reassertCursor: (reason: string) => pointerLock.reassertCursor(reason),
      applyCursor: () => pointerLock.applyCursor(),
    },
  },
};
const discoveredPlugins = discoverPlugins(pluginHost);

// The hot-plug catalogue is the DISCOVERED set filtered by the `hot` flag — the list is only "what may be
// installed at runtime"; the order the surfaces appear in is the core's slot anchors, not this array.

const hotCatalog: readonly Plugin[] = discoveredPlugins.filter((p) => p.hot).map((p) => p.plugin);
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
  // What a plugin files into the UI tables is installed/withdrawn by the ROOT's implementation (P1.18d): the
  // tables are data, so the kernel asks for the capability instead of importing it.
  uiTables,
};
world.insertResource(HOT_PLUG, hotHost);

const PLUGINS = [...discoveredPlugins.map((p) => p.plugin)];
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
  uiTables,
});
// The hot-plug host's "installed right now" set starts as the boot's list: everything plugged in later is
// added by `hotInstall`, everything unplugged is removed by `hotUninstall`, and the reverse-dependency guard
// reads this list — so it sees the boot's plugins and the runtime ones in one place.
for (const id of installOutcome.installed) livePlugins.add(id);
for (const line of registry.report()) logDebug(`REGISTRY ${line}`);
// THE INPUT SYSTEM THE ROOT DRIVES COMES FROM THE PLAYER PLUGIN (P1.18b). The plugin constructed it while the
// catalogue built the plugins above and published it as PLAYER_HANDLES: the raw-input device thread feeds it,
// the frame loop drains it, the win-focus handlers read its lock state, and `ui.navigation` takes and gives the
// native capture through it. A second instance would drive nothing — that is why the handle comes from here.
const input = world.resource(PLAYER_HANDLES).input;
// THE LANGUAGE SET IS CONTENT, AND THE INSTALL IS WHAT DECLARES IT (P1.36). This used to run in the config
// block above with a literal set, which is exactly why a pack shipping `lang/fr.json` could never be
// selected: i18n built its dictionaries for a hard-coded zh/en/ja. It runs HERE, where `SLOT_LANGUAGES` has
// been filled by the content plugin — the dictionaries are built lazily on the first `t()` anyway, and the
// first paint (the loading screen) happens after `boot()` runs, further down. Reading the set from the
// REGISTRY also means "the engine declared it" and "the install declared it" are one statement: turn the
// content plugin off in the manifest and the locale keeps its own default.
logDebug(loadLang(locale, readSettings().language, registry.list(SLOT_LANGUAGES).map((l) => l.id)));
// THE BLOCK TABLE IS THE INSTALL'S STATEMENT TOO (P1.37): the same move as the language set, for the same
// reason. The content plugin discovered the chain's `data/blocks.json` entries and declared them into
// `SLOT_BLOCKS`; the engine-side table (label, the three face textures, the missing-texture flag) is assembled
// from THAT declaration, not from a second look at the packs. Nothing reads the registry before this line any
// more: the starting items were seeded from the discovery itself (see `spawnPlayer` above).
logDebug(
  `${buildBlockRegistry(registry.list(SLOT_BLOCKS))} (${discoveredBlockLayers()} layer(s) of blocks.json)`,
);
// THE PALETTE IS THE REGISTRY ID LIST (P1.47): from here on a voxel value names a real block, so every
// block this install ships can be placed and drawn (texture, else colour, else the engine checker). The
// generator reads the same list for the layers of the default world.
// MERGED, not replaced (P1.49ab): a voxel stores a NUMBER, so the number -> block mapping is owned by the
// ENGINE and only ever grows. That is what makes a pack reload safe — a pack that reorders or drops an entry
// cannot re-point the blocks already in the world (see VoxelWorld.mergePalette).
const bootPalette = voxel.mergePalette(allBlockIds());
logDebug(
  `PALETTE ${bootPalette.total} block(s) numbered, ${bootPalette.added.length} added: [${bootPalette.added.join(", ")}]`,
);
/** Contribute one system under its plugin's id. A plugin the manifest disabled contributes NOTHING. */
const contributeSystem = (owner: string, def: SystemDef): void => {
  if (!installOutcome.has(owner)) return;
  registry.contribute(SLOT_SYSTEMS, owner, [def]);
};
// `ui.navigation` and `ui.delays` are the UI plugin's systems now (P1.18b): they are constructed in
// `plugins/ui/plugin.ts` from a handful of instances, and the two things they need LATE — the modal widget
// trees (built further down) and the native capture (created below, because it holds the input system the
// player plugin publishes) — arrive through the `uiTrees` box and the `lock` proxy.

// (world.start() moved below: ui.navigation needs the widget trees the surfaces build during wiring.)

// Raw mouse input (Rust plugin): **the ONLY source of view deltas while the mouse is captured** (P1.72
// deleted the pointer-lock fallback). WM_INPUT is delivered to a hidden HWND_MESSAGE window
// (`RIDEV_INPUTSINK`), so it is unaffected by where the cursor is or by our own ClipCursor.
// **Decided on event arrival, applied ONCE per frame**: `rawDelta` runs the takeover/grace/spike
// decision in every event and accumulates the part that passes; `frame()` calls `input.frameLook()`
// once per frame to queue it as ONE look intent — the view no longer goes through any timer (the old
// 8 ms `setInterval` was stretched to 9-12 ms steps by key events, which is exactly "holding a key
// turns the view unsmoothly").
// The transport counters live in the INPUT_DIAGNOSTICS resource (a system may not own module-level
// counters, and the device layer may not import one): `player.input` prints them as RAWLAG once a second.
const rawInput = startRawInput(
  (dx, dy) => input.rawDelta(dx, dy),
  // …and the button edges of the same packets (P1.76): the only path that survives a shell overlay taking the
  // click (see the note in host/browser/rawinput.ts).
  (down, up) => input.rawButtons(down, up),
  world.resource(INPUT_DIAGNOSTICS).raw,
);
// **The assignment must wait for ready to settle.** In the original, startRawInput() was a synchronous
// NAPI call, so `available` was true on the spot and this line used to be a synchronous assignment,
// `input.rawInputActive = rawInput.available`; the Tauri port only sets it in
// `invoke("rawinput_start").then()`, and a synchronous read gets **permanently** false. The consequence
// is that the mouse is never captured at all — raw input is the only source of view deltas (P1.72: there
// is no pointer-lock fallback any more). That trap was hit.
void rawInput.ready.then((ok) => {
  input.rawInputActive = ok;
  logDebug(
    `RAWINPUT active=${ok} -> ${ok ? "the mouse can be captured (native ClipCursor + raw deltas)" : "**the mouse CANNOT be captured** (raw input is the only view source; no pointer-lock fallback by design)"}`,
  );
});

// Mouse-capture manager: referenced by the menu callbacks; declared with let then assigned, avoiding a circular dependency
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
  // Capture only opens while foregrounded: native ClipCursor does not look at focus, and a background
  // capture would clip the cursor to another application's screen area.
  focused: winFocused,
  // …and not while the user is holding the window (P1.62e): a capture taken then would end on the first
  // movement anyway (`onWinGeometry` pauses), so it is refused with a line saying why.
  windowMoving: winWindowMoving,
  logDebug,
  // A REJECTED LOCK IS RETRIED through a **delayed intent**, not a timer of this module: the deadline goes
  // into DELAYED_INTENTS and is applied by `ui.delays`. (The old `scheduleCursor` - the two extra cursor
  // writes 0/120 ms after the window regained focus - went with the focus-gain relock in P1.58.)
  scheduleRetry: (delayMs, source) => delayedIntents.schedule("lockRetry", delayMs, source),
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
  // because configuration is not world state. `saveSettings({ cap })` takes the value because the command
  // has not applied yet: reading the resource would persist the previous cap.
  world.commands.send(SetFpsCap, { cap });
  saveSettings({ cap });
    logDebug(`FPS cap set to ${cap === 0 ? "unlimited" : cap}`);
};
/** The vertical-sync switch (P1.86). **Runtime, and that is the whole point**: this used to write a WebView2
 *  launch argument (`config/vsync.json`) and tell the user to relaunch, which is exactly as broken as it
 *  sounds next to a slider that applies instantly. The launch arguments now lift the display-rate limit
 *  unconditionally and THIS value decides the pacing — world state through a command (the loop reads it every
 *  frame), the setting written here, and the toast says what happened on the next frame. */
const onSetVsync = (on: boolean): void => {
  world.commands.send(SetVsync, { vsync: on });
  // HANDED the value, like the cap: the command applies at the next barrier, so reading the resource here
  // would persist the state the user just left (measured: the file kept flipping back to the previous value).
  saveSettings({ vsync: on });
  const target = pacingTargetHz(frameCap.cap, on, frameCap.refreshHz);
  logDebug(
    `VSYNC ${on ? "on" : "off"} (applies immediately): target ` +
      `${target > 0 ? `${target.toFixed(2)} fps` : "uncapped"}` +
      `${frameCap.refreshHz > 0 ? `, display ${frameCap.refreshHz.toFixed(2)}Hz` : ", display rate unknown"}`,
  );
  // A COMMAND, not a view call: the message and its deadline are world state (ecs/ui/toast.ts), and the
  // key is passed through untranslated so a language switch re-translates a toast that is already up.
  world.commands.send(ShowToast, { key: on ? "toast.vsyncOn" : "toast.vsyncOff" });
};

/** The appearance fade (P2.01 → P2.05): does EVERY chunk fade in/out when it appears/leaves. Read by
 *  `chunk-stream` every step, so the change goes through the COMMAND (a UI callback may not assign a resource the
 *  tick reads) and the settings file is written here — the value is HANDED to the save, never read back before
 *  the barrier has applied it. `chunks` is the retired pre-P2.05 fine-ring switch: still accepted from the file
 *  (an older settings.json loads untouched) and no longer set by anything. */
const onSetFade = (which: "lod" | "chunks", on: boolean): void => {
  world.commands.send(SetFadeOption, { which, on });
  // HANDED the value, exactly like the cap and vsync: the command applies at the next barrier, so reading the
  // resource here would persist the state the user just left (measured on both of those).
  saveSettings(which === "lod" ? { fadeLod: on } : { fadeChunks: on });
  logDebug(
    `FADE ${which === "lod" ? "all chunks" : "chunks (retired switch)"} ${on ? "on" : "off"}` +
      `${on ? "" : " — nothing fades; the reserve still covers every swap"}`,
  );
};

/** THE WORLD SIZE (P2.02): chosen in the world-type panel, applied by the world-entry driver on the NEXT entry
 *  (no restart) — the lap cannot change under a world that is already streaming, so this only stores the choice
 *  and the entry does the reset when it builds. Same shape as the fades: the command writes the resource the
 *  driver reads, and the file is written here with the value HANDED in (never read back before the barrier). */
const onSetWorldSize = (chunks: number): void => {
  world.commands.send(SetWorldSize, { chunksX: chunks });
  saveSettings({ worldXZ: chunks });
  const blocks = createWorldSize(chunks).chunksX * 32;
  logDebug(
    `WORLD SIZE set to ${chunks} chunks (${blocks} blocks around) — applies on the next world entry ` +
      `(the half-lap is what an LOD ring may reach: ${blocks / 2} blocks)`,
  );
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
  // …and the refresh rate may be a different MONITOR now (a fullscreen switch is how a second display gets
  // used), so the pacing target is re-asked. The value is a measurement, not a setting: it lands in the
  // resource the loop reads, and the next frame paces against the new number.
  void queryDisplayRefreshMilliHz().then((milliHz) => {
    const hz = refreshHzFromMilliHz(milliHz);
    if (hz === frameCap.refreshHz) return;
    frameCap.refreshHz = hz;
    logDebug(`DISPLAY refresh ${hz > 0 ? `${hz.toFixed(2)}Hz` : "unknown (pacing falls back to 60)"}`);
  });
};

/** The resource packs the user has ENABLED (P1.49ae). Written to settings.json AT ONCE and applied when the pack
 *  chain is installed: every asset (dictionaries, block registry, textures, menu background) is derived from the
 *  chain, so this only RECORDS the choice. Applying it is the pack reload driver below (P1.49ab, raised with F7),
 *  which re-runs the whole content phase; MC applies a selection change at once and so does this (`onSetPacks`
 *  raises the reload), and the note on screen says so. */
const onSetPacks = (names: readonly string[]): void => {
  setEnabledPacks(names);
  saveSettings();
  world.resource(PACK_RELOAD).requested = true;
  logDebug(
    `PACKS enabled: ${getEnabledPacks().join(", ") || "none"} ` +
      `(the reload applies it; a pack that is on disk but not listed here stays off)`,
  );
};

const menu = createPauseMenu(world, {
  // The three platform capabilities a view may not import itself (see SettingsCallbacks).
  log: logDebug,
  onViewportChange,
  onWindowModeChange,
  // The pause menu PUBLISHES its navigation state into UI_MODAL itself, and ui.navigation paints it —
  // so no call site has to remember to say so, and a sub-panel needs no flag of its own.
  onResume: () => {
        // Back to game: recapture the mouse (auto-retry on failure; P1.72: no browser cooldown to dodge)
        // Diagnostics (P1.65): the timeline around a Resume - it says whether the lock resolved, whether the
        // Rust table ever wanted the cursor hidden, and whether it ever held a clip.
        probeCursorTimeline("resume");
        pointerLock.relock("menu resume");
    pointerLock.applyCursor();
        logDebug("RESUME back to game -> relock");
  },
  onFpsCap,
  onSetVsync,
  isVsyncOn: () => frameCap.vsync,
  onToggleDiagLog,
  isDiagLogEnabled: () => isDiagLogEnabled(),
  onSetFade,
  isFadeOn: (which: "lod" | "chunks") => (which === "lod" ? fadeOptions.lod : fadeOptions.chunks),
  getFpsCap: () => frameCap.cap,
  getWindowMode: () => getWindowMode(),
  onSetWindowMode,
  onSetPacks,
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

// ===== The loading-screen STAGE driver, then the WORLD ENTRY driver (P1.18e) =====
// The three drivers that drive the loading screen - the startup, entering a world and the pack reload -
// live in `boot/drivers/` now. What stays HERE is the wiring they are handed: the loop the entry puts in
// "load" mode, the two menus, the pointer lock, the window queries and the spawn point. The stage helper
// is built first because all three take it; the two menus are arrows because the pause menu is created
// further down, and only when the entry is actually taken.
const stage = createStageDriver(world);
const enterWorld = createWorldEntry({
  world,
  log: logDebug,
  stage,
  loop,
  player,
  spawn: SPAWN,
  // The LOD policy in force: the entry reports how many RUNGS the world it is building actually gets (the lap
  // caps the ladder — P2.03). It is the same object the render plugin builds its stream with.
  lod: DEFAULT_LOD,
  setLoopMode,
  hideMainMenu: () => mainMenu.hide(),
  showPauseMenu: () => menu.show(),
  relock: (why: string) => pointerLock.relock(why),
  applyCursor: () => pointerLock.applyCursor(),
  winFocused,
  winWindowMoving,
  windowSessionActiveNow,
});

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
  isVsyncOn: () => frameCap.vsync,
  onSetVsync,
  isDiagLogEnabled,
  onToggleDiagLog,
  onSetFade,
  isFadeOn: (which: "lod" | "chunks") => (which === "lod" ? fadeOptions.lod : fadeOptions.chunks),
  getWorldSize: () => worldSize.chunksX,
  onSetWorldSize,
  getWindowMode,
  onSetWindowMode,
  onSetPacks,
});
// ===== ui.navigation's widget trees (the plugin reads them through the box) =====
// The state machine is in the schedule from boot; these are the handles it paints. They are published into
// `uiTrees`, the box the UI plugin was handed at construction — the menus are built HERE because their
// callbacks close over the world-entry driver.
uiTrees.trees = {
  pauseRoot: menu.rootEntity,
  pauseMain: menu.mainPanelEntity,
  pausePanels: menu.panelEntities,
  pauseLists: menu.listEntities,
  mainRoot: mainMenu.rootEntity,
  mainMain: mainMenu.mainPanelEntity,
  genPanel: mainMenu.genPanelEntity,
  backdrop: menuBackdrop,
  mainPanels: mainMenu.panelEntities,
  mainLists: mainMenu.listEntities,
  // The BACKPACK's panel belongs to the ui-inventory plugin (P1.18c), so it arrives as the handle that plugin
  // publishes. A manifest that disables it publishes nothing, and NULL_ENTITY is what "no bag panel" paints like
  // (every setter is a no-op on an entity that carries the component set it is asked about).
  inventoryPanel: world.hasResource(INVENTORY_HANDLES) ? world.resource(INVENTORY_HANDLES).panel : NULL_ENTITY,
};

// The ui lane's eleven declarations belong to the ui PLUGIN (plugins/ui/index.ts, called from its own
// `plugin.ts` setup — P1.18b): the plugin constructs its seven systems and says what they are, where they run
// and what they touch. The root declares NOTHING by hand any more.
// The ui plugin is OPTIONAL for the boot: the manifest may disable it, and the engine then runs with
// nothing painting the screen (the views are widget DATA — without the ui systems nothing turns them into
// DOM). What it must not do is crash, which is what an unconditional apiOf("ui")! did.
if (!installOutcome.has("ui")) {
  logDebug("PLUGIN ui is not installed - the ui lane is off: nothing will be painted (the loading screen and the menus are ui surfaces)");
}
// The backpack + hotbar system belongs to the ui-inventory plugin, and the PLUGIN declares it in its own `setup`
// — the shape that makes a plugin self-installing and hot-pluggable. The ROOT must not declare it again: the
// registry refuses a duplicate id, and doing it twice threw `"ui.inventory" is already contributed by
// "ui-inventory"` during boot, which took the whole window down (the game never appeared).
if (!installOutcome.has("ui-inventory")) {
  // The strip is not a hidden widget any more (P1.35): the HUD ELEMENT is the plugin's, so uninstalling the
  // layer takes it out of the table and `ui.hud` never builds it. The bag panel's widgets still exist (the view
  // is wired by the root), but nothing can open it: ui.navigation's E key and its mouse bind are gated too.
  logDebug("PLUGIN ui-inventory is not installed - NO hotbar element is built, and the backpack is off (the crosshair stays)");
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

// Window leaves the foreground (minimized/switched away/clicking another window): hand the mouse back and,
// while the player was actually playing, raise the pause menu. Re-focus does NOT take the mouse back
// (P1.58): the mouse is only captured when the PLAYER asks for it, and the resume is a click.
/** The window is GONE — either it lost focus, or the native capture was torn down because we are not in the
 *  foreground any more (Rust's `capture_foreground_check`). ONE handler for both: to the game they mean the
 *  same thing. Hand the mouse back, and pause if the player was playing. */
const onWindowLost = (reason: string): void => {
  logDebug(`${reason} inWorld=${inWorld()} uiOpen=${uiOpen()} locked=${input.locked}`);
  // Diagnostics (P1.59): the state we came FROM (capture, CSS, intent) and the Rust table at that instant.
  // The "after" state needs no probe: Rust logs its own `[cursor] capture on=false` line below, and the
  // next `focus GAIN before=` carries the settled state.
  cursorProbeNow(`${reason} winlost`);
  input.prepareUnlock();
  // Hand the mouse back: native capture is released here (Rust also releases it as a fallback on
  // blur / not foreground).
  input.releaseCapture();
  if (inWorld() && !uiOpen()) {
    menu.show();
    pointerLock.applyCursor();
    logDebug(`${reason} -> pause menu`);
  }
  // **We owe the player an arrow** (P1.60): giving the mouse back is exactly the moment Chromium can keep
  // answering `WM_SETCURSOR` from the NULL it cached while we were capturing. Rust pushes an arrow and arms
  // its guard, but Chromium's CACHE only turns back into an arrow when the CSS value CHANGES under it — see
  // `PointerLock.nudgeCursor`. Never fires while we still hold the mouse, and `auto` is an arrow too.
  pointerLock.nudgeCursor(`${reason} winlost`);
};
// ===== CURSOR DIAGNOSTICS (P1.59) =====
// The Win-key report ("the cursor is invisible after the Win key") has three causes that look identical
// from the outside, and they are cured in three different places:
//   * the FRONT END ordered a hidden cursor while nothing was captured (a stale `locked`/`freeMouse`),
//   * **Chromium** is still answering `WM_SETCURSOR` from its cached `cursor: none`,
//   * the state is right and the desktop simply did not REPAINT the overlay.
// So every cursor decision now writes ONE line into logs\boot.log - the file Rust's own `[cursor]` probes
// go to - and the line carries BOTH sides of the truth: what the front end decided (`locked`, `modal`,
// `canControl`, the CSS value Chromium will read back) and, from the Rust table, what the SYSTEM says
// (`want` / `relative` / `showing` / `under`). Read the lines around one `win-blur` / `win-focus` pair in
// ORDER and the cause names itself; `docs\TESTING.md` (P1.59) has the decoding table.
const cursorJsState = (): string => {
  const computed = typeof getComputedStyle === "function" ? getComputedStyle(document.body).cursor : "?";
  return (
    `t=+${performance.now().toFixed(0)}ms captured=${inputState.locked} ` +
    `modal=${uiOpen()} canControl=${canControl(inputState, uiModal)} inWorld=${inWorld()} ` +
    `focused=${winFocused()} domFocus=${typeof document.hasFocus === "function" ? document.hasFocus() : "?"} ` +
    `css=${document.body.style.cursor || "(unset)"} computed=${computed} ` +
    `applied=${inputState.appliedCursor ?? "null"}`
  );
};
/** ONE front-end line plus the Rust table for the SAME instant. `cursorTrace()` only READS the table, so a
 *  probe can never change what it measures. */
const cursorProbeNow = (tag: string): void => {
  cursorBoot(`${tag} JS ${cursorJsState()}`);
  void cursorTrace().then((trace) => cursorBoot(`${tag} RUST [${trace}]`));
};
/** The timeline of one event: the instant itself, then +120 / +500 / +1500 ms. A cause that only exists
 *  "until something else runs" shows up as a difference between those lines; a REPAINT problem shows up as
 *  `showing=true` on every one of them while the screen still shows no cursor.
 *  THROTTLED to 3 timelines per 2 s: the Windows focus FLAP fires blur/gain pairs several times per
 *  keypress, and the first cycles are the ones worth reading (the rest only repeat). */
let cursorTimelineWindow = -1;
let cursorTimelineCount = 0;
const probeCursorTimeline = (tag: string): void => {
  const window = Math.floor(performance.now() / 2000);
  if (window !== cursorTimelineWindow) {
    cursorTimelineWindow = window;
    cursorTimelineCount = 0;
  }
  cursorTimelineCount++;
  if (cursorTimelineCount > 3) {
    if (cursorTimelineCount === 4) {
      cursorBoot(`${tag} timeline throttled (more focus events in this 2s window)`);
    }
    return;
  }
  cursorProbeNow(`${tag} t0`);
  for (const ms of [120, 500, 1500]) setTimeout(() => cursorProbeNow(`${tag} t${ms}`), ms);
};
onWinBlur(() => onWindowLost("WINFOCUS blur"));
onCaptureLost(() => onWindowLost("CAPTURELOST not foreground"));

// **A FOCUS EVENT NEVER TOUCHES THE MOUSE CAPTURE (P1.58 - the root cure of the Win-key flap).**
//
// What it used to do: on regaining focus, if a world ran and no UI was up, it RE-REQUESTED the mouse
// (`relock("window focus")`). The boot.log shows what the Windows key does to that: `focus LOST` -> `focus
// GAIN` -> `focus LOST` several times per keypress - and every `focus GAIN` re-opened the native capture,
// which HIDES the cursor, so the arrow blinked in and out while the pointer was over the Start menu. The
// requests were never the problem; the REQUESTING was: a capture re-issued on an event the operating system
// is free to repeat can never be stable.
//
// The model is EXPLICIT-ONLY now: the mouse is captured when the PLAYER asks for it (a click on the canvas,
// Resume, ESC out of a menu, the backpack key, entering a world) and it is given back on every real loss (a
// modal UI opening, the window leaving the foreground, a geometry change). A focus event only re-asserts
// what the cursor SHOULD be - the INTENT, not the capture - and Rust's own foreground rule
// (win.rs::on_foreground_lost) keeps the two halves honest while nobody is asking: the clip is released and
// the ARROW handed back the moment the window stops being foreground, and the hidden intent is FORGOTTEN
// there as well (cursor_model.rs::forget_intent), so a "focus gained" cannot re-hide a cursor nobody asked
// to hide.
//
// The consequence is deliberate and MC-like: coming back from Alt+Tab does NOT steal the mouse back. The
// blur raised the pause menu and the player resumes it - or, with no UI up, a click on the canvas grabs the
// mouse. Nothing may capture in the background either way: `PointerLock` refuses without the foreground.

onWinFocus(() => {
  // Diagnostics: record it once, unconditionally
  logDebug(`WINFOCUS focus inWorld=${inWorld()} uiOpen=${uiOpen()} locked=${input.locked}`);
  // Re-assert the cursor, and ONLY the cursor. Chromium's cached shape is still the NULL from the blur (it
  // answers WM_SETCURSOR from that cache) and Rust has just FORGOTTEN the intent, so one repeated intent is
  // what puts the right shape back on screen.
  pointerLock.reassertCursor("focus gain");
  pointerLock.nudgeCursor("focus gain");
  probeCursorTimeline("wingain");
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
  // **BUT REMEMBER IT (P1.62e)**: a world ENTRY is exactly this state, and a window the user fiddled with
  // while the loading screen was up must not hand the mouse over behind their back - the entry driver reads
  // this flag and starts on the pause menu. (Our own mode switch returned above, so it never counts.)
  if (!inWorld()) {
    loop.geometryDuringLoad = true;
    return;
  }
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
//             — and the FIXED STEP runs on every vblank, whether or not that vblank draws (P1.86): the
//             display-rate limit is lifted at launch, so one drawn frame can span several vblanks.
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
/** Fixed-step physics: step size (decoupled from frame timing, MC-style fixed tps)
 *  This is `PHYS_DT`, and the advance below runs on EVERY vblank — see `frame()` for why the fixed lane may
 *  not live inside the drawing body any more. */
const PHYS_DT = 1 / 120;

/** Advance the simulation by the time that really passed, at a FIXED step (frame-rate independent movement).
 *  Called once per vblank, BEFORE the pacing gate: with the display-rate limit lifted, rAF fires several
 *  times per drawn frame, and a vblank that draws nothing must still move the world. */
function advanceFixed(delta: number): void {
  loop.physAcc += delta;
  let steps = 0;
  while (loop.physAcc >= PHYS_DT && steps < 12) {
    world.stepFixed(PHYS_DT);
    loop.physAcc -= PHYS_DT;
    steps++;
  }
}

/** Count this vblank into the frame pacing and answer whether it DRAWS (P1.86).
 *
 *  The rate comes from `pacingTargetHz` — the settings (cap + the sync switch) against the display rate the
 *  PLATFORM measured — so both switches take effect on the next frame. The loop used to compare against the
 *  cap only, inside the game body, while the browser's own display-rate limit decided everything else; the
 *  launch arguments now lift that limit unconditionally (game.rs) and this is the only pacer left.
 *
 *  Skips are cheap by construction: the caller returns before the look, the mode body and the frame probe,
 *  so a skipped vblank costs the physics above plus this sum. That is also why `frameProbe` keeps meaning
 *  "drawn frames" — and why the FRAME line's `avg` stays 16.67ms at 60fps on a machine whose rAF runs at
 *  hundreds of hertz. */
function paceWantsFrame(delta: number): boolean {
  loop.sinceDraw += delta;
  // The UI screens (menu / load) are not part of the frame-rate setting: they always pace at the display's
  // rate. They were never gated before (they simply ran at rAF's rate), and without this a menu would pump
  // the ui lane thousands of times a second for nothing once the display-rate limit is lifted.
  const target =
    loop.mode === "game"
      ? pacingTargetHz(frameCap.cap, frameCap.vsync, frameCap.refreshHz)
      : pacingTargetHz(0, true, frameCap.refreshHz);
  const pacing = paceFrame(loop.renderAcc, delta, target);
  loop.renderAcc = pacing.acc;
  return pacing.draw;
}

/** The GAME body: the render lane + the ui lane. The fixed step has ALREADY run for this vblank (`frame`),
 *  because it must advance whether or not this vblank draws; what is left is drawing, and the `delta` it
 *  gets is the time since the last DRAWN frame, not since the last vblank. */
function renderFrame(delta: number): void {
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
  world.resource(RENDER_HANDLES).menuBackground.step();
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
  const target = pacingTargetHz(frameCap.cap, frameCap.vsync, frameCap.refreshHz);
  // WHAT A FRAME COSTS THE DRAW SIDE (M1b, and the number that decides the next milestone). three.js's counters
  // are TOTALS (`drawCalls` is "since the app started"): nothing resets them here, because this engine owns its
  // own rAF chain and never uses `renderer.setAnimationLoop` — which is the only thing that calls `info.reset()`.
  // So the per-frame figure is the DELTA over the window divided by the drawn frames, and `attrs` is a live count
  // (created on first use, removed on dispose) — about three per chunk geometry, which is why it moves with the
  // far ring's mesh count.
  const info = renderer.info;
  probe.callsPerFrame = probe.n > 0 ? (info.render.drawCalls - probe.drawCalls) / probe.n : 0;
  probe.trisPerFrame = probe.n > 0 ? (info.render.triangles - probe.triangles) / probe.n : 0;
  probe.drawCalls = info.render.drawCalls;
  probe.triangles = info.render.triangles;
  logDebug(
    `FRAME n=${probe.n} avg=${(probe.n > 0 ? probe.sum / probe.n : 0).toFixed(2)}ms max=${probe.max.toFixed(1)}ms ` +
      `stalls=${probe.stalls} stallMax=${probe.stallMax.toFixed(0)}ms raf=${probe.vblanks}/s ` +
      `target=${target > 0 ? `${target.toFixed(2)}fps` : "uncapped"} ` +
      `calls=${probe.callsPerFrame.toFixed(0)} tris=${(probe.trisPerFrame / 1000).toFixed(0)}k ` +
      `attrs=${info.memory.attributes} ` +
      `mode=${loop.mode} locked=${input.locked ? 1 : 0} ` +
      `pf=[${pf.join(" ")}] px=${probe.pxN > 0 ? `${probe.pxMin.toFixed(1)}/${(probe.pxSum / probe.pxN).toFixed(1)}/${probe.pxMax.toFixed(1)}` : "-"} (${probe.pxN})`,
  );
  probe.statAt = now;
  probe.n = 0;
  probe.sum = 0;
  probe.max = 0;
  probe.stalls = 0;
  probe.stallMax = 0;
  probe.vblanks = 0;
  probe.pfBuckets.fill(0);
  probe.pxMin = Number.POSITIVE_INFINITY;
  probe.pxMax = 0;
  probe.pxSum = 0;
  probe.pxN = 0;
}

/** One frame. The mode picks the body; the chain re-arms itself, and the try/catch keeps ONE bad frame
 *  from killing the loop for good (a broken chain used to freeze the picture until a restart).
 *
 *  A VBLANK IS NOT NECESSARILY A FRAME (P1.86). The launch arguments lift Chromium's display-rate limit, so
 *  rAF can fire several times per refresh; `paceWantsFrame` decides which of those draws, and a skipped one
 *  returns before the look, the lane bodies and the probe — after the fixed step, which must not skip.
 *  `timer` is advanced here rather than in the game body because the physics accumulator needs the real
 *  interval on EVERY vblank, in every mode. */
function frame(): void {
  timer.update();
  const delta = Math.min(timer.getDelta(), 0.1);
  probe.vblanks++; // the rAF rate against the drawn rate: `raf=N/s` in the FRAME line (P1.86)
  let drew = true;
  try {
    if (loop.mode === "game") advanceFixed(delta);
    applyViewportSize(); // before the mode body: the canvas follows the window whoever is drawing
    // THE PACK RELOAD CHECK (P1.49ab): Minecraft's shape — a plain flag set by the key handler and checked
    // once per frame (`pendingReload` + `runTick`), never a tick state machine. It only STARTS the driver.
    packReload.maybeReload();
    // THE PACK PAGE'S LIVE LISTING (P1.49ad): the same "poll once per frame, do nothing unless asked" shape.
    packReload.maybePollListing();
    drew = paceWantsFrame(delta);
    if (drew) {
      // Time since the last DRAWN frame: what the render lane and the ui lane mean by `delta`.
      const drawnDelta = loop.sinceDraw;
      loop.sinceDraw = 0;
      // THE LOOK IS APPLIED ONCE PER DRAWN FRAME, here, before any fixed step: the raw deltas that arrived
      // since the last frame become ONE `look` intent, so a frame's rotation is exactly that frame's mouse
      // movement. It used to be an 8 ms `setInterval` poll feeding several intents per frame, which the
      // browser's input-task priority stretched to 9-12 ms as soon as a key was held (measured: `pf` went
      // from "90% of frames at exactly 2 samples" to a 0/1/2/3 spread) — the judder the user reported.
      input.frameLook();
      if (loop.mode === "game") renderFrame(drawnDelta);
      else if (loop.mode === "menu") menuFrame();
      else if (loop.mode === "load") loadFrame();
    }
  } catch (err) {
    logDebug(`frame error: ${String((err as Error)?.message || err)}`);
  }
  // Diagnostics go last — and only for a DRAWN frame: what the FRAME line measures is the interval between
  // frames, so a skipped vblank must not enter it (see `paceWantsFrame`).
  if (drew) frameProbe();
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

// The render/pacing line: the refresh rate is the PLATFORM's answer (it used to be a hard-coded "60Hz",
// which was a guess printed as a fact), and the target is what the two switches add up to right now.
// The webview's own launch arguments are printed next to it: they are where the display-rate limit is lifted,
// so "why is `raf=` not 60/s" is answered by that line.
logDebug(`BOOT webview args: ${shellInfo().browserArgs || "(none)"}`);
const bootTarget = pacingTargetHz(frameCap.cap, frameCap.vsync, frameCap.refreshHz);
logDebug(
  `BOOT render=rAF(pacing ${bootTarget > 0 ? `${bootTarget.toFixed(2)}fps` : "uncapped"}; ` +
    `vsync=${frameCap.vsync ? "on" : "off"}; cap=${frameCap.cap === 0 ? "unlimited" : frameCap.cap}; ` +
    `display=${frameCap.refreshHz > 0 ? `${frameCap.refreshHz.toFixed(2)}Hz` : "unknown"}) winFocused=${winFocused()}`,
);

// ===== Boot: the startup and the two per-frame checks (P1.18e) =====
// The startup itself is `boot/drivers/startup.ts` (its stage list and the settings check live there) and
// the pack reload with its listing poll is `boot/drivers/pack-reload.ts`. What is left here is the ONE
// rAF chain above, which calls them: the reload request and the listing poll ride `frame()`.

const packReload = createPackReloadDriver({
  world,
  log: logDebug,
  stage,
  loop,
  locale,
  voxel,
  setLoopMode,
  refreshMenuBackdrop: () => mainMenu.refreshBackdrop(),
  // The rollback target is the ROOT's: the startup installs the first chain, before any driver exists.
  lastGoodSnapshot: () => lastGoodSnapshot,
  noteSnapshot: (snap) => {
    lastGoodSnapshot = snap;
  },
});


const startGame = createStartupDriver({
  world,
  log: logDebug,
  stage,
  renderer,
  loop,
  frame,
  suppressGeometryPause,
  applyViewportSize,
  showMainMenu: () => mainMenu.show(),
  applyCursor: () => pointerLock.applyCursor(),
  setLoopMode,
});

void startGame().catch((err: unknown) => {
  // Loud, and the startup screen deliberately STAYS up: if the GPU or the world generation failed,
  // showing the main menu would offer buttons that cannot work.
  logDebug(`BOOT failed: ${String((err as Error)?.message ?? err)}`);
});