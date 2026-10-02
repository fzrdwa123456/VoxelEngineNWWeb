# AGENTS.md — guide for AI assistants (and humans who want the fast tour)

> **THIS FILE DESCRIBES THE ORIGINAL NW.js ENGINE, NOT THIS TAURI PORT.** The port's layout, conventions,
> history and open work are in `ROADMAP.md` (plus `docs/TESTING.md` for the manual checklist), and its code
> lives under `src/core`, `src/data`, `src/plugins`, `src/boot` — not under `ecs/`, `ui/` or `logic/`.
> Paths and numbers quoted below (the `SCHEDULE` lines, `plugins/ui/systems/*`, `plugins/ui/views/menu.ts`,
 the assertion-group counts)
> are the ORIGINAL's and are stale here: treat them as historical context, never as a description of the code
> in this checkout.
Read this before changing anything. It maps the architecture, the invariants that keep it
correct, and where new code goes. The user-facing README (Chinese) covers build/run and the
mod/resource-pack format; this file covers how the CODE is organized and which lines are
load-bearing.

**This file describes only what EXISTS.** Everything planned or deliberately skipped is in
`ROADMAP.md` — read that too before proposing work. If the two ever disagree, this file is right and
`ROADMAP.md` is stale.

## What this is

VoxelEngine — a Minecraft-style first-person voxel sandbox on **Tauri v2** (a Rust shell + WebView2;
**there is no NW.js and no Node in the process any more** — `docs/PORT-TAURI.md` is the port's record),
with a three.js WebGPU renderer, packaged as a portable Windows directory. This checkout is the Tauri
port of `VoxelEngineNWWeb`; the NW.js original lives in its own checkout and is not touched from here.

The code is organized as a **microkernel + plugins** tree (`core/` mechanism, `plugins/` features,
`host/` the outside world) with a **data-oriented (DOD)** programming model (columns, hot/cold split,
zero allocation on the hot path, structure changes only at a barrier). Both are written out in
`docs/ARCHITECTURE.md`, and the two sections right after the directory map below are the short version.

**Current world state: a NOISE-TERRAIN, EDITABLE voxel world exists (P1.92).** `src/data/world/`
is a chunk system (32³ chunks) generated from a height field: `data/world/terrain.ts` answers the first air
layer of every column (value noise, 4 octaves, exactly periodic on the torus), and `generateChunk()` in
`data/world/world.ts` writes grass over a dirt band over stone into that column. `plugins/player/systems/
collision.ts` resolves the player AABB against it (you land, walk, jump, and climb hills) and
`plugins/player/systems/interaction.ts` breaks and places blocks with the mouse.
Topology is unchanged and deliberate: **X/Z is a TORUS** (`WORLD_CHUNKS_X/Z` = 1024 blocks, so the noise is
periodic on the same lap) and **Y is bounded** (`[WORLD_MIN_Y, WORLD_MAX_Y)` = 256 blocks); below
WORLD_MIN_Y everything is bedrock, and the ground occupies roughly `TERRAIN_MIN_Y..TERRAIN_MAX_Y`
(96..160) with air and build space above it. There are no biomes, ores, caves, trees or water yet, and the
planet/LOD systems are still gone. `generateChunk()` is still the ONE place that decides what the ground
is — `terrain.ts` is the ONE place that decides how HIGH it is — and nothing else in the engine knows what a
block "is". The spawn Y is read from the generated column (`topSolidY`) by the world-entry driver, because a
height field makes "where does the player stand" a question.

## Directory map — what goes where

```
src/
├── core/                  the microkernel: mechanism only (no game vocabulary)
│   ├── data/                the DOD substrate: entity.ts (handles), component.ts (defineComponent ->
│   │                        SOA columns / defineRecord -> cold records), query.ts (cached sparse-set
│   │                        intersection), store.ts (columns + structuralVersion), resource.ts
│   │                        (Resource<T> tokens)
│   ├── flow/                the execution model: schedule.ts (three stages, after/before resolution,
│   │                        declared access, derived batches), boot.ts (the BOOT_FLOW walker)
│   ├── effect/              command-queue.ts (deferred writes, applied at a barrier) + commands.ts
│   ├── services/            platform-free services: bus.ts (the configuration change bus), perf.ts (the
│   │                        FPS/GPU sampler), settings-diff.ts (the pure settings repair)
│   ├── extension/           THE PLUGIN SYSTEM's core half: point.ts (defineExtensionPoint — a typed
│   │                        slot), slots.ts (SLOT_SYSTEMS / COMPONENTS / RESOURCES / COMMANDS),
│   │                        registry.ts (who contributed what; a duplicate id THROWS)
│   ├── plugin/              the plugin HOST: descriptor.ts (definePlugin), api.ts (the narrow door a
│   │                        plugin is handed), lifecycle.ts (dep order, the manifest's veto, failure
│   │                        isolation), errors.ts (one log line per thrown plugin)
│   └── world.ts             the façade and the ONE import path: spawn/insert/query/resource/addSystem/
│                            stepFixed/render/renderUi
├── plugins/               everything that is a FEATURE (each one owns its data)
│   ├── player/              components.ts (POSITION…TARGET_HIT + the spawn helpers)
│   │   └── systems/         input, snapshot, controller, movement, collision, interaction (fixed lane)
│   ├── render/              systems/: camera, chunk-stream, outline, menu-background, diagnostics
│   ├── ui/                  components.ts (the widget components + prefabs)
│   │   ├── systems/         reconcile (the ONE DOM writer), hud, loading, inventory, bindings,
│   │   │                    toast, keybind, navigation, delays
│   │   └── views/           the wiring that spawns the trees and registers action ids (menu, mainmenu,
│   │                        inventory, hud, loading)
│   ├── ui-debug/            the F3 debug panel + the F3+F4 game-mode chord, split out of `ui` so the
│   │   └── systems/         DEBUG surface is one manifest line away from being off: picker.ts
│   └── input/               keybinds.ts (the bind table, its validation and the settings file) +
│                            bind-gesture.ts (the rebind gesture's EVENT-TIME half)
├── host/                  the boundary: the only place with side effects
│   ├── desktop/             shell.ts (Tauri: settings/logs/window/display refresh), packs.ts (the pack-chain
│   │                        preload), debuglog.ts (the diagnostic-queue forwarder)
│   └── browser/             viewport.ts, rawinput.ts, pointerlock.ts, mousecapture.ts, window-guards.ts,
│                            presentation.ts (the GPU/DOM factories), chunkmesh.ts (the GPU half of the
│                            mesher), mesh-worker.ts + mesh-pool.ts (the meshing WORKERS), blockicons.ts
│                            (the icon baker)
├── data/                  values only: no listeners, no DOM, no GPU, no timers, no module-level behaviour
│   ├── globals/             the resource SHAPES + every shared table: resources.ts, gfx.ts, paint.ts,
│   │                        actions.ts, sources.ts, keybind-gesture.ts, shell.ts, fonts.ts, uiscale.ts,
│   │                        binds.ts, keylayout.ts, faces.ts, probes.ts, boot.ts
│   ├── assets/              read once from the pack chain, then never written: theme.ts (UI_THEME +
│   │                        recipeStyle), i18n.ts (I18N_STRINGS + t()), blockregistry.ts
│   │                        (BLOCK_REGISTRY), textures.ts (the pack chain), background.ts (MENU_BG_KIND)
│   └── world/               the voxel data: chunk.ts (32³ storage; a uniform chunk allocates nothing),
│                            world.ts (the chunk map, the torus, the generator), terrain.ts (THE height
│                            field: pure value noise, exactly periodic on the torus — the ONE place that
│                            decides how high the ground is), palette.ts (value -> block id),
│                            mesh.ts (the PURE mesher: bytes in, typed arrays out — the function the
│                            workers run AND the main thread's fallback)
├── shared/                types and pure helpers with no state: math/raycast.ts (the voxel DDA)
├── boot/                  the composition root: main.ts creates the World, reads the plugin MANIFEST,
│                            installs the plugins into the registry and registers the systems from what
│                            they contributed, inserts every resource, owns the ONE rAF chain, and wires
│                            the views; manifest.ts is the manifest's parser/reader (its shape is in
│                            manifest-types.ts, which the gate imports); ui-tables.ts implements the UI
│                            tables' hook the kernel declares; drivers/ holds the three loading-screen
│                            SEQUENCES (stage.ts = the shared announce/paint/run, startup.ts,
│                            world-entry.ts, pack-reload.ts)
└── vite-env.d.ts          the bundler's type shim
```

READING THE TREE: `core/` = mechanism, `plugins/` = features (a plugin owns its own components and
resources, and every plugin has an `index.ts` that DECLARES them through `definePlugin`), `host/` = the
outside world, `data/` = values, `shared/` = pure helpers, `boot/` = assembly.

THE LAYER RULES (enforced by `check:ecs` since P1.18b, and COUNTED since P1.18d): a plugin may import a
SIBLING only if it declared it in its own `deps`, and the declared graph must be ACYCLIC — otherwise the
install order it implies does not exist. Three pieces that genuinely crossed a boundary were moved rather than
declared: the view direction (`shared/math/view.ts` — the camera and the player's raycast are its two callers),
the UI hit-test shape (`shared/types/ui.ts` — the key bind drag in `plugins/input` asks the question the UI
plugin answers) and the entity-free commands (`data/globals/commands.ts`, P1.18d — see below). The two
remaining directions are counted over RESOLVED specifiers, so the numbers are facts rather than intentions:
`plugins/ -> host/` = **0** at runtime; `core/ -> data/` = **0 at runtime** (6 type-only imports, the shapes of
the slot payloads and the boot stage keys); `data/ -> plugins|host` = **0 at runtime** (1 type-only,
`ChunkGeometry`). A new runtime import in any of those directions fails the gate by name.

**The lesson P1.18d wrote down**: a `core/` file that names a `data/` VALUE is the mechanism depending on the
program, and it is how the kernel ends up knowing game words. Two shapes replaced it, and they are the ones to
copy: (1) a command whose body writes a resource lives NEXT TO that resource (`data/globals/commands.ts` holds
`ShowToast`/`SetFpsCap`/`SetLoadingStage`/`ReloadPacks`/`HotPlugPlugin`; `data/globals/ui-pages.ts` already had
the same shape with `UiLayoutOp`), and (2) a capability the kernel DRIVES but may not name arrives as an
INJECTED hook — `UiTablesHook` (`core/plugin/ui-tables.ts`) is a type, and `boot/ui-tables.ts` is the
implementation the root hands to `installPlugins` and to the hot-plug host, exactly like the log sink.

Placement rule of thumb: touches the OS/browser/Tauri → `host/` (Tauri/files/logs → `host/desktop/`,
DOM/GPU/device events → `host/browser/`); mutates entity data per tick → the owning plugin's `systems/`;
entity state itself → the owning plugin's `components.ts`; a value that is merely STORED (a table, a
constant, a resource's shape) → `data/`; a pure helper with no state → `shared/`; visible DOM → only
`plugins/ui/systems/reconcile.ts` touches the document (a view spawns widget trees and registers action
ids, it does not write styles).

## Architecture — microkernel + plugins

The name of this architecture is **microkernel (+ plugin) architecture**: a core that only knows
MECHANISM, and features that are contributed into it. `plugins/` is no longer a layout: the mechanism is `core/extension/*` + `core/plugin/*`, every folder
under `plugins/` opts in with a `plugin.ts`, and the composition root names NO plugin by hand
(P1.18 built the registry; P1.18b moved the systems' construction into the plugins).

**The three layers, and who may see whom.**

| Layer | Owns | May import | Must never |
|---|---|---|---|
| `core/` | the mechanism: entities/columns/queries, the stage schedule, the command queue, the resource tokens, the World façade, the platform-free services | `core/` + `shared/` + `data/` **types only** (a runtime import of a data VALUE is a gate failure — P1.18d) | any game vocabulary (block/player/menu/i18n), `plugins/`, `host/`, `boot/` |
| `plugins/*` | a FEATURE **and the data it owns** (its components, its resource shapes, its tables) | `core/` + `shared/` + its own folder + `data/` | another plugin's internals; `host/` directly (a device/DOM/GPU need goes through an injected service) |
| `host/` | the outside world: Tauri, files, logs, DOM, GPU, device events | `core/` + `shared/` | `plugins/` (the host does not know what a plugin is) |
| `data/` | values only: resource shapes + every shared table + the pack-chain assets + the voxel data + the commands that write those values | `core/` (its declaration mechanisms: `defineResource`, `defineCommand`) + `shared/` | `plugins/`/`host/` at runtime (one type-only import exists); side effects, listeners, module-level mutable state |
| `shared/` | types and pure helpers | nothing | everything else |
| `boot/` | the composition root: read the manifest, install, start, own the ONE rAF chain, and implement the capabilities the kernel may not name (`boot/ui-tables.ts`) | everything | — |

**Why a plugin owns its data.** The point of a plugin is that it can be installed AND removed, so
`components/` is deliberately NOT a top-level folder any more: a plugin's components and constants live
in its own `components.ts` / `data.ts`. Only a value genuinely shared across plugins belongs in `data/`.

**The extension points (the mechanism, since P1.18).** The core declares named slots in
`core/extension/slots.ts` — `SLOT_SYSTEMS`, `SLOT_COMPONENTS`, `SLOT_RESOURCES`, `SLOT_COMMANDS`,
`SLOT_LANGUAGES`, `SLOT_BLOCKS`, `SLOT_UI_PAGES`, `SLOT_UI_HUD`, `SLOT_UI_ACTIONS`, `SLOT_UI_SOURCES` — and a
plugin contributes into them from its own `plugins/<id>/index.ts` with `definePlugin({ id, deps, setup })`.
`ExtensionRegistry` files each contribution under the plugin id and THROWS on a duplicate id;
`installPlugins` (core/plugin/lifecycle.ts) orders the plugins by their declared `deps`, lets the manifest
veto one, and DISABLES (with a logged reason) any plugin whose `setup` throws — the boot always continues.
The manifest is `plugins.json`, read out of the PACK CHAIN like any other content file, and a plugin it
turns off contributes nothing (its systems never reach the schedule). **The lifecycle is three phases:**
`setup` (contribute — the schedule and the resource table are still being assembled), then
`startPlugins(outcome, log)` AFTER `world.start()` for the plugins that declared a `start`, then
`stopPlugins(outcome, started, log)` in REVERSE order when the app quits — and on an UNINSTALL
(`core/plugin/hotplug.ts`, P1.24) the same `stop` runs plus every teardown the plugin registered through
`api.onStop`. A plugin that fails at any phase is DISABLED with a logged reason, and one that never started
is never stopped.

**Which plugins are OPTIONAL today.** `plugins.json` (read from the pack chain) toggles the ids the code
declares: a disabled plugin contributes nothing, so its systems never reach the schedule. `diagnostics`
(no F3 panel data and no probes), `content-default` (no declared language set or block table) and the five
ui surfaces — `ui-crosshair`, `ui-debug`, `ui-toast`, `ui-inventory`, `ui-keybind` — are genuinely optional,
and those five are also the hot-pluggable ones (F5/F8/F9/F10/F11). `world`, `input`, `player`, `render` and
`ui` are the game itself: `player`/`render` boot but nothing moves or is drawn, and `ui` is REMOVABLE in the
mechanical sense — `boot/main.ts` logs and carries on instead of throwing — but the loading screen and the
menus ARE ui surfaces, so the window then stays unpainted. A plugin whose declared `deps` are missing is
REPORTED at boot, not silently half-installed.

**Turning a SURFACE off must not need a rebuild, and that is a rewriting rule, not a plugin.** The ui lane
was one plugin whose removal left a blank window because every surface lived in it; the fix is one plugin
per OPTIONAL surface (`ui-debug` is the first, P1.23). The rule that falls out of it: **an order edge may
never name a system that another plugin decides whether to install.** An `after: ["ui.picker"]` inside
`ui` would be a dangling name the moment `ui-debug` is disabled, so the two edges that position the picker
are declared ON the picker (`before: ["ui.toast", "ui.widgets"]` in `plugins/ui-debug/index.ts`) and the ui
plugin's own chain stays complete without them (`ui.toast` follows `ui.inventory`, and the picker slips in
between when it is installed). A system's STATE moves with its surface: `PICKER_STATE` is contributed by
`ui-debug` now, not by `ui`.

**HOT-PLUG (P1.24).** The boot is not the only moment a plugin can arrive. `core/plugin/hotplug.ts` is
`installPlugins` without the restart: `hotInstall` runs the same three phases (`setup` contributes, the
systems join the schedule, `start`), `hotUninstall` stops the plugin, withdraws its contributions AND undoes
them (its systems leave the schedule; the resources it CLAIMED stay — P1.28). Both are BARRIER-ONLY and the
door is the `HotPlugPlugin` COMMAND — installing a plugin re-resolves the schedule, so it may not happen
under a running system. The rule that decides what can be plugged in: **a plugin is hot-pluggable exactly
when its `setup` alone is enough to install it** (so it declares its own systems and inserts its own resource;
`plugins/ui-debug`'s factory is the worked example, and the root's `declare*Systems(api, instances)` shape —
still how `ui` works — cannot be installed at runtime). Refused with a reason, never half-done: an id outside
the catalogue, uninstalled `deps`, a double install, and an uninstall another INSTALLED plugin depends on.
**F5/F8/F9/F10/F11 toggle the five optional surfaces live** — crosshair, debug, keybind, toast, inventory
(the key/label table is `data/globals/hotplug.ts`; the ui lane offers the chord without knowing any plugin
id) — and the outcome arrives as a raw toast.

**What the gate enforces about plugins.** Every system is declared by the plugin that owns it (the root
registers nothing by hand: `check:ecs` asserts `world.addSystem({` never appears in `boot/main.ts`), a
cross-plugin import needs a declared `deps`, `plugins/**` may not import `host/**`, the declared graph must
be acyclic, and the boot order is pinned (`last insertResource` < `installPlugins` < the first declaration).
CONSTRUCTION moved too (P1.18b): each plugin's own `plugin.ts` builds its systems from the instances the host
publishes and calls its own `declare*Systems(api, s)`, so the root's plugin array is exactly
`[...discoveredPlugins.map((p) => p.plugin)]`. P1.18c closed the tail: the four optional
surfaces build their own PANELS too, so **the root constructs no system at all** (the gate asserts it — none of
the `create*System` factories, no `new`, and none of those panels). What the root still owns is the VIEWS it
spawns (the HUD and the loading screen, the two menus, the frost layer, the F3 panel widget — spawning is a
structural change, so WHEN it happens is wiring) and the handles the plugins publish BACK for the code that
drives them (`RENDER_HANDLES`, `PLAYER_HANDLES`, `UI_HANDLES`, `INVENTORY_HANDLES`).

## Programming model — DOD (data-oriented design)

DOD is why the data LOOKS the way it does. Six rules, all of them already load-bearing:

1. **Columns, not objects.** A component whose fields are touched as math per tick is a
   `defineComponent` — one typed array per field (`POSITION.x[row]`). State that is low-frequency or
   holds a `Map`/array is a `defineRecord` — one plain object per entity. The choice is made by HOW IT
   IS READ, not by what it "represents".
2. **Resolve once, scan many.** A query is cached and pre-resolved; a system iterates
   `world.query(...).indices` (rows) in a plain `for` loop over contiguous memory. Nothing in a hot loop
   builds an entity object, a closure or an intermediate array.
3. **Zero allocation on the hot path.** A rebuild overwrites its typed arrays in place; a chunk mesh
   keeps ONE geometry whose capacity only grows; per-system temporaries belong to scratch state, not to
   the call. Allocation in `step()` is a bug, not a style choice.
4. **Structure changes only at a BARRIER.** `spawn`/`despawn`/`insert`/`remove` happen during wiring or
   inside a command — never inside a system. The scheduler compares `structuralVersion` around every
   system and throws if one moved it. Every write from outside a system is a COMMAND.
5. **"Parallel" is a computed property, not a claim.** Systems declare `reads`/`writes` (and
   `readsExternal`/`writesExternal`); the schedule derives batches of systems that share no data and are
   ordered by no edge. Inside a batch the order does not matter — and `check:ecs` proves it by replaying
   the fixed lane in both registration orders.
6. **Data is the program.** Tables, tuning constants, resource shapes and content (blocks, languages,
   menu layouts) are DATA; the code reads them. `data/` and each plugin's own `data.ts` exist to make
   that literal — which is also what makes a resource pack a first-class feature.

DOD is NOT functional programming: state is mutated in place on purpose, and the order of systems is
load-bearing (the one thing a purely functional pipeline would not need). What it shares with FP is the
discipline that survives: one owner per value, no cached derivation of another's state, and behaviour
that is a function of data rather than a second copy of it.

## The window's first frame (do not "clean up" these two lines)

`src-tauri/tauri.conf.json`'s window sets `"visible": false` and `"backgroundColor": "#000000"` **on
purpose**. The chain: wry maps the configured colour onto
`ICoreWebView2Controller2::SetDefaultBackgroundColor`; with NO colour wry sets nothing, so WebView2 paints
its factory default — WHITE — until the page's first frame, and every launch opens with a white flash that
reads as "the app is broken". (The line was added in P1.22 and the flash disappeared; deleting it brings the
flash back.) The three layers agree on black: the native window is created hidden, the WebView is black from
creation, and the page is black from `<head>` (`index.html`).

**The reveal is a race, and "await two rAF frames before `showWindow()`" is NOT the fix.** `showWindow()`
runs inside a boot stage, the ONE rAF chain only starts AFTER the boot flow, and at that moment the window is
still hidden — where Chromium throttles rAF. A bare rAF wait could therefore never resolve and the window
would never appear. If the remaining ~2-frame black is ever worth removing, it must be a `Promise.race`
with a timeout (~120 ms), never a bare rAF wait.
## The three lanes (how the loop runs)

The schedule has three stages — `fixed`, `render`, `ui` — and they do NOT all stop together. That
is the whole reason the third one is separate.

```
rAF game loop — ONE chain; `frame()` picks its body from `loopMode` (see setLoopMode in main.ts):

  frame()          // one rAF chain for the whole process, re-armed at the end of every frame
                   // a VBLANK is not necessarily a FRAME (P1.86): the webview's launch arguments lift
                   // Chromium's display-rate limit, so rAF can fire several times per refresh and
                   // `paceWantsFrame` decides which of those draws — see the pacing note below
    "game": timer.update()                                       // real delta, EVERY vblank
      accumulator += delta
      while (acc >= 1/120 && steps < 12) world.stepFixed(1/120)  // fixed tps, MC-style
                                                                 // (steps<12 = spiral-of-death clamp)
          BARRIER: world.commands.flush()        // deferred writes become real here, never mid-system
          fixed lane:
            1. player.input       // drain the device intents of the last frame (keys, view deltas, jump)
            2. motion.snapshot    // PREV_POSITION := POSITION for every entity that carries both
            3. player.controller  // drain VIEW deltas, apply yaw + pitch clamp
            4. player.movement    // query-driven locomotion (PROVISIONAL)
            5. player.collision   // re-integrate + resolve the tick against the voxel world
            6. player.interaction // break / place (polled, rate-limited)
      PACING GATE: `paceWantsFrame(delta)` — the cap and the vertical-sync switch against the display
                   rate the PLATFORM measured. A skipped vblank RETURNS here (the fixed step above has
                   already run; the look, the lanes and the FRAME probe are all skipped with it).
      world.render(alpha, drawnDelta)            // alpha = remainder of the physics tick
          BARRIER again, so a UI/menu command lands before this frame is drawn
          render lane:
            1. cameraView.render(alpha)            // position lerp + orientation quaternion
            2. chunk.stream                        // generate / mesh / place chunks (budgeted)
            3. block.outline                       // the target wireframe, from the TARGET_HIT component
            4. diagnostics                         // perf/PHYS log/F3 (writes the F3 TEXT widget)
            5. renderer.draw                       // renderer.render(scene, camera)
          ui lane — LAST, every frame:
            1. ui.hud                              // the GAMEPLAY gate: crosshair + hotbar only while a world runs
            2. ui.loading                          // the loading screen (visible only while one is up)
            3. ui.inventory                        // write the hotbar/backpack WIDGET data (icons, counts, selection)
            4. ui.bindings                         // resolve every BOUND widget's value from its source
            5. ui.picker                           // F3 panel + F3/F4 mode chord (in a world only) -> widget data + a SetMode command
            6. ui.toast                            // the HUD message, against its wall-clock deadline
            7. ui.keybind                          // the bind panels (derived) + the drag highlight/rubber band
            8. ui.navigation                       // ESC/inventory-key/button EDGES -> UI_MODAL's navigation state, and the ONE painter of the modal widget trees
            9. ui.delays                           // apply the delayed intents whose wall-clock deadline has passed (relock / lock retry / cursor re-assert)
           10. ui.widgets                          // reconcile every WIDGET's element (theme + i18n)

    "menu" -> menuFrame():                      // nothing is simulated and nothing draws over the last
      renderMenuBackground()                    //   world frame; the MAIN MENU is the one state where the
      world.renderUi()                          //   user still clicks things — barrier + ui lane ONLY
                                                //   (world.renderUi() = barrier + the ui stage)
    "load" -> loadFrame():                      // a LOADING SCREEN IS UP (the startup, and an entry
      world.renderUi()                          //   into a world): the ui lane alone, because the screen
                                                //   is widget data. See "Boot" below.
                                                // Both UI modes are paced at the DISPLAY rate whatever the
                                                // settings say: they were never part of the frame-rate
                                                // setting, and without pacing a lifted display-rate limit
                                                // would pump the ui lane hundreds of times a second.
```

**FRAME PACING IS OURS, AND IT IS WHY THE VSYNC SWITCH NEEDS NO RESTART (P1.86).** The webview's launch
arguments lift Chromium's own display-rate limit *unconditionally* (`--disable-gpu-vsync
--disable-frame-rate-limit`, `game.rs`), and two values then decide the rate, both read by the loop every
frame: `FPS_CAP.cap` and `FPS_CAP.vsync`. `pacingTargetHz(cap, vsync, refreshHz)` (a pure function in
`data/globals/resources.ts`) is the whole rule — unsynced means the cap (0 = uncapped), synced means the cap
but never above the panel — and `paceFrame` is the accumulator test, extracted so the arithmetic can be
asserted. Three consequences worth knowing:

* **the display's refresh rate comes from the PLATFORM, not from a measurement** (`platform::display_refresh_milli_hz`
  → DWM's own timing ratio, in MILLI-Hz): a rAF delta cannot see the panel any more (rAF fires *more* often
  than the panel refreshes), and a 59.94Hz panel answered as "60" drifts — one duplicated frame every ~16
  seconds. 0 = "unknown", which paces at a plain 60 — never at "uncapped", which would invert the switch's
  own label;
* **a vblank is not a frame**: the fixed step runs on every vblank (before the gate) and the look, the lane
  bodies and `frameProbe` run only on drawn ones, which is what keeps the `FRAME` line — and the FPS number —
  meaning "drawn frames". The `FRAME` line's `raf=N/s` next to `n=` is the one number that says whether the
  browser really let go (60 next to 60 = it did not);
* **what this still cannot do** is switch the GPU's present mode (FIFO / immediate) at runtime: that is a
  swapchain concept and no browser exposes one. Pacing is what the switch's label promises, and the old
  shape — a `config/vsync.json` file plus a "restart to apply" hint — is gone along with the file. The
  compositor's vblank wait and Chromium's frame-rate limit are the BROWSER'S DEFAULTS again (P1.90): both
  experiments that lifted them are out of the launch arguments, because they cost the default mode more than
  the option was worth (see the launch-argument note above).
  **AND THE SYNCS ARE NOT ALL EQUAL (measured)**: a target equal to the panel rate lands at ~57fps rather than
  60, because the unthrottled callback rate (~1.8 per panel refresh) does not divide into the panel's rate —
  see `paceFrame`'s note. `--disable-gpu-vsync` is deliberately NOT in the launch arguments either (it made the
  synced case submit between vblanks, i.e. the judder), so presents stay vblank-locked and the compositor shows
  the newest frame once per refresh. An exact 60 needs a vblank clock; do not paper over it with a fudge factor
  (a 4% early budget was measured and changed nothing).

**There is ONE loop and ONE MODE, not three loops and a pile of flags.** `setLoopMode("load" | "game" |
"menu")` is a PURE MODE WRITE — the chain is already running, so there is nothing to start, stop or
cancel. Every call site says which state it wants (boot, entering a world, back to the main menu)
instead of which one to leave. "Are we playing" is DERIVED (`inWorld()`), and `check:ecs` asserts there
is exactly ONE `requestAnimationFrame`, no `cancelAnimationFrame`, and a frame body that dispatches on
the mode. The mode starts as `"load"` so the first transition always applies; the STARTUP DRIVER
(`boot/drivers/startup.ts`) ends by calling `deps.frame()` directly, which is the single place a frame is
kicked off. (Why this shape replaced
three chains with a `stopLoop()`/`startLoop()` pair is in ROADMAP §3.8.)

MENU mode halts the simulation AND the draw, which keeps the last world frame on screen and the CPU
idle — but the UI does not stop with it: a toast raised from the main menu is drawn by the menu frame's
`world.renderUi()` (before that, the write reached no DOM and the multiplayer placeholder was silent).

**An open modal does NOT imply MENU mode.** Only the back-to-main-menu action leaves the game loop: the
BACKPACK takes the local player's INTENT away (`canControl()` false → `controller`/`interaction` skip
it, `movement` drops its keys) while the world keeps streaming and drawing. The freeze removes INTENT,
not PHYSICS: `movement` still integrates the body, so an airborne player lands normally, and NPCs
(which never consult the gate) keep moving. Its commands and its DOM ride the ordinary frame.

**The load-bearing order is DECLARED, not implied.** Three things are declared per system, in the
system's own module and spread into its registration in `main.ts`:

- `after` / `before` — ORDER: "player.movement runs after player.controller".
- `reads` / `writes` — ACCESS to components. A component in `writes` is also implicitly read.
- `readsExternal` / `writesExternal` — ACCESS to state the ECS does not model: `"camera3d"`,
  `"chunkMeshes"`, `"voxelBlocks"`, `"dom.f3"`, `"framebuffer"`, `"perfSampler"`. Free-form names,
  so reusing one is how you say "we touch the same thing".

`world.start()` sorts each stage, verifies the declared order, and then **derives the batches**:
groups of systems with no conflicting access and no edge between them. Members of a batch may run in
**any order**; the batches run in order. `run()` executes batch by batch and, inside a batch, in
resolved order — determinism over a fake thread. `world.scheduleReport()` prints the result and
`main.ts` writes it to `debug.log` at boot. Today:

```
SCHEDULE fixed: 6 systems, 5 batches, 1 parallel pair(s) [player.input | (motion.snapshot ~ player.controller) | player.movement | player.collision | player.interaction]
SCHEDULE render: 5 systems, 2 batches, 6 parallel pair(s) [(cameraView.render ~ chunk.stream ~ block.outline ~ diagnostics) | renderer.draw]
SCHEDULE ui: 11 systems + 4 gap(s), 13 batches, 3 parallel pair(s) [(ui.pages ~ ui.hud ~ ui.bindings) | ui.loading | ui.slot.bag* | ui.inventory | ui.slot.debug* | ui.picker | ui.slot.toast* | ui.toast | ui.slot.keybind* | ui.keybind | ui.navigation | ui.delays | ui.widgets]
```

Reading those reports: the fixed lane's batch 0 is a REAL read-after-write (`player.input` writes
the VIEW/keys the three systems after it consume), and its edge to `motion.snapshot` is a declared
PESSIMISATION kept so the tick still drains first. `renderer.draw` must follow its two producers
(`cameraView.render` writes the camera, `chunk.stream` the meshes) — while `block.outline` joins the
producers' batch because it touches neither: it reads the TARGET_HIT COMPONENT and writes a target of
its own, so any position among them is correct — the mesh is only read by the draw at the end of the
lane, by which point the batch is done. The
ui lane is a CHAIN because the conflict model is per COMPONENT, not per entity: the writers all touch
UI_STATE/UI_TEXT on different widgets. The one REAL pair there is `ui.hud ~ ui.bindings`
(UI_STATE vs UI_INPUT) — what a batch looks like when the components are genuinely disjoint.

`ui.navigation` is last of the WIDGET-DATA writers on purpose: only it turns `UI_MODAL` into widget
visibility, so it must follow every writer that could touch the same modal trees and precede
`ui.widgets` (which is why it is registered first of the two — an `after: ["ui.widgets"]` would be the
opposite order). `ui.delays` sits between them: it writes no widget data at all, but it shares
`ui.navigation`'s two external targets (`pointerLock` / `cursor`), so the conflict rule forces that
edge — and its own `before: ["ui.widgets"]` is what keeps the reconciler the last system in the lane
(without it the two would share a batch and "the reconciler is last" would be an accident of the
resolved order).

Two rules are enforced at boot, both of which used to be conventions:

1. **A dependency must be DECLARED.** Two systems in a stage that touch the same component or external
   target and are ordered by no `after`/`before` path make `resolve()` throw — leaning on registration
   order is the "order that exists only as a comment" problem. It found four fake edges, the worst being
   `player.movement` pointing at the camera instead of `motion.snapshot` (a snapshot taken *after*
   movement leaves collision a zero-length sweep, so the entity never moves).
2. A typo'd label, a cycle, a constraint the sort failed to honour, OR AN `after` THAT NAMES A SYSTEM
   IN ANOTHER STAGE throws. That last one is deliberate: cross-stage order is fixed by the lane
   sequence, so an edge across lanes would silently do nothing.

**`load` mode means A LOADING SCREEN IS UP, and it serves two flows**: the startup (settings check →
GPU → main menu) and ENTERING A WORLD (the spawn window's generation and meshing). Both run the ui lane
alone — the screen is widget data, and during the startup the renderer does not exist yet — and both
drive the SAME `LOADING_STATE` + `ui.loading` + `ui/loading.ts` screen through `SetLoadingStage`,
one announce-reconcile-yield per stage. (Everything is `load`/`loading` now; the mode was `boot`
until it also served world entry.)

The startup driver's first act is to ACTIVATE the screen (`SetLoadingStage { active: true }` — the tree is
spawned hidden, so a driver that skips this leaves the window on the HUD ALONE: a black page with a
crosshair and a hotbar, which is how that bug was reported), and only then does it announce a stage,
reconcile it and yield one macrotask, reveal the window and run `renderer.init()`. Revealing the
window AFTER `renderer.init()` was the original complaint: the GPU handshake, the world generation and
the first ~100 frames of meshing all happened behind a hidden window, so the startup was a black
rectangle for as long as it took.

**The world itself is built on ENTRY, not at startup** (`boot/drivers/world-entry.ts`): the Teleport goes
through the barrier first (the warm-up reads POSITION), then `world.spawn` → `world.terrain`
(`chunkStream.prime`) → `world.chunks` (`chunkStream.warmUp`, which meshes the WHOLE spawn window instead of
spreading it over ~100 frames) → `world.ready`, and the mode hands over to `game` in the same ui lane that
takes the screen down (a game frame draws the scene BEFORE its ui lane, so no empty frame shows). The STARTUP
DRIVER (`boot/drivers/startup.ts`) must not touch `chunkStream` at all — the gate asserts that separation, and
it is why the main menu is up after ~0.45 s instead of ~2 s. A RE-entry into a window that is still built skips
the screen entirely (`chunkStream.needsWarmUp`), because a screen that appears for one frame is worse than none.
**EACH driver ACTIVATES the screen itself** (`SetLoadingStage { active: true }`): the startup's last stage
sets `active = false`, so the entry has to set it back — this shipped broken twice, and the gate now
asserts the flag per driver. It also has to enter `load` mode (it is driven from the MENU).

**THE DRIVERS ARE FILES, NOT SECTIONS OF THE ROOT (P1.18e).** `boot/main.ts` is the composition root and the
ONE rAF chain; the three sequences that drive the loading screen live in `boot/drivers/`, and each takes ONE
deps object of the wiring the root owns:

| file | what it drives | how it is reached |
|---|---|---|
| `boot/drivers/stage.ts` | the shared half: announce (through the command barrier), paint (one macrotask), and `run(flow, stages)` = the walker | built first, handed to the other three |
| `boot/drivers/startup.ts` | the settings check, the window reveal, the GPU handshake, the menu hand-over — and the `BOOT_STAGES` DATA | called once at the bottom of the root |
| `boot/drivers/world-entry.ts` | the Teleport, the spawn window's prime + warm-up, the mode hand-over and the capture decision | `createMainMenu`'s "singleplayer" callback |
| `boot/drivers/pack-reload.ts` | the F7 reload (rescan → install → re-derive → drop caches → mark stale, with rollback) AND the pack page's live listing | `frame()`, once per frame |

The rollback SEED (`lastGoodSnapshot`) stays the ROOT's: the startup installs the first chain before any driver
exists, so the driver reaches it through a getter and a setter instead of owning it.

The per-stage yield is a `setTimeout` macrotask, NOT a second `requestAnimationFrame` chain: the process
still owns exactly one, and the gate asserts it.

**The settings FILE is checked at boot, repaired, and written back.** Every config module validates its
own field and silently falls back when it cannot (`loadLang` ignores a language the install does not
DECLARE — the set is content, discovered from the pack chain, see `data/assets/languages.ts`;
`sanitizeFrameCap` turns a hand-edited `fpsCap: 1` into 30, `loadBinds` drops a code it does not know).
That is right at LOAD time, but it left the file saying one thing while the game used another — the bad
value survived on disk, unreported, and every launch guessed again. `host/desktop/shell.ts`'s
`diffSettings(raw, inForce)` is a PURE comparison that repairs by rewriting each unusable value with the
one in force, reporting a keybind per ACTION and KEEPING keys the engine does not know (an older build
must not trim a newer file). `inForce` doubles as the schema. An UNREADABLE file is different: it is
copied to `config/settings.bad.json` and rebuilt from the values in force. The outcome goes to
debug.log and onto the loading screen (`loading.fixed` / `loading.unknown` / `loading.rebuilt` + the names),
which is also how it is tested by hand.

**There is no multi-core executor — the schedule is the scheduling HALF only.** It knows what may run
concurrently and `check:ecs` proves the grouping; the blockers are the DATA MODEL (record components are
JS objects a Worker can only clone; the voxel Map is not shareable), written out in ROADMAP §3.9.

**…but the engine HAS one real multi-core path: chunk meshing (P1.18h).** It is not the schedule: the work is
one independent JOB per chunk, so it does not need the batch model at all. The route, and why each piece is
where it is:

* `data/world/mesh.ts` is the **PURE mesher** (`meshChunk`): voxel BYTES in, four typed arrays plus the look
  slots out — no three.js, no GPU, no block table, no `VoxelWorld`. That is what a Worker may run, and it is
  ALSO the main thread's own path (`ChunkGeometry.rebuild` = gather → `meshChunk` → `apply`), so the two
  cannot drift into two meshers.
* a job's INPUT is small on purpose: the chunk's own voxels are omitted entirely while the chunk is UNIFORM
  (the value says it all and the scan only visits the boundary shell), and the only outside information is six
  32×32 neighbour SOLIDITY planes. All of it is built fresh per job and **transferred**, never copied.
  **THE PLANES' LAYOUT IS A CONTRACT BETWEEN THE GATHERER AND THE MESHER**: `gatherChunkMeshInput` writes
  every plane as `a * S + b`, and `makeSolidAt` must read it the same way (the pairs are (ly, lz) for ±X,
  (lx, lz) for ±Y and (lx, ly) for ±Z). A uniform plane is symmetric, so reading one transposed hides until a
  block is broken on that border — then the mesher culls a cell from elsewhere in the same layer and the
  newly exposed face is simply MISSING (P1.91: the ±Z planes were read `lx + ly * S`). The gate drives a real
  world through both halves and asserts WHICH face appears, not just how many.
* the output's looks come back as KEYS (`(voxel value << 2) | kind`), because the palette, the block table and
  the pack chain behind them are main-thread state; `ChunkGeometry.apply` resolves each key with the SAME
  `specFor` the in-place scan used, so a chunk's material list is identical whichever thread meshed it.
* `host/browser/mesh-pool.ts` owns `hardwareConcurrency - 1` workers (`mesh-worker.ts` is the entry Vite
  bundles) and **only answers with a queue**: the render lane's `chunk.stream` step DRAINS it and applies the
  results inside the lane. Nothing touches the scene from a worker callback, so the scene stays a lane's
  business and the order stays deterministic.
* `CHUNK_MESHES.inFlight` is the validity token: a key that is no longer in it was rebuilt on this thread (a
  block edit) or left the window, so a late result for it is dropped instead of overwriting fresher geometry.
  It also keeps one chunk from being asked for twice. **THE EDIT PATH IS WHAT MAKES IT TRUE**: `rebuild`
  DELETES the key before it re-meshes (P1.91), because a job already out was gathered from the world BEFORE
  the edit — leaving it in flight let the pre-edit mesh land a frame later and put the removed face back.
  The job is not cancelled (a worker is told nothing), it is dropped on arrival.
* **BLOCK EDITS STAY ON THE MAIN THREAD** (the player is watching one block — a round trip would put the mesh
  a frame or two behind the click) and so does the no-pool environment (the Node gate, a browser without
  workers): the pool is an INJECTED capability, absent = the behaviour the engine had before.
* a worker that dies does not leave a hole: **only its own jobs** come back as `null` and those chunks are
  meshed here, the failure is reported to `debug.log` ONCE per worker, and the DEAD WORKER IS DROPPED so the
  rest of the pool keeps its throughput (P1.18i). A pool that ends up with no worker at all reports
  `workers = 0`, which the lane reads as "no pool" (`ChunkStreamSystem.hasPool`) rather than as "saturated
  for ever" — otherwise a broken worker pool would silently stop meshing the world, and the render plugin
  hands the stream `null` for a pool that never started one.
* **A PACK RELOAD RESTYLES, IT DOES NOT RE-MESH (P1.18i).** A new resource chain changes what a block LOOKS
  like, while a mesh's vertices depend on the VOXELS alone (every uv is a per-face constant) — so
  `VoxelWorld.markAllStale` queues LOOK work, and `ChunkGeometry.restyle` re-resolves the material of every
  existing slot in place (it keeps each slot's `(value, kind)` key for exactly this). The mesh, its buffers
  and its `geometry.groups` all stay where they are, and nothing is handed to a worker: a reload costs a few
  thousand LOOKUPS instead of a few thousand chunk meshes. A future reason to mark a chunk stale that MOVES
  vertices must re-mesh instead.
* **…and the RELOAD DRIVER drains that queue BEHIND THE LOADING SCREEN** (`restyleBehindScreen` →
  `chunkStream.restyleStale`, reached through the published `RENDER_HANDLES`), which is the same shape as the
  world entry driving `warmUp` into the same screen. `restyleNext(128)` is the ONE batch both callers use —
  the render lane takes one per frame (`step`), a driver takes as many as it can while it holds the screen —
  so the reload's cost is paid where the user is already waiting. Left to the game frames it was a 32 ms
  frame (the material rebuild) plus ~24 frames in which the window still showed the previous chain. The loop
  is BOUNDED (`RESTYLE_DRAIN_BATCHES` = 256 batches), so a world larger than this one cannot wedge a reload's
  screen: whatever is left is drained by ordinary game frames.
  MEASURED: entering a world went from `WORLD ready at 2301ms` to **97ms** with 11 workers on a 12-thread
  machine, and the app logs `RENDER meshing: N worker(s)` at boot; toggling a resource pack in a LOADED world
  logs `3016 chunk(s) stale, 3016 restyled behind the screen (looks only, no re-mesh)` with no game frame
  over ~20 ms and `stalls=0`.

## Iron rules (breaking any of these = silent bugs)

1. **Structural changes happen only at a BARRIER.** `spawn`/`despawn`/`insert`/`remove` are legal
   during wiring and inside a command — never inside a system. The scheduler compares the store's
   `structuralVersion` before and after EVERY system and throws if a system moved it. Route every
   outside write through `world.commands.send(...)`; the barrier applies it at the top of
   `stepFixed`, of `render` and of `renderUi` — ANY entry point, including the stopped-loop pump.
2. **Component data does not move while systems run.** That is what rule 1 buys, and it is why
   column access is safe. The two storage kinds still differ:
   - SOA columns (`POSITION.x`) are typed arrays that get **re-allocated** when the entity count
     outgrows them. Reading them inside one system step is safe; never cache the array itself
     across a structural change.
   - RECORD components (`world.get(e, CONTROL)`) return an object whose **identity is stable** for
     as long as the component is attached, so caching it for the system's lifetime is correct.
     `insert` throws on duplicates and on dead entities — enforcement, not a suggestion.
3. **The mouse-capture/input race code in plugins/player/systems/input.ts is timing-sensitive**
   (skipFirstMove, lockGraceUntil, raw-input takeover arbitration, spike guards). It encodes
   real Chromium/Windows races. Do not simplify or reorder without replaying them. The DOM listeners
   still take every one of those decisions at EVENT time and only QUEUE the result; `step()` (fixed
   lane, first) writes it. That split is what lets input be an ordinary scheduled system — keep the
   decisions on the event side. The guards' STATE is the INPUT_TIMING resource (so a test and a log can
   see why a mousemove was swallowed) — that is a move of where the fields live and NOT a licence to
   touch the logic: reordering a guard is still a rule-3 replay job.
4. **All game state changes happen on the single JS main thread** in a deterministic order.
   The only other threads are the rawinput native plugin's collector thread (atomic
   accumulator, polled every 8 ms) and the GPU. Keep it that way.
5. **Comments that say "do not simplify" document fixed bugs.** They are load-bearing.
6. **Field initializers cannot read parameter properties.** Native class fields initialize
   before constructor-body parameter-property assignments — resolve component/resource handles in
   the constructor BODY (see the pattern in every system).

## ECS conventions

- An entity is a HANDLE (`index << 8 | generation`); component columns are addressed by ROW
  (`entityIndex(entity)`). Never mix the two up. `world.despawn` + `spawn` recycles the slot with a
  bumped generation, so a stale handle stays dead instead of pointing at the new occupant.
- Two storage kinds, chosen per component:
  - `defineComponent("name", { x: "f32" })` → SOA. Read `POSITION.x[row]`. For numbers touched as
    math per tick. No per-entity object exists. A `{}` schema is a legal zero-size MARKER
    component: `PLAYER` is one, and is read as `PLAYER.sparse[row] >= 0`.
  - `defineRecord("name", () => ({...}))` → one plain record per entity, read with
    `world.get(entity, CONTROL)`. For object-valued state (a `Set`, the item array).
- **Component or resource?** Ask two questions: how many are there, and does it die with an entity?
  One per world → RESOURCE (time, the input device, `VOXEL`, `LOCAL_PLAYER`). One per entity →
  component. `HUMANOID_BODY` /
  `DEFAULT_REACH` are spawn DEFAULTS, not state — the numbers each entity actually uses live in
  BODY / REACH.
- **"What did I write last" is DATA too.** A reconciler or a widget-data system needs one thing that is not
  game state: the value it painted last frame, so it can skip an unchanged write. Those caches are resources
  now, not private fields: `UI_PAINT` (logic/ui/paint.ts) holds the reconciler's ELEMENT TABLES, the per-widget
  drawn cache, the hover/press sets, the applied global style, and the diff caches of `ui.loading`,
  `ui.toast`, `ui.hud`, `ui.keybind`, `ui.inventory`, `ui.navigation` and `ui.bindings`; the same treatment
  applies outside the UI (`INPUT_INTENTS.frameDx/Dy`, `CHUNK_MESHES.wantedKeys/lastPcx/lastPcz`,
  `DELAYED_INTENTS.applied`, `PICKER_STATE.outsideWorld`, `VIEWPORT.appliedAspect/listenerInstalled/
  publishScheduled`, `INPUT_STATE.appliedCursor`). A cache is never read to ANSWER a question — every value
  it mirrors is re-derived from its owner every frame — so losing one costs a repaint, never a wrong answer.
  The classes keep thin accessors onto the resource, which is why the use sites read the same as before.
- **The host, the assets and the loop are data as well.** `SHELL_STATE` (data/globals/shell.ts) is the shell's
  own bookkeeping — the settings snapshot, the queued log lines, the log-flush deadline, the diagnostic-probe
  switch and the
  foreground flag — created by that module at import time (a log line can be written before the World
  exists) and inserted by the composition root; `I18N_STRINGS`, `BLOCK_REGISTRY` and `MENU_BG_KIND` are the
  pack chain's asset caches, same pattern. `LOOP_STATE` (the mode, both accumulators, the canvas size last
  applied, the geometry-suppression deadline) and `FRAME_PROBE` (the frame probe's counters) are the one
  frame loop's state; the loop BODY stays in `main.ts` — a rAF callback is not a lane — but it now reads and
  writes world data. `BOOT_FLOW` + `core/flow/boot.ts` do the same for the two drivers: the stages (progress, i18n
  key, work) are a DATA list declared by the composition root and `runBootFlow` is the only logic — announce
  a stage, yield one macrotask so the browser paints it, then run its work.
- **A GPU/DOM object is a RESOURCE, not an argument** (`host/browser/presentation.ts`). There is one scene, one
  camera, one renderer, one UI mount root, one chunk-mesh cache, one item-icon baker, one chunk material
  and one target wireframe per world, and they do not die with
  an entity: that is the definition of a resource. They used to be constructor dependencies, which made
  the objects a system writes every frame the only shared state in the process with no owner — and the
  only way to learn who used one was to read main.ts. Now the composition root creates the object,
  inserts it, and each system resolves it in its constructor body (iron rule 6); a test drives a render
  system by inserting a stub. What is still NOT a resource: per-CALL scratch an operation builds and
  throws away (a bake's canvas, its render target and its temporary scene) and the DOM elements of a
  VIEW (an element, the SVG rubber band) — those die with the call or belong to the view. Anything that
  OUTLIVES the call that made it is a resource even when a system builds it lazily
  (`MENU_BACKGROUND.scene`, `ICON_BAKE.renderer`). The DECLARED TARGETS (`camera3d`, `chunkMeshes`,
  `framebuffer`, `blockOutline`) stay in the
  access sets: the schedule models names, not resource handles.
- **CONFIGURATION splits the same way, by whether it is READ ON THE TICK.** A setting that a system or
  the reconciler asks for every step/frame IS world state and lives in a resource (`KEYMAP` — read by
  movement/interaction/input every tick; `LOCALE` — the reconciler re-derives every widget's text from
  it every frame; `FONT`/`UI_SCALE`; `FPS_CAP`, which holds the cap, the vertical-sync switch AND the
  measured refresh rate, because the loop's pacing reads all three every frame). A setting read only
  when its panel opens, or written only when it changes, is plain configuration and stays in its module
  (`windowMode`, the settings FILE itself). Either way the config module owns the file and the validation, and the
  resource is the single owner of the value in force. `background.ts` and `data/assets/blockregistry.ts` are
  neither: they derive their answer from the PACK CHAIN, which never changes after boot, so they are
  assets — the menu background kind is memoised because the menu frame asks for it every frame.
  **A setting that needs a RELAUNCH is not a setting** (P1.86): the vertical-sync switch was one — a
  `config/vsync.json` that only the next launch read, sitting next to a slider that applied at once — and the
  fix was to move the *decision* into the loop's pacing instead of leaving it in the launch arguments.
- **Never keep a CACHED DERIVATION of another resource's state.** `INPUT_STATE` used to carry
  `clickLockAllowed`, a copy of `!isModalUi(UI_MODAL)` kept in sync by `pointerlock.applyCursor()`;
  the mouse-button path asks UI_MODAL at the moment of the question now, which is why a click can no
  longer grab the pointer behind a menu for a frame. If two places must agree, one of them derives.
- **Adding a new kind of entity** (an NPC, a physics prop): start from
  `attachMovable` / `spawnMovable`, which IS the declaration of what a physical body needs. Three
  queries have to be satisfied by it — movement's, collision's and the snapshot's — and the Node
  assertion suite pins that coupling, so changing a query without changing the helper fails loudly.
  A generic movable entity gets no PLAYER marker (the input freeze never applies), no VIEW (mouse
  deltas are local-input-only) and no REACH/INTERACTION/INVENTORY (so it cannot edit blocks).
- `placeEntity` is the ONLY way to set a position at spawn. It moves POSITION and PREV_POSITION
  together, and a spawn that moved only POSITION would leave the next collision sweep starting from
  the old place.
- The player's state is all components: POSITION, PREV_POSITION, ORIENTATION, VIEW (buffered view
  deltas), MOTION, CONTROL, BODY (half width/height/eye height), REACH, INTERACTION (break/place
  cooldowns), INVENTORY (stacks + selected slot), TARGET_HIT (the block its ray hits, so the wireframe
  crosses lanes as DATA) and the PLAYER marker.
- Systems never import each other. Shared device/global state is a RESOURCE
  (`world.resource(INPUT_STATE)`, `LOCAL_PLAYER`, `VOXEL`); per-entity state is a component. That
  is the whole rule — if two systems need the same thing, one of those two is where it goes.
- **A system declares what it touches, in its own module** (`SNAPSHOT_ACCESS`, `MOVEMENT_ACCESS`,
  ... in `logic/fixed/*.ts`, spread into the registration in `main.ts`). Options: `reads`,
  `writes` (components), `readsExternal`, `writesExternal` (free-form target names for the DOM, the
  GPU, a three.js object). Forgetting a declaration is the one mistake the schedule cannot catch:
  its model of the system is only as good as the declaration. Declaring too much costs a fake
  ordering edge; declaring too little costs a missed conflict.
- **Parallelism is a property the schedule COMPUTES, not a claim to make.** `world.batchesOf(stage)`
  is the grouping; `world.scheduleReport()` prints it and `main.ts` logs it at boot. A batch means
  "these may run in any order" — and `npm run check:ecs` checks that, by running the real fixed lane
  with the batch's members registered in opposite orders and asserting an identical 400-tick
  trajectory. A declared `after`/`before` is honoured in either registration order too, even between
  two systems that share NO data (the edge alone splits the batch). Add a system, declare its access,
  and read what the report says about it.
- Query-driven: `world.query(A, B).indices` gives matching ROWS, `.entities()` gives handles; the
  query is cached per component set and `refresh()` is implicit and cheap. Any entity carrying
  those components is picked up automatically — that is how a future NPC joins for free.
  `movement`, `collision` and `interaction` are query-driven; the camera, the chunk stream, the
  diagnostics panel and the input system resolve the LOCAL player's row once instead, because they
  are singular by nature (one camera, one pointer, one F3 panel).
- A global gate that must apply to ONE entity is data, not an early return: the freezes on
  `INPUT_STATE` are applied per entity with the PLAYER marker, so an uncontrolled local player loses
  its INPUT while an NPC keeps moving. It loses only the input, though: `movement` still integrates
  gravity and the carried velocity for it, because "the UI owns the mouse" is a statement about
  intent, not about physics (a frozen player that hung in mid-air was the bug that taught us this).
- **GAMEPLAY UI belongs to a world.** The crosshair, the hotbar, the F3 panel and the F3+F4 mode chord
  are gated on `inWorld()` (`ui.hud` owns the first two, `ui.picker` the rest) — the toast is
  deliberately NOT, because a main-menu message is a documented case. The engine's other gate,
  `canControl()`, says what the MOUSE does; "which UI may be up" is this one.
- **The UI is DATA, and `ui.navigation` is the one place that turns it into visibility.** A surface
  does not own its own visibility any more: `Menu.show/hide`, `MainMenu.show/hide` and the inventory
  toggle write the `UI_MODAL` resource (a `world.resource(UI_MODAL)` write, so a *view* never touches
  the DOM to hide itself), and `plugins/ui/systems/navigation.ts` is the ONE painter — it maps that state onto the
  modal widget trees' `UI_STATE` every frame. Which settings sub-page is up is data too
  (`UI_MODAL.settings`), and one shared mapping (`stepBackSettings`) answers "what is one level back"
  for ESC, both menus' `goBack()` and every Back button; it used to exist twice and the copies
  disagreed, so ESC on the settings list was a no-op and ESC on a sub-page skipped a level. ONE gate
  then takes the player's INPUT away: `canControl(devices, ui) = (locked || freeMouseActive) &&
  !isModalUi(ui)`. (The five-site OR chain and the `applyCursor()` cache this replaced are in
  ROADMAP §5.2 P1.5.)
- Sub-panels carry NO modality flag: they are widget CHILDREN of their container, so hiding the
  container hides them, and `isModalUi` deliberately reads only the three container flags. Which
  sub-panel is up is data (`UI_MODAL.settings` / `UI_MODAL.gen`) — never read back out of
  `element.style.display`, which is what made "the first ESC after resuming from settings does
  nothing" possible.
- Nothing outside a system writes components: UI and DOM handlers send COMMANDS
  (`world.commands.send(SelectSlot, {...})`, definitions in `ecs/commands.ts`). The composition root
  wires; it does not play. A DEVICE event is the third case and has its own shape: `input.ts`'s DOM
  listeners decide at event time and QUEUE an intent, and its `step()` (fixed lane, first) writes it —
  so the rule holds without an exception, while the pointer-lock/raw-input arbitration stays exactly
  where the race needs it (iron rule 3).
- **A surface is driven by a resource, so the code that DRIVES it never touches a component.**
  `ui.loading` is the worked example: the composition root owns the startup's and the world entry's
  stages, and the only thing either driver does is send `SetLoadingStage` — the screen's text, bar and note
  are world state, and a
  SYSTEM turns them into widget data. The same shape as the toast (a command arms it, `ui.toast` shows
  and expires it). If a surface needs to be moved from outside a lane, the move is data + a command;
  never a DOM write from the caller.
- A view that mirrors component data is a render system that RECONCILES (diff against the last
  drawn state, touch only what changed) — `ui.inventory` is the pattern. View-local state that
  neither an entity nor a system owns may stay in a view (the reconciler's hover/press bits, the
  DOM elements themselves); a VISIBILITY flag may not — "is the backpack open" is
  `UI_MODAL.inventory`, painted by `ui.navigation` — and neither may a scroll position
  (see `plugins/ui/systems/reconcile.ts`).
- Flat files until a module needs a second file; then a folder + a `create()` factory, and
  registration stays explicit.
- A DOM writer belongs in the `ui` STAGE, never in `render` — that lane stops with the game loop,
  and the UI does not. `scripts/check-ecs.mjs` asserts it for every system that declares a `dom.*`
  target, and today there is exactly ONE: the reconciler. Every other surface writes widget data.
- **A widget's value may be BOUND rather than owned.** `UI_BIND { source }` says "this widget's number
  comes from shared state"; `UiBindingSystem` (ui lane, before the reconciler) resolves it, snapping to
  the widget's own range. Use it for anything that mirrors state two surfaces both show — the FPS cap
  is the worked example (two settings panels, one value, and they used to drift). Do NOT bind a
  FORMATTED string: "60 FPS" vs the word for "unlimited" is surface logic, so the label around a bound
  slider is still a push, refreshed when its panel opens. The resolver never writes the DOM — the
  reconciler does — and a missing source is a LOUD no-op (logged once), not a crash.
- **A PUSHED label whose value arrives through a COMMAND must be HANDED it, not read it back.** A command
  applies at the next barrier, so a handler that sends one and then reads the resource prints the
  PREVIOUS value — and a pushed label is only refreshed when its panel opens, so it stays wrong until
  then (a real report: "the FPS number is not accurate while sliding"). The FPS cap is again the worked
  example: the drag handler maps the slider's top to 0, sanitises it with the SAME rule the command
  applies (`sanitizeFrameCap`), sends it, and hands the same number to `renderCap(cap)`; the
  parameterless call (panel open, language switch) reads the resource, where it is already settled.
  `check:ecs` asserts the hand-off.
- **A widget's text is an i18n KEY, not a sentence** (`UI_TEXT.key` + `raw`). The reconciler
  re-derives the string from the key every frame, so a language switch needs no listener and reaches
  even a toast that is ALREADY on screen — storing a finished `t(key)` result instead silently
  freezes that widget in the old language for as long as it is visible. Pass `raw: true` only for
  text no dictionary can hold: the F3 panel's numbers and log lines.
- **A view writes the FINAL value when it can, not a placeholder and then the real thing.** Because a
  view writes data and the reconciler paints once per frame, every intermediate state it writes is a
  painted frame. The inventory is the worked example: it asks `peekBlockIcon()` (a synchronous read of
  the icon cache) and draws the baked icon in ONE write, and only falls back to the engine's
  magenta/black checker when the bake genuinely has not happened yet. The hand-written view got away
  with `placeholder; then icon` because it wrote the DOM twice inside one task — do not copy that
  shape into a widget surface. (`host/browser/blockicons.ts` exports `clampIconSize`/`iconCacheKey` so
  the peek and the bake cannot disagree about what a cache entry is called.)

## The mouse: native capture, the CENTRE LOCK and raw buttons

There is no Pointer Lock API anywhere in the engine (P1.72 deleted even the fallback: a failed capture leaves
the mouse free, and `input.lock()` refuses outright when the raw-input listener is not running, because a
capture without deltas would hide and confine the cursor for a view that cannot turn). The cursor's rules are
`src-tauri/src/cursor_model.rs` - pure, table-tested - plus the two session layers that serve it
(`cursor_session.rs` for the pointer, `rawinput_session.rs` for the device) and the backends under
`src-tauri/src/platform/`. **That split is the port's shape (P1.79/P1.80).** The seam is
`platform/mod.rs`, and it is **three traits** - `CursorBackend`, `RawInputBackend`,
`WebviewBackend` - not prose, because a trait is what the compiler checks: implement them for your
target and the error names the method you left out. A new operating system writes ONE
`platform/<os>/mod.rs`, adds its `cfg` arm in `platform/mod.rs` and deletes the `compile_error!`;
`cursor_model.rs`, both `*_session.rs` files, `game.rs`, `lib.rs` and the whole front end stay
untouched.
- **A window handle is an OPAQUE TYPE outside the backend** (P1.82): `cursor_model::NativeWindow` -
  a private `isize`, `NativeWindow::NONE`, and `from_raw`/`raw` for backends only. So the shared
  layers pass a handle around and ask `is_none()`; they cannot see or invent the integer, and the
  Windows word for it does not appear at all. `isize` survives on exactly three lines, all inside
  that definition. Verified: outside `platform/windows/`, `hwnd` and `isize` appear ZERO times in
  non-comment code; inside it, freely (it is the real Win32 parameter there).

- **The centre lock is the mechanism** (P1.76/P1.77; copied from SDL3, which is what Minecraft uses). While we
  hold the mouse the clip handed to `ClipCursor` is a **1x1 px box on the crosshair** (5x1 over a remote
  desktop - SDL's `remote_desktop_adjustment`), and Windows then refuses to move the pointer at all:
  `SDL_HINT_MOUSE_RELATIVE_MODE_CENTER` is on by default (`SDL_windowswindow.c:397-403`, used at `:1598-1632`).
  - It **inverts P1.63's invariant** ("the rect handed to `ClipCursor` always contains the pointer"): the box
    deliberately does not contain it, and clamping it in *is* the mechanism. What that invariant protected is
    covered elsewhere: the whole window session releases the clip (`CLIP_POSTPONED` + `win-session`, and the
    front end pauses) - SDL's own `postpone_clipcursor` - and a capture request while the user holds the frame
    is refused before it gets that far.
  - Because the pointer is on the crosshair at every instant, **there is nothing left to "centre"**. The whole
    P1.70-P1.75 family (warp on every hand-back, the centre debt, paying it at an "invisible moment", settling
    it by measurement, "Win+L does not centre", "Win+; does not centre") is obsolete, and `hand_back_warp` is a
    permanent no-op kept as a safety net. **Do not reintroduce a "where is the cursor" rule**: with the lock
    there is no such variable.
- **The view comes from raw input** (`platform/windows/rawinput.rs`: a hidden `HWND_MESSAGE` window + `RIDEV_INPUTSINK` +
  `WM_INPUT`), which is why the pointer's position is irrelevant and why holding it against a window edge does
  not freeze the view.
- **The buttons come from raw input too** (P1.76): the same packet's `usButtonFlags` -> two bitmasks -> the
  `raw-buttons` event -> `input.rawButtons`, exactly as SDL does it (`SDL_windowsevents.c:556-573`, `:690-732`).
  That is what keeps break/place working while a shell overlay (Win+;, the IME candidate window) owns the click
  - a DOM `mousedown` never happens there. **Ownership is explicit: raw while captured, DOM while the cursor is
  free** (both sides gated, so one click is never counted twice), and `releaseCapture()` clears the held MOUSE
  binds so a press whose release lands in another window cannot stick across a pause. The wheel sits in the same
  union and is deliberately unread: nothing consumes a wheel event yet.
- **An overlay that keeps showing a cursor** (`lost_fight_ticks`, ~250 ms) makes us stop pushing the shape but
  **keep the capture**: the game does not pause, the view keeps turning, and the overlay's own cursor sits still
  on the crosshair until it closes (P1.75). Nothing hands the mouse back on that path any more.
- **Windows' own behaviour after a lock screen is left alone** (P1.78): after a Win+L unlock the system reports
  `showing=false hCursor=<arrow>` until real mouse input arrives, and we no longer force it - `SendInput` is not
  used anywhere (the injected repair of P1.73 is deleted, and the gate pins its absence). The repaint helpers
  that predate it (`refresh_cursor`, `kick_cursor_repaint`) stay: the P1.73 boot.log proves they do not change
  visibility (1.5 s of `showing=false` with both of them running).
- **Foreground is a MEASURED fact**: `ClipCursor` does not care who is in front while raw input arrives in the
  background, so "capture only while foreground" is explicit - the front end's `focused` gate, the entry driver's
  refusal, and `cursor_session::capture_foreground_check` as the system-level backstop that releases and emits
  `capture-lost`.
- **The launch arguments belong to the WINDOW HOST, and they live in exactly ONE place** (P1.80/P1.81):
  WebView2 reads `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` before the webview exists, and a non-empty value
  REPLACES whatever the host was configured with (wry's default included) - so `game.rs` publishes
  `platform::browser_args_base()` **unconditionally** and the host owns the complete list. `tauri.conf.json`
  no longer carries `additionalBrowserArgs` at all: it used to be a second copy, and the copies had drifted
  (the config had `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`, the host's list did not,
  so switching vsync off silently re-enabled those three components).
  **Since P1.90 NOTHING is appended**: the host publishes its BASE list and the WebView runs on Chromium's own
  defaults — the frame-rate limit pins rAF to the display refresh and the present waits for vertical blank,
  which is `vsync on` and the smoothest this stack can do. Two experiments were tried and taken back out
  (`--disable-frame-rate-limit` P1.86/P1.89: it made the callback supply elastic, so the in-game cap stopped
  being honoured between ~60 and ~200 and the whole ui lane ran once per drawn frame; `--disable-gpu-vsync`
  P1.89: a real immediate present, but it charged the synced mode 21-30ms worst frames). Nothing the user can
  switch may be a launch argument anyway, because a launch argument can only apply at the next launch.
- **NEVER move a window flag into `tauri.windows.conf.json`** (learned the hard way, P1.80): the platform
  overlay is merged with `json_patch::merge` (RFC 7386) - objects merge recursively, **arrays are REPLACED
  wholesale** - so a partial `app.windows: [{ label, ... }]` entry silently drops `center`, the size,
  `visible: false` and `title`, and the window stops being centred. Overlaying a window means repeating
  the whole object. Non-array keys (a future `bundle.targets`) are safe.

## Building: one command per platform

`npm run app:windows` and `npm run app:android` are the whole build, each ending in a distribution
directory that mirrors the other:

| | desktop | android |
|---|---|---|
| command | `npm run app:windows` | `npm run app:android` |
| script | `scripts/build-windows.mjs` | `scripts/build-android.mjs` |
| step 1 | the frontend gate (`build-all.mjs`) | same |
| step 2 | `cargo build --release --features custom-protocol` | cross-compile with the NDK |
| step 3 | `package-portable.mjs` | `gradlew assemble<Flavor><Type>` |
| output | `release\VoxelEngineTauri\` | `release\VoxelEngineTauri-android\` |

**Step 1 is in both chains on purpose.** `tauri-codegen` embeds `dist\` with `include_bytes!`, so cargo
does rebuild when those files change - but only once they HAVE changed: a chain that skips the
frontend step compiles the PREVIOUS frontend into the exe or the `.so` and nothing downstream notices.
(`tauri build` gets it for free from `beforeBuildCommand`; a bare `cargo build` does not, and the
Android chain only did it as a side effect of generating the Gradle glue.) Both scripts share
`scripts/run.mjs`, which owns that step.

The Android script also patches the generated project, cross-compiles with the NDK, copies the `.so`
into `jniLibs`, runs Gradle and publishes the APK. It is idempotent and every anchor it patches is
checked.

Two facts worth remembering, because both cost an afternoon to find:
- `src-tauri/gen/` is git-ignored, and **`tauri android init` does NOT generate the whole project**:
  `tauri.settings.gradle`, `app/tauri.build.gradle.kts`, `app/tauri.properties` and ten Kotlin files
  under `app/src/main/java/.../generated/` are written by a BUILD. After a fresh clone: init once, then
  run the script (it asks the CLI for the glue itself).
- `tauri android build` places the `.so` with a **symbolic link**, which Windows refuses without
  Developer Mode ("Creation symbolic link is not allowed for this system"). The script copies the file
  instead and removes the Gradle dependency on the CLI task, so no machine-wide setting is needed.

The port itself needed ONE new file (`src/platform/android/mod.rs`) plus a `cfg` arm: Android has no
system cursor to capture and no raw-input device, so nearly every trait method is empty - and NOTHING in
`cursor_model.rs`, either `*_session.rs`, `game.rs` or `src/` changed for it. That is the seam paying
off.

## Testing

There is no test runner: `node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` (strict,
zero errors) plus a MANUAL flythrough. **The click-by-click checklist — the startup screen and the
settings check, the world, the movement modes, every menu, the key binds, the inventory — is in
`docs/TESTING.md`**, together with what a failure at each step means. Read it before saying a change
works, and extend it when a behaviour lands.

**`npm run check:ecs` is the automated gate for the ECS** (`scripts/check-ecs.mjs`, 74
assertion groups, ends with `RESULT: OK` / `RESULT: FAILED`). It compiles the ECS plus the fixed lane
with the same `tsc` the build uses into `node_modules/.cache/voxelengine-ecs-check` (git-ignored, so
it writes nothing tracked; Node still resolves the real `three`), then asserts what no type-checker
can:

- **the core** — stale handles and slot recycling, a recycled row starting zeroed, record identity,
  query-cache invalidation, the one-World rule, command deferral and clamping;
- **the entities and the fixed lane** — the player's component set and spawn defaults, the starting
  items, SelectSlot/SwapSlots/Teleport/SetMode, an NPC landing with its PREV_POSITION tracking it, a
  bounded sweep cost, an entity with no PREV_POSITION skipped rather than swept from a bogus origin,
  and the COMMUTATIVITY of the snapshot/controller pair (a 400-tick trajectory identical in either
  registration order);
- **the widget layer** — the theme is the ONLY file with a colour literal, every recipe resolves to a
  style (a role missing from the table would ship "undefined" into cssText), the prefabs build the
  tree the reconciler expects, no migrated surface builds an element or writes a style string or uses
  `display` as its own state (the drag rubber band is the one named exception), the icon cache's
  synchronous peek building the same key as the bake, and a bound widget taking its value from its
  source on its own grid and range (a slider's min/max/step must reach the ELEMENT). The RECONCILER's
  half of that group runs it against a stub DOM and proves the DELEGATION: no widget element carries a
  listener of its own, the mount root owns one per type, a click on a child label reaches the button, a
  slider click dispatches nothing (it reports through `input`), the ancestor-chain diff shades a parent
  when a child is entered and clears it when the pointer leaves the tree, a press ends on any `mouseup`
  inside it, and `ev.detail === 0` (TAB+ENTER/SPACE, `.click()`) is dropped;
- **the systems as systems** — a deferred `SetLoadingStage` moving LOADING_STATE and `ui.loading` painting it
  (the stage line as a re-derivable key, the percentage raw, one `active` boolean per bar segment —
  asserted at 0% and 50% — and the settings note as a translated label over literal names); the startup
  ACTIVATING the screen and revealing the window after that paint and before `renderer.init()`; the
  startup building NO world while the entry builds, primes and warms one (a re-entry into a warm window
  skips the screen — `needsWarmUp`, driven on a stub voxel); the GAMEPLAY gate (the crosshair and the
  hotbar hidden outside a world, the F3 panel and the mode chord refused there, the toast left alone);
  the pause menu and the backpack refused while no world runs; `diffSettings` repairing a bad cap, a wrong type, a domain miss and one keybind
  ENTRY while keeping unknown keys and treating an absent one as a first run; the F3+F4 picker; the
  toast (a wall-clock deadline, a key vs a value); the bind panels being DERIVED (two instances cannot
  desync); the ESC ladder one rung at a time; the input system's handlers only QUEUE-ing while
  `step()` writes; the TAB swallow being a CANCEL (`preventDefault` with the key still delivered, so a
  Tab bind works) and the same line proving the capture only cancels it while the mouse is captured; a
  DELAYED INTENT being data with a wall-clock deadline (due in deadline order, not early, capped, and the
  three files that used to own a `setTimeout` now owning none); the diagnostic-probe switch (one filter in
  `logDebug`, the error channel unfiltered, the prefix table, the panel's two states, the label translated
  in all three dictionaries); and the loop state (one mode, one transition, one rAF, no cancel, a body per
  mode, `load` included);
- **the declarations** — rebuilt from `main.ts`'s own registrations plus each `*_ACCESS` constant: the
  batch grouping of all three lanes (the report above), a declared order holding in either registration
  order, every `dom.*` writer in the ui lane,
  `renderUi()` running the barrier + the ui lane and NOTHING else, the undeclared-dependency error,
  and diagnostics declaring every external target it really touches;
- **the layer directions, COUNTED** (P1.18b/P1.18d) — every `import` in `src/core/` and `src/data/` is
  RESOLVED to its file and classified: `plugins/ -> host/` 0, `core/ -> plugins/` 0, `core/ -> data/` 0 at
  runtime (6 type-only, pinned), `data/ -> plugins|host` 0 at runtime (1 type-only, pinned). A probe that
  adds a runtime data import to a core file turns the gate red, which is how the rule was shown to bite;
- **the presentation state** — that the objects the world owns are RESOURCES, that the composition root
  inserts every one of them, that no system takes one as an argument any more, and that the LAST
  module-level state went the same way: the icon baker's renderer and caches (ICON_BAKE — and the
  inventory reading the bake's result from the cache instead of writing a widget from a `.then`
  continuation), the shared chunk material (CHUNK_MATERIAL), the raw-input transport counters
  (`InputDiagnostics.raw`) and the LOOK counters (`InputDiagnostics.look`, with `player.input` keeping
  no private copy), the UI mount root (`createUiMount()`, no longer a stage div built at IMPORT time by
  `data/globals/uiscale.ts`), the widget tree's creation counter (UI_ORDER, inserted before the first spawn) and
  the block-outline mesh (BLOCK_OUTLINE + `block.outline`, with the fixed lane mentioning no wireframe
  at all and writing TARGET_HIT instead).

Run it after touching the ECS, a component, a command, a resource, a recipe, a stage or any system's
access declaration. Some checks read SOURCE TEXT, so they strip comments first: a comment that
documents what a migration removed must not fail the migration.

For one-off experiments, `logic/engine/` is pure logic (no three.js, no DOM) and can be verified
standalone. The recipe that works in this repo — TS 7 needs `--ignoreConfig`, and the emitted
CommonJS needs a `{"type":"commonjs"}` package.json in its output directory because the repo root is
`"type":"module"`:

```
node ./node_modules/typescript/bin/tsc src/core/data/entity.ts src/core/data/component.ts \
  src/core/data/query.ts src/core/data/store.ts src/core/flow/schedule.ts \
  src/core/data/resource.ts src/core/world.ts --ignoreConfig --outDir .tmp/ecstest --rootDir src \
  --module commonjs --target es2022 --strict --skipLibCheck --types node \
  --lib es2022,dom,dom.iterable
```

then `require()` the output from a throwaway `.cjs` and assert. Delete `.tmp` when done. Keep `.tmp`
OUTSIDE `node_modules` and inside the repo, or `require("three/webgpu")` will not resolve.

That trick reaches further than `logic/engine/`: `components/Player.ts`, `commands.ts`,
`systems/snapshot.ts`, `systems/collision.ts` and `data/world/world.ts` also import no three.js, and the
VOXEL resource is only ever used through `isSolid()`. So the whole fixed lane can be REPLAYED in
Node — register the snapshot + collision systems on a real `VoxelWorld`, integrate a fake gravity
step between them, and assert where an entity lands. Wrapping the voxel in an object that counts
`isSolid()` calls turns "the sweep origin went stale" into a number, which is how the
local-player-only snapshot bug was pinned down.

## Pending work

Not here: the roadmap, the gaps, the deferred decisions and the debt backlog are in **ROADMAP.md**.
When work lands, move the entry here and delete it there.

## Known gaps (do not "fix" without asking)

- The voxel world HAS noise terrain now (P1.92) and the terrain is the ONE thing that is still thin: the
  height field (`data/world/terrain.ts`) is a single fBm with one seed, so there are no BIOMES, no ORES, no
  CAVES, no water and no trees/structures, and a `data/world/world.ts` column is grass over a 3-layer dirt
  band over stone everywhere. Everything else about block content WORKS: a voxel value is a palette
  index derived from the block registry (P1.46/P1.47), placement writes the palette value of the block in
  hand, and the mesher resolves each (value, face kind) through the block definition — texture, else flat
  colour, else the engine's checker. A mod's block therefore places AND draws. What is missing is the
  DECORATION/generation variety (and face kinds beyond top/bottom/side), not the plumbing: a new layer is a
  branch inside `generateChunk` plus a value in the palette, and a new landform is a term in `terrainHeight`.
- Chunk data is never evicted: the map can hold up to WORLD_CHUNKS_X * WORLD_CHUNKS_Z *
  CHUNK_Y_COUNT = 32 * 32 * 8 = 8192 chunks. A uniform chunk allocates NO array at all (see
  data/world/chunk.ts) and the terrain is BOUNDED, so only the chunks the surface actually crosses
  materialise — measured on the spawn window: 465 of 2312 chunks, 14.5 MB — but raising the period, or
  giving the field a bigger amplitude, needs eviction first.
- The scene has NO fog, so the rim of the streamed chunk window is visible as the edge of the
  world. Raise RENDER_RADIUS_CHUNKS (plugins/render/systems/chunk-stream.ts) to push it out, or reintroduce a
  `scene.fog` — those two values were previously tuned as a pair.
- `input.ts` still carries `const top = NaN; // ... (was groundTop())` in its SPACE log. That is
  display-only and deliberately untouched (rule 3 territory); the real surface height is
  `VoxelWorld.topSolidY()`, used by plugins/render/systems/diagnostics.ts and the F3 panel.
- The torus is drawn by placing each chunk at its nearest representation. The TERRAIN is periodic on that
  same lap (`terrain.ts` wraps every octave's lattice), so the seam has no cliff in the data — but a chunk
  that straddles the seam still needs its ghost mesh, and there is none: the wrap can therefore show a
  one-block mismatch (and no faces culled across the lap) until ghost meshes land.
- Inert remnants of the removed engine — dead code and stale comments, NOT bugs; do not
  "restore" or "fix" them: the main menu's world-type panel (`mainmenu.ts` gen panel plus the
  i18n keys main.genTitle/genSuperflat/genNoise; main.ts's `onStartSingle` logs `mode` and then
  discards it), and comments mentioning BlockWorld or the REMOVED chunk system (the new chunk
  system in data/world/ is unrelated). The hand-built loading overlay that used to sit here is GONE: it was
  replaced by the loading screen (`ui/loading.ts` + `LOADING_STATE`), and a world-entry preload belongs in
  that resource, not in an element built by the composition root.
- `plugins/ui/views/menu.ts` was rewritten around an explicit binding-interaction state machine (click
  shield + capture-free drag + physical capture, all documented at the top of the file).
  Still the densest file — the two shield-arm paths and the Esc-during-drag branch are
  load-bearing click-synthesis handling. Do not merge the arm paths. The GESTURE'S STATE is
  `KEYBIND_GESTURE` data now and the panels are derived by `ui.keybind`, so what is left here is the
  event-time half (which listener fires, when the shield arms) — and NOTHING ELSE: the rubber band is a
  widget whose geometry `ui.keybind` writes, and the pointer position comes from the `POINTER` resource,
  so this file creates no element and listens for no mousemove.
- **The low-level keyboard hook is for the CONTEXT-MENU gestures only.** `platform/windows/rawinput.rs::menu_hook` swallows the
  menu/Apps key and Shift+F10, and only while our window is the foreground: Windows answers those gestures by
  entering menu mode and switching the cursor to an arrow, which no page-side `preventDefault` can cancel. The
  ESC half is GONE (P1.72) - it existed only because the browser's pointer lock treats ESC as its default unlock
  gesture, and this engine no longer uses pointer lock at all (see the mouse section above). The hook **fails
  open** (no handle -> nothing is swallowed), and whether it works is always visible: `MENU HOOK installed /
  NOT installed` once at startup, `HOOKPROBE seen=…` 4/8/12 s in, and the RAWMON `hookSeen=` counter - so
  "installed but ineffective" can never be confused with "never installed".
- **The menu/Apps key's one-frame cursor flash is a RACE we win, not a call we cancel.** Chromium treats that
  key (and Shift+F10) as "show a context menu" and REVEALS the system cursor for it; the reveal happens
  outside the page (WebView2/Windows), so `preventDefault` cannot stop it. `host/browser/window-guards.ts`
  therefore cancels the gesture on BOTH `keydown` and `keyup` and then RE-ASSERTS the hidden cursor
  immediately (plus rAF and 0/32/80 ms), so the momentary reveal is never painted; the Rust cursor sentinel
  polls every tick (≈4 ms) as the net. WebView2's own context menus are disabled and the window procedure
  swallows `WM_CONTEXTMENU`/`SC_MOUSEMENU`, but neither of those stops the reveal — the menu is not what
  shows the cursor, so do not "simplify" the re-assert loop away.
- The UI is migrated; what is NOT: (1) the EVENT-TIME HALF of the bind gesture — the click shield's two
  ARM PATHS, the drag's mousedown/mouseup, the wheel block and the key-capture handler. Those decisions can
  only be taken INSIDE the event that must be cancelled (the shield must be armed before the synthetic
  click that follows mouseup), so they are device-layer code, not state; the rubber band they draw is a
  widget now.
  (2) the CONFIG modules own the FILES while the VALUE (language, font id, scale mode, bind table) is the
  LOCALE / FONT / UI_SCALE / KEYMAP resource, and the background kind is a memoised query of the pack
  chain. They no longer APPLY anything themselves: `fonts`/`uiscale` publish the font css pair and the
  root font size and the RECONCILER writes them to the document root, diffed, once per frame — which is
  also why the resize callback that used to re-run the root font size is gone. (3) The EVENT-TIME half of
  the bind gesture has no ECS
  shape and should not get one: which listener fires, when the one-shot click shield arms, and the two
  one-shot wiring flags are click-synthesis timing. Its STATE (chip, keycap, shield bit, live pointer)
  is `KEYBIND_GESTURE`, and the panel NAVIGATION is `UI_MODAL` painted by `ui.navigation`.
- The theme's global stylesheet is addressed by `data-ui-recipe` (the reconciler stamps it on every
  widget). That covers what an inline style cannot express — the chip scrollbar, the marquee
  keyframes — but it also means a recipe can have pseudo-element styling, so keep new rules there
  rather than inventing a class name per surface.
- Widget text is only written on LEAF widgets: a text write replaces an element's children, so the
  reconciler refuses to write text on a widget that has any. A container that needs text AND children
  needs a child label (which is what the keycaps do).
- **A widget that will be filled LATER must be spawned WITH a text.** `spawnButton(..., text?)` attaches
  `UI_TEXT` only when it is given one, and `setUiText` on a widget without that component returns without
  doing anything — so a pool/list row spawned with `undefined` is permanently EMPTY, it is still visible and
  clickable, and the writer that was supposed to fill it fails in silence (shipped once as "the three
  language rows show no text", P1.49ag). An EMPTY key is enough to own the component. The other way out is
  the pack columns': the row carries a CHILD label (`spawnLabel`, which has its own `UI_TEXT`) because a
  pack NAME is not an i18n key. `check:ecs` pins both halves of the trap on a real widget World.
- **A row that OFFERS a language is read IN that language** (`tIn`), not in the one in force: "Francais",
  never "French in English". Through `t()` a language a pack just added shows up as the raw key `lang.fr`,
  because no dictionary but the new language's own holds a name for it — and that is the one the user cannot
  read yet. Written as RAW text, since the string does not depend on the language in force.
- Multiplayer is a placeholder button.
