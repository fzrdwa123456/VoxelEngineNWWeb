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

**Current world state: a NOISE-TERRAIN, EDITABLE voxel world exists, streamed as a LADDER of LOD rungs
(P1.92/P1.93/P2.03).**
`src/data/world/` is a chunk system (32³ chunks) generated from a height field: `data/world/terrain.ts`
answers the first air layer of every column (value noise, 4 octaves, exactly periodic on the torus), and
`generateChunk()` in `data/world/world.ts` writes grass over a dirt band over stone into that column. The
streamed window is a **FINE ring** of real chunks (rung 1: 8×8 columns, 256 blocks) plus **up to five coarser
rungs** drawn from the same field (`data/world/lod.ts`, 2×2 up to 32×32 blocks per super voxel) — how many fit
is the TORUS LAP's business, and the biggest world-size preset (16384 blocks) holds all six, reaching 7168
blocks. See the LOD bullet in the streaming section below.
`plugins/player/systems/collision.ts` resolves the player AABB against
the fine world (you land, walk, jump, climb hills) and `plugins/player/systems/interaction.ts` breaks and
places blocks with the mouse.
Topology is unchanged and deliberate: **X/Z is a TORUS** (the lap is the world-size setting — 1024 blocks by
default) and **Y is bounded** (`[WORLD_MIN_Y, WORLD_MAX_Y)` = 256 blocks); below
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
│                            decides how high the ground is), lod.ts (THE FAR RING: samples that field at
│                            2×2 per super voxel, conservative so a coarse chunk can never hole the fine
│                            one, plus the ring policy), palette.ts (value -> block id),
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
SCHEDULE render: 7 systems, 2 batches, 11 parallel pair(s) [(diagnostics ~ cameraView.render ~ chunk.stream ~ block.outline ~ lod.gpu.probe) | (lod.gpu.sample ~ renderer.draw)]
SCHEDULE ui: 11 systems + 4 gap(s), 13 batches, 3 parallel pair(s) [(ui.pages ~ ui.hud ~ ui.bindings) | ui.loading | ui.slot.bag* | ui.inventory | ui.slot.debug* | ui.picker | ui.slot.toast* | ui.toast | ui.slot.keybind* | ui.keybind | ui.navigation | ui.delays | ui.widgets]
```

Reading those reports: the fixed lane's batch 0 is a REAL read-after-write (`player.input` writes
the VIEW/keys the three systems after it consume), and its edge to `motion.snapshot` is a declared
PESSIMISATION kept so the tick still drains first. `renderer.draw` must follow its two producers
(`cameraView.render` writes the camera, `chunk.stream` the meshes) — while `block.outline` joins the
producers' batch because it touches neither: it reads the TARGET_HIT COMPONENT and writes a target of
its own, so any position among them is correct — the mesh is only read by the draw at the end of the
lane, by which point the batch is done. `lod.gpu.sample` (M1) READS the far key set `chunk.stream` publishes (its
work list), so the conflict rule forces it into the batch AFTER that one — and nothing orders it against the draw
(it fills its own buffers, which the draw never reads), so the two share that batch in either order. The
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
* **A CHAIN CHANGE REACHES EVERY MESH IN THE CACHE — BOTH SOURCES (P1.97).** The reload's stale queue is filled
  by `VoxelWorld.markAllStale()`, i.e. from the world's chunk map. That is only ONE of the two kinds of mesh in
  `CHUNK_MESHES`: the FAR RING is procedural and holds no chunk in that map (P1.93), so it was never named, and
  every already-loaded far chunk kept the previous chain's materials — only a far chunk that happened to be
  built or rebuilt picked up the new textures. The driver therefore calls `markChainStale()`, which marks the
  world's chunks AND `chunkStream.markFarStale()`; `ChunkStreamSystem.restyleNext` drains both queues under the
  one budget, `restylePending` is the count for the reload bar, and `RenderHandles.chunkStream` publishes both.
  The invariant to keep: **the reload's set is "everything in the CHUNK_MESHES cache", not "everything the world
  holds"** — ANY new source of chunk meshes has to be marked here too, and the gate asserts that after a chain
  change every entry in that cache has been re-resolved exactly once.
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
* **THE WINDOW IS A LADDER OF RUNGS (P1.93/P2.03 — `data/world/lod.ts`).** The inner rung is real 32³ chunks as
  before; each rung outside it is twice as coarse — a 32³ array of `step × step × 1` super voxels that goes
  through the very same `meshChunk` (the placement scales the mesh by `(step, 1, step)`, and nothing in
  `mesh.ts` changed). Rung L has `step = 2^(L-1)`, its own cells are `32·step` blocks across, its ANNULUS is
  `policy.reach` of those cells wide, and its HOLE — what it only BUILDS and keeps hidden — is exactly the
  coverage of everything inside it, so the radii grow with the ladder (the shipped `reach` 4 gives 128, 384,
  896, 1792, 3584 and 7168 blocks). Three properties make it work, and each is a thing to keep:
  * **CONSERVATIVE, SO CRACKS ARE IMPOSSIBLE.** Every super voxel takes the MAXIMUM height of the fine columns
    it covers, so the coarse surface is never below the fine one and a crack (a solid fine block with an air
    coarse voxel over it) is impossible. The gate asserts exactly that, pointwise, against the real generator —
    it is the one property that must not regress.
  * **TWO GRIDS, AND THE SIDES USE THE `min` ONE (P1.95 — measured bug, one block big).** The sampler builds
    both the MAXIMUM and the MINIMUM height of the covered `step × step` fine columns. The BODY and the ±Y
    planes take `max` (the vertical neighbour is always the same level, because the rings are split by COLUMN,
    so max is EXACT there). The ±X/±Z planes take `min`, because the neighbour on those sides may be the FINE
    ring, whose surface is per BLOCK: a `step × step`-wide quad culled with `max` loses its wall wherever the
    terrain steps INSIDE the cell, and the lower fine block has no geometry either — you look into the terrain
    through a hole at most one block across (measured: 16 such cells over three boundary walls). Culling with
    `min` (only when the WHOLE covered area is solid) closes them for +1.0% far-ring faces, and the extra walls
    are hidden behind the neighbour's own body. The gate checks it PER BLOCK — an earlier version of that check
    ORed the two z blocks of the cell together and hid exactly this case.
  * **PROCEDURAL AND POOL-FREE**: a far chunk samples `terrainHeight` (one (S+2)² grid, memoised per column
    because a column's 8 chunks stream back to back), so it reads NO world chunk, generates nothing into the
    world's map, and never goes to a worker. Its cost is spent from a COST-WEIGHTED per-frame budget
    (`LOD_BUDGET_PER_FRAME` units, a materialised chunk = `LOD_MESH_COST`), measured at 0.33 ms for a uniform
    far chunk and 3.0 ms for one that builds a mesh.
  * **ITS PRICE**: a far chunk is procedural, so a block edited out in the far ring is not reflected there
    (it is correct wherever the player can actually reach, because the fine ring owns that). That is why no
    edit is ever routed into a far key — the two rings' keys cannot even collide (`"<step>:cx,cy,cz"`).
  THE RUNGS TILE, AND THAT IS NOW A RANGE PROBLEM, NOT A RADIUS ONE (P2.03). Every rung's cells are aligned to
  the WORLD (a coarse cell must not move as the player walks, or the far terrain would crawl), while the range
  that covers the window is measured from the window's own centre — so a rung whose centre is off its own grid
  has asymmetric, RECTANGULAR ends. `LodTier` therefore carries a `LodSpan` per axis (`lo`, `hi`, and the
  `holeLo`/`holeHi` inside it) rather than a radius. **AND THE RUNGS CROP EACH OTHER**: a coarse cell that is
  only half covered by the finer coverage cannot be owned by both — a gap is a see-through hole and an overlap
  is z-fighting — so the rung inside gives the cell up, which is why a rung's annulus can end up one cell
  thinner than `reach`. The gate's tiling sweep (several policies, both axes on different alignments) is what
  caught the symmetric version leaving a 64-block gap and a z-fighting strip at every boundary above step 2.
  **AND IT MUST BE ANCHORED** (P1.94 — measured bug): the window is built around
  `fineBase(policy, playerColumn)`, i.e. the player's column rounded down to the second rung's grid, not around
  the player's own column; `fineBase(null, pc) === pc`, so the no-LOD path is untouched, and the gate tiles
  every parity.
  * **THE DRAWN RUNG IS NOT THE BUILT RUNG (P2.00 — the seam), AT EVERY RUNG.** Tiling is what makes the rungs
    meet, and it is also what made the seam POP: a cell leaving the finer rung was a BRAND NEW coarse cell, so
    there was nothing behind the finer mesh while the far budget caught up — a flash of sky, and the appearance
    fades (P1.98/P1.99) only shortened it. The fix is the READY RESERVE: every rung BUILDS its hole (the whole
    area the rungs inside it cover) but DRAWS one of those cells only while the finer chunks of that cell are
    not all there yet (`refreshFarVisibility`, which also waits for their fade to END — a translucent chunk
    over nothing is the sky showing through it). Walking, the trailing cell's coarse chunk was built long before
    (it spent the whole width of the finer rung in the reserve) and is drawn in the same step the finer chunks
    leave; the leading cell keeps its coarse chunk up until the finer ones that replace it are opaque. **This is
    the shape all three reference implementations have**: Voxy mips every section up four levels and only draws
    the level its children do not cover, Cubyz draws a parent node until all 8 of its children are meshed,
    Distant Horizons keeps the LOD image under the vanilla one and blends the two by DISTANCE in a post-process
    pass (and disables MC's own per-chunk fade-in, "to prevent vanilla chunks from flashing on the Distant
    Horizons border"). None of them fades a chunk in or out at that boundary. The reserve is invisible, so it
    costs no draw calls; it costs the far budget the extra builds (each rung's hole is the whole inner coverage)
    and it is built AFTER the drawn annulus, so entering a world looks exactly as before.
  * **A COARSE CELL'S CHILDREN ARE FOUND IN THE FINER RUNG'S OWN SPACE** (`finerCells`): the cells `2·cc` and
    `2·cc + 1`, wrapped by the FINER rung's period. Wrapping by the fine period (which the two-rung version
    could get away with, because its only coarse rung had the fine chunks as children) left a rung's children
    unmatchable at the torus seam — a rung-3 reserve stayed drawn for ever one cell outside the wrap, which is
    exactly what the gate's last handover assertion found.
* **THE TORUS LAP IS A SETTING (P2.02 — `data/world/size.ts`).** X/Z wraps, and how far you walk before the world
  repeats was a hard-coded 32 chunks = 1024 blocks. It is a choice now, because it is the number that bounds a
  distance LOD: a rung at radius R is unambiguous only while `R ≤ lap/2` — past that its far edge starts showing
  the terrain that is closer the OTHER way round (the same hill twice on screen). 1024 blocks therefore caps this
  engine at two rungs, while the six a "planet-like" world wants need 16384. So:
  * the value lives in `size.ts` — a leaf module `world.ts` and `terrain.ts` both import (`world.ts` imports
    `terrain.ts`, so a value in either could not be shared without a cycle) — and EVERY reader asks it:
    `wrapChunkX/Z`, `terrainPeriod()` (the field must repeat exactly on the lap or the seam is a cliff), the LOD
    sampler's `wrapBlock` and the chunk stream's `nearestWrap`. A hard-coded 32 anywhere would silently disagree.
  * **A LEGAL SIZE IS A MULTIPLE OF 16 CHUNKS (512 blocks)**, and that is not arbitrary: the terrain's coarsest
    noise octave is 512 blocks per lattice cell and every octave must DIVIDE the lap, and the rungs are powers
    of two so the wrap has to land on a cell grid both can align to. `sanitizeWorldChunks` clamps into
    `[32, 512]` (1024–16384 blocks) and snaps onto that grid; `lodTierFits` is the rule that refuses a rung too
    wide for the lap in force (`(hole + 2·reach + 1)·step ≤ lap`, the extra cell being the alignment wobble — a
    rung that appeared and vanished as the player walked would rebuild the outer ring every few steps).
  * **HOW MANY RUNGS A WORLD GETS IS THEREFORE A READ NUMBER**, not the policy's: the five presets hold 2, 3, 4,
    5 and 6 rungs, and the world-entry driver logs which one it built (`WORLD LOD ladder: N rung(s) …`).
  * **IT IS APPLIED BY THE WORLD-ENTRY DRIVER, AND IT RESETS EVERYTHING**: `setWorldChunks` (which answers whether
    anything moved), then `VoxelWorld.reset()` and `chunkStream.resetForNewWorld()` — a chunk key is a WRAPPED
    identity and a mesh belongs to the old lap, so nothing may survive. `wanted = null` is what makes
    `needsWarmUp` answer "yes" so the loading screen comes up for the new world instead of showing stale terrain.
    Entering a world of the same size does none of it (a re-entry stays free). The CHOICE is a resource
    (`WORLD_SIZE`) the driver reads, changed by the `SetWorldSize` command from the world-type panel (presets +
    a slider bound to the value in force), and persisted as `worldXZ`.
* **`G`, `H` AND `J` ARE THE DEBUG VIEWS (P1.94/P1.96/P1.98).** (`L` is the far ring's batching switch, `K` the GPU
  sampler probe and `M` the GPU mesher probe — each is its own bullet below.) In a world, `G` tints every chunk mesh by its
  RUNG: `LOD_TIER_TINT` has one colour per rung the shipped ladder can have (six, indexed by the rung), `H`
  switches every chunk
  mesh to three.js's TRIANGLE
  WIREFRAME (the mesher emits triangles, so what you see is the mesh's real triangle edges, not the block grid),
  and `J` switches the APPEARANCE FADE off and on (see the next bullet). All three are handled by `chunk-stream`
  itself — that system owns the meshes and their materials, and a toggle is one material swap per entry
  (`refreshMaterials`), as cheap as the reload's restyle. The keys arrive through the same `KEY_EVENTS` log every
  other global chord uses (its own `KeyEdgeReader` cursor, ONE drain for all three; `player.input` still owns the
  DOM listeners), none of the three is bound to anything else, and a held key (repeat) or the key release is
  ignored.
  **HOW THE TINT IS APPLIED DIFFERS BY LOOK, and getting it wrong once made regions BLACK** (the report: «按 G
  之后部分区域变成黑色，有时又不变色；不显示颜色就正常»). A TEXTURED look takes the rung colour as its `color`, so
  the texture keeps its own brightness and gains the hue. A COLOUR-ONLY look has no texture to carry the detail,
  and a plain `base × tint` multiplies in LINEAR space — two mid-dark colours give the PRODUCT of their
  luminances (grey stone ≈ 0.25 × a rung tint 0.1-1.0 ⇒ 0.03-0.25, hue barely readable), i.e. a near-black
  region. It now takes the rung colour's HUE and SATURATION at the BLOCK'S OWN LIGHTNESS (`tintedLook` in
  `host/browser/chunkmesh.ts`), so the region still says which rung it is at the brightness that block always
  had. The far ring made that bug look enormous for a second reason: it used to resolve its stone/dirt/grass
  values in the CONSTRUCTOR, which runs before the content plugin has numbered the palette from the pack chain
  (`RENDER meshing` at 184 ms, `PALETTE 7 block(s) numbered` at 186 ms) — so it used `FALLBACK_PALETTE`'s
  numbering, where `stone` is 3 and the real palette's 3 is `default`. It asks per build now
  (`layerValues` in chunk-stream.ts): correct for any block order a pack ships, and no value can land on
  `missing`, whose look is the engine's magenta/black checker.
  TWO PROPERTIES WORTH KEEPING: the tint is part of the material CACHE key, so a tinted world holds one extra
  material per (look, tier) and the untinted materials stay cached; and the WIREFRAME flag is applied on EVERY
  material resolution (`debugged`) rather than only on the key press, so a pack reload — which drops that cache
  and builds fresh materials — cannot silently lose the view. The two keys are independent, so a tier-coloured
  wireframe (the useful combination while checking the LOD) is just both pressed.
  **AND THE TEXTURES ARE SHARED PER URL (`CHUNK_MATERIAL.textures`), which fixed the SECOND black-region report**
  («按 G 之后出现纯黑块，有时又自己消失»). A `Texture` with no image yet is uploaded by three as a 1×1
  UNINITIALISED — black — texture, so building a fresh `TextureLoader().load(url)` per MATERIAL made every newly
  created material draw pure black until its image landed; `G` creates the whole (look × tier) batch at once, so
  whole rungs went black and then "healed themselves" when the images finished (which reads as "the LOD brushed it
  away"). One texture per resolved URL, cached in the resource, means a tinted material reuses the image that was
  loaded when the chunk first appeared — no window at all, and one GPU copy of a PNG instead of one per tier.
  `textureFor` is the ONLY caller of `TextureLoader` in the tree and the gate asserts that.
  MEASURED (this machine, P1.92 for comparison): the fine ring alone is 1568 chunks / 324 materialised /
  241k faces / 35 MB; the far ring adds 1408 chunks / 296 materialised / 245k faces / 35 MB at 0.83 ms per
  chunk, taking the visible world from ~256 to ~512 blocks for 486k faces and 70 MB in total — i.e. **twice
  the view distance for LESS geometry than the single flat-radius-8 window (629k faces / 91 MB)**. The warm-up
  still builds only the fine ring (the entry time is unchanged); the far ring streams in over the first ~3 s
  of play.
* **M1 — THE FAR RING'S HEIGHT GRIDS ARE SAMPLED ON THE GPU (`plugins/render/systems/lod-gpu-sampler.ts`,
  `lod-gpu-field.ts`).** The 71 s of main-thread sampling above is gone: the stream asks a `LodGridSource` for a
  column's max/min grids (`buildLodMeshInput`'s new optional argument), the sampler answers from a GPU batch — one
  dispatch and ONE readback per batch of same-step columns — and a column whose answer has not landed yet makes
  `buildFar` return `FAR_NOT_READY`: the chunk stays unbuilt, costs no far budget, and is retried next frame (the
  key is still in `farWanted`; `LOD_WAIT_PER_FRAME` bounds how many of those one frame walks past). The batch is a
  RUN of same-step columns because that is what lets the step be a compile-time constant — ONE cached kernel per
  (step, period), re-dispatched with only `count` changed, no per-batch pipeline. The output is ONE packed u32
  buffer whose slots are per COLUMN — its `CELLS` max cells then its `CELLS` min cells at `col * COLUMN_WORDS`,
  which keeps the half offset a compile-time constant AND makes what a batch wrote one contiguous range, so the
  readback asks for exactly those bytes (`getArrayBufferAsync(attr, null, 0, usedBytes)`) instead of the whole
  592 KB. It is RESET before each dispatch (per column, since the halves are interleaved) because the atomics
  accumulate onto what is there, and `.toAtomic()` on it is mandatory (see the probe's M1a runs: without it WGSL
  refuses the pipeline and the dispatch silently writes nothing). `BATCH_SAMPLES` is a THREAD cap first of all — 4M
  threads at 64 per workgroup is what keeps a dispatch inside `maxComputeWorkgroupsPerDimension` (65535) — and the
  gate asserts that arithmetic. **IT IS NOT SMALLER ON PURPOSE**: a batch's cost is dominated by the FIXED round
  trip (submit + GPU + copy + map — measured 16-77 ms for a 0.30M-sample batch against ~50 ms for a 4M one), so
  halving it would buy more round trips for the same work, not a smoother frame. THREE FALLBACKS, all deliberate:
  no WebGPU backend (or the Node gate, which passes no
  sampler at all) samples on this thread exactly as before; a column the sampler misses `MISS_LIMIT` times in a row
  is answered on the CPU (a bounded stall beats a hole in the ring); and a renderer that never initialises gives up
  after `ABSENT_LIMIT` frames instead of leaving the far ring waiting for ever. The sampler also SELF-CHECKS: five
  cells of the first column of every rung are recomputed with `terrainHeight` on this thread (~1.3 ms even at
  step 32) and compared with the readback, logged as `LODSAMPLE self-check step N: …`, so a wrong constant shows up
  as a number rather than as a hole. The full value-by-value check is still `K`. `debug.log` carries
  `LODSAMPLE first batch: …` and one `LODSAMPLE window: … column(s) in N batch(es), …M samples, …ms of GPU round
  trips` line per window fill.
* **THE DRAW SIDE IS MEASURED TOO (M1b).** With the sampling moved off the CPU the far ring's remaining cost is
  the SCENE: a 512-chunk lap holds ~880 columns, i.e. thousands of far chunk meshes, and the `FRAME` line (once a
  second) and the F3 panel (`f3.draw`) both carry `calls=` (draw calls in ONE frame), `callsMax=` (the window's
  worst frame), `tris=` (thousands of triangles), `renders=` (the monotonic `renderer.render(...)` count) and
  `attrs=` (the LIVE vertex-attribute count, ~3 per chunk geometry, so it tracks the mesh count), plus
  `batched=` (M3a's batched INSTANCES and their bucket count — see below) and `gpu=` (P2.07 — the GPU render
  time from the timestamp query, so one line answers "is this frame CPU-bound or GPU-bound": a `gpu=` close to
  `avg=` is GPU-bound, a `gpu=` far under a large `avg=` means the frame is waiting on the main thread). They exist to
  answer "is this frame draw-call bound" with a number: a stall reported next to `calls=1600` is a different
  problem from one next to `calls=300`. **THE PER-FRAME FIGURE IS THE RAW READING, sampled EVERY DRAWN FRAME**:
  `Renderer.info` documents `drawCalls` as "of the current frame", and the log AGREED — across a motionless minute
  `calls` stayed at exactly 1620 while `renders` kept climbing, which is a per-frame counter, not an accumulating
  one (nothing in this engine calls `info.reset()`; only `setAnimationLoop`'s own loop does, and this engine pumps
  its own rAF chain — so the first version, reading it once a second, printed impossible negative values, and a
  second "accumulated delta" reading was printed beside it for one round, proved wrong by the same log, and is
  gone). `attrs` is a live count (~3 per chunk geometry); one account lives in `FRAME_PROBE` and both readers read
  it. MEASURED (a 512-chunk lap with the full six-rung ring, 60 fps cap): `calls=1620 callsMax=1620 tris=1848k
  attrs=4576` while standing still (the frame holds the cap), and 20-27 ms frames in the stretches where the ring
  is being rebuilt — i.e. ~1525 chunk meshes at ~1.06 draw calls each, which is where the machine's limit is.
* **M3a — THE FAR RING IS DRAWN THROUGH PER-(LOOK, TIER) `BatchedMesh`ES (`plugins/render/systems/far-batches.ts`,
  integrated by `chunk-stream.ts`).** `calls=` above answers the question: a 512-chunk lap holds ~880 columns,
  i.e. ~1250 far chunk meshes, and a chunk's faces resolve to ~2 materials (its looks) ⇒ **~2521 draw calls per
  frame, peak 3785** on this machine, with the frame still inside the 60 fps cap (16.6-17.5 ms) — the far ring is
  draw-call bound, and the fix is to stop issuing one call per chunk. `FarBatches` owns ONE `THREE.BatchedMesh`
  per key `` `${look.key}\u0000${step}` `` (a BUCKET), placed at the origin with a per-instance matrix, and the
  stream hands every SETTLED far chunk to it: `add(step, geometry, specs, materials, place)` returns a
  `FarBatchHandle` the stream keeps in `batched` keyed by chunk key, `setMatrix` replaces the old `place()`
  branch (`entryMatrix` is the ONE builder of that matrix, shared with the ordinary path), `setVisible` stands in
  for `mesh.visible` (per-INSTANCE, so `refreshFarVisibility` stays a loop over the cache and only the two
  writers differ), `refreshMaterials` re-resolves a bucket's material from the same `materialFor(step, spec)` the
  meshes use (so `G`/`H` and a pack reload keep working), and `remove`/`dispose` are the way back out. `stats`
  (`{buckets, instances, batchedChunks}`) is reported by the FRAME line as `batched=instances/buckets` — the
  field to read while A/B-testing, since `calls=` alone cannot say whether the batches are the thing drawing.
  FIVE THINGS ARE LOAD-BEARING:
  * **PER-INSTANCE VISIBILITY EXISTS, PER-INSTANCE OPACITY DOES NOT.** `setVisibleAt`/`getVisibleAt` are per
    instance; the OPACITY of a `BatchedMesh` is one material, so a chunk mid-fade CANNOT be in a batch — the
    fade's whole mechanism is a per-chunk COPY of the material. The split is therefore by FADE STATE, not by
    distance: `promoteFar` is called where a chunk stops needing its own material (`beginFade` returning false —
    fades off, or the fade-in already over) and `beginFadeOut`'s caller demotes FIRST (`unloadOutside` demotes
    before deleting the key; `dropFade` promotes when the fade that ended was an OUT), and `restyle` demotes,
    restyles, promotes. `promoteFar` itself guards on `batchingEnabled`, `step <= 1` (the FINE ring stays
    ordinary meshes — it is edited and rebuilt constantly) and "already batched", and it re-checks
    `this.cache.meshes.get(key) !== entry` so a stale build result cannot batch a mesh the cache has moved past.
  * **THE VERTEX DATA IS SLICED PER LOOK (`sliceLook`).** `addGeometry` COPIES whatever it is handed, so handing
    it the chunk's full attribute arrays would store every look's vertices once per look — the slice writes only
    that look's vertex range and rebases its indices to 0, so a bucket's geometry holds exactly the faces it
    draws. Indices are consumed `FACES_PER_INDEX` = 6 per bucket instance.
  * **CAPACITY GROWS BEFORE THE ADD, NEVER AFTER — AND A GROWTH REBUILDS THE BUCKET'S MATERIAL** (`START_VERTICES`/
    `START_INDICES`/`START_INSTANCES` = 4096/6144/**512**): `BatchedMesh.addGeometry` THROWS at capacity, so
    `growFor` calls `setGeometrySize`/`setInstanceCount` first. `batch.frustumCulled = false` because the batch's
    own bounding volume is computed from the instances present when it is asked and the instances are placed and
    hidden independently — culling stays per instance, which is the whole point. **THE MATERIAL BUMP IS THE FIX
    FOR M3a'S FIRST LIVE RUN** («lod 好像被破坏了一样在闪，面到处飞；按 G 或 H 或重载资源包又恢复正常，但一动起来
    又出问题»), and the mechanism is worth knowing because it is invisible from this side of the API:
    `setInstanceCount` DISPOSES and RECREATES the batch's `_matricesTexture` and `_indirectTexture`, and the
    batching shader reads those two textures **off the mesh when the material's node graph is built**
    (`three/src/nodes/accessors/Batch.js`: `batchMesh._matricesTexture` — the graph captures the texture OBJECTS).
    The graph is rebuilt only when `material.version` changes (`RenderObjects.get()`; the pipeline cache key does
    not mention those textures at all), so after a growth the batch went on sampling the textures three had just
    freed: every instance matrix came back as garbage, i.e. surfaces flying around, flickering, worst while the
    ring fills — which is exactly when buckets grow. ANY material change recompiled the graph (that is why `G`,
    `H` and a pack reload cured it, and why `refreshMaterials` seemed to "fix" the LOD) and the next window move
    grew a bucket again and broke it again. So `growFor` decides and applies the resize first and then sets
    `bucket.material.needsUpdate = true` — for EVERY material in `bucket.materials`, not just the one in force.
    That set is the second half of this fix, and it is the answer to the follow-up report «当 G 键关闭后 lod 又会像
    被破坏了一样，但是有时候又莫名其妙恢复»: three.js keeps **one render object PER (batch, material) pair**, and
    each of them captured the batch's textures when IT was built — so a resize that marks only the material being
    drawn leaves the other one (the untinted look, the one `G` switches to) sampling freed textures, and it
    "recovers on its own" the moment something else bumps that material (`H`, a pack reload, another resize).
    INSTANCES START AT 512 on purpose (against the ~300 a lap's bucket really holds): a growth costs a
    render-object AND shader rebuild, so the capacity is bought once instead of discovered in five doublings, and
    512 instances is only ~36 KB of matrices texture plus ~2 KB of indirect per bucket (~40 buckets ⇒ ~1.5 MB).
    Vertex/index capacity is NOT pre-bought — a bucket's slices vary by rung (a step-2 slice is a whole chunk mesh)
    and their sum is only known as the ring fills. (`setGeometrySize` is safe on its own — the geometry and its
    attributes are re-read per draw, `needsGeometryUpdate` picks up the replacement, and the vertex layout is
    unchanged — but the bump is harmless there and keeps this rule in ONE place.)
  * **THE BATCH'S INDEX BUFFER IS WHAT LOOKED "SHATTERED", AND THE FIX IS A THREE.JS UPGRADE (r186).** This one is
    not in this engine's code at all: upstream three.js **issue #34211**, "WebGPURenderer: BatchedMesh draws every
    geometry after the first at half its index offset when the internal index is Uint16", fixed in r186 by
    "Fix draw offsets of `BatchedMesh` (#34212)". It needs all four pieces to line up: (1) `BatchedMesh` allocates
    its internal index as a **Uint16Array** whenever `maxVertexCount <= 65535` — every bucket here, since they
    start at 4096 vertices; (2) `onBeforeRender` caches the multi-draw offsets in **BYTES**, using
    `index.array.BYTES_PER_ELEMENT` at that moment (`geometryInfo.start * 2`); (3) the WebGPU backend's FIRST
    upload rewrites that index array to a `Uint32Array` **IN PLACE** (`WebGPUAttributeUtils.createAttribute`, plus
    the `0xffff` primitive-restart remap); (4) the backend then divided the cached bytes by the array's CURRENT
    element size — 4 — so `firstIndex` landed at HALF the intended offset. Half of an even `indexStart` is *another
    slice's* `indexStart`, so the draw read `count` indices starting in the middle of a NEIGHBOURING chunk's index
    range: stretched shards of the wrong chunk, `indexStart === 0` the only draw that was right. It is a one-frame
    artefact per attribute creation (our `perObjectFrustumCulled`/`sortObjects` defaults make `onBeforeRender`
    recompute every frame), which is why it read as "flashing + faces flying around" rather than as a permanently
    wrong ring — and why it happened exactly while the ring FILLS (a bucket's first `addGeometry`, and every
    `setGeometrySize`, build a fresh Uint16 index). **`H` "curing" it was the giveaway**: the wireframe branch
    computes `bytesPerElement` with the same `position.count > 65535 ? 4 : 2` formula on both sides, so the units
    agreed again while the wireframe was on. **This engine therefore pins `three@0.186.1`** (r186 remembers the
    element size the offsets were cached with — `_multiDrawBytesPerElement` — and `WebGPUBackend` divides by THAT),
    and the gate reads BOTH halves of that fix out of `node_modules` so a downgrade fails loudly instead of
    shipping shards. A 32-bit-index workaround was written for r185 and is now GONE, deliberately: it is upstream's
    bug to fix, and the follow-up release also carries the render-object cache fixes this file leans on
    ("Fix stale render object cache", "Monitor dispose for geometries and textures"). The gate also simulates the
    upload's in-place conversion and asserts every draw lands in the index range of the geometry the indirect
    texture names for it (alignment alone would not catch it — the half offset lands on a real slice start).
  * **THE SOURCE GEOMETRY IS KEPT SO A DEMOTE CAN PUT THE MESH BACK.** `demoteFar` re-adds `entry.mesh` to its
    group and sets `visible = true`; the chunk's own `BufferGeometry` is never disposed at promotion, so far-ring
    VERTEX memory roughly doubles while a chunk is batched (the same attributes live in the chunk geometry and in
    the bucket). The noted mitigation — dispose the source at promotion and let three re-upload it when a demote
    needs it again — is NOT done. (A SECOND cost, also not addressed: `BatchedMesh.deleteGeometry` never reclaims
    the space a removed slice reserved, so a bucket's vertex buffer only ever grows as the window moves and a pack
    reload re-adds every slice. `optimize()` is the three.js call that compacts it in place, and it is deliberately
    NOT called — a repack of a multi-megabyte bucket during streaming is worse than the space.)
  * **`L` IS THE A/B SWITCH BACK TO THE PRE-M3a PATH.** `L`, in a world, runs `demoteAllFar` (every batched chunk
    back into the scene as its own mesh) and `promoteAllFar` again, so "the far ring is missing" and "the batches
    are drawing" are one keypress apart and `calls=`/`batched=` say which one happened — which is what made the
    report above diagnosable at all. Like `G`/`H`/`J`/`K` it is unbound (`binds.ts` has no `KeyL`; the gate asserts
    it) and SESSION-ONLY. What the gate CAN test is the bookkeeping (a real `BatchedMesh` on a real
    `BufferGeometry`: instances in, matrices/visibility set, instances out, capacity growth, the slice, and the
    material bump of the section above) — never a pixel, so a regression shows up as a report, not as a failure.
* **WHICH GPU IS THIS RUNNING ON? (P2.07 — one line in `debug.log`).** Before this there was NO way to tell from the
  logs: the F3 panel shows a GPU *time*, never a GPU, and `powerPreference` is only a request. The startup's GPU
  stage (`boot/drivers/startup.ts`) now makes a second, cheap `requestAdapter({powerPreference:
  "high-performance"})` — no device is requested, nothing is kept — and logs
  `BOOT gpu adapter: vendor=… architecture=… device=… description=… fallback=… timestampQuery=…`. Chromium leaves
  `description` EMPTY (privacy), so the vendor/architecture/device triple is what identifies the card: `intel` +
  `gen-12lp` + `0x9a49` is the integrated one, `nvidia`/`amd` with an `ampere`/`rdna-3` architecture is the
  discrete one. `fallback=1` means Chromium handed over a software/fallback adapter, and `timestampQuery=0` means
  every `gpu=` number in the logs is unavailable. Paired with `--force_high_performance_gpu` (above) and Windows'
  per-app Graphics setting, this line is how "is the discrete card actually being used" is answered — the same
  question that made the pending GPU milestones look like they were not working.
* **M2 — THE CHUNK MESHER RUNS ON THE GPU, AND `M` HOLDS IT TO `meshChunk` FACE BY FACE
  (`plugins/render/systems/lod-gpu-mesher.ts`, `lod-gpu-mesher-probe.ts`, `data/world/mesh.ts`'s padded block).**
  The chunk pipeline is CPU-bound — measured: `gpu=` 2-4 ms inside a 20-30 ms frame, with 11 worker cores busy on
  the fine ring while the MAIN THREAD meshes the far ring at ~0.83 ms per chunk — and this is where meshing leaves
  the CPU. Three kernels: `census` (one thread per voxel, `atomicAdd` per emitted face), `scan` (ONE thread, 1024
  iterations: the counts' exclusive prefix sum into `starts` and each key's mutable `cursor`) and `emit` (one thread
  per key, which writes the vertices and indices).
  * **THE PAD IS WHAT MAKES THE KERNEL SIMPLE (`buildPaddedVoxels`).** Culling a face needs the SOLIDITY one step
    outside the chunk, and on the CPU that is a branch: inside → the voxel array, boundary → one of six neighbour
    planes, whose ±Z pair is TRANSFORMED on purpose (`lx * S + ly`) and whose transposition is a bug that only
    shows at a chunk border. A kernel wants one expression, so the GPU gets the resolved answer: the chunk's own
    voxels inside a ONE-CELL SOLIDITY BORDER, where every neighbour is a constant offset away (`FACES`'s `dir` in
    pad strides). The pad therefore lives NEXT TO the gatherer that lays the planes out — one home for the
    transposition — and the kernel never mentions a plane.
  * **ONE THREAD PER KEY IS HOW THE PACKED LAYOUT EXISTS AT ALL, and it is a consequence of a TSL limitation.** A
    slice has to be contiguous per look (`geometry.groups` need that), and the CPU gets that from `cursor[slot]++`.
    A parallel kernel's usual answer is an atomic fetch-add whose RETURN value is the destination — and TSL has no
    such thing: `atomicAdd` is built by `atomicFunc`, which wraps the node in `.toStack()`, so it is a STATEMENT.
    So `emit` gives each KEY its own thread and appends with a plain read/increment of that key's own cursor. Two
    properties fall out for free: the faces inside a slice come out in WALK ORDER (so the comparison against the CPU
    can be exact rather than order-insensitive) and the output is DETERMINISTIC. The cost is 1024 threads × 32³
    guarded tests, and the first guard is what makes it cheap — a key with no faces returns immediately, so a real
    chunk (a handful of non-empty looks) pays a handful of walks. The counts are read non-atomically in `scan`/`emit`
    (a different shader, so the buffer is simply bound twice in two passes): an atomic binding cannot be read as a
    value in WGSL, and `atomicLoad` is a statement too.
  * **THE WALK ORDER IS `meshChunk`'s, AND IT IS NOT THE STORAGE ORDER.** `meshChunk` nests `ly` outer, `lz` middle,
    `lx` inner while a voxel's storage index is `lx + ly*32 + lz*1024`, so a kernel's flat loop counter decodes as
    `lx = i % 32`, `lz = (i / 32) % 32`, `ly = i / 1024` — NOT the other way round. That mistake gives IDENTICAL
    per-look counts and a different face order inside every slice, so only a face-by-face comparison sees it; the
    gate caught it and now pins the decode, and the mutation test that swapped the two axes fails the comparison.
  * **THE INDICES ARE A PATTERN, NOT VALUES.** They address a face's vertices inside the chunk's own index buffer,
    and the two halves order their slices differently (first-seen vs ascending key), so the same face legitimately
    sits at a different global position in each. What must agree is the two-triangle pattern relative to the face's
    OWN first vertex, plus the corners, normals and UVs — the content. (Comparing raw values reported
    `index 0 cpu 0 vs gpu 4096` for the same face, which is what the gate's first packed run said.)
  * **`check:ecs` HOLDS THE KERNELS' LOGIC TO `meshChunk` WITH NO DEVICE**, through `packFromPad` — census + scan +
    emit in one function, deliberately a separate implementation (it walks the INPUT; the gate's comparison reads
    `meshChunk`'s OUTPUT). It checks the closed forms (a solid block in air shows 6 × 32², one with solid neighbours
    shows 0, a hole adds six), the multi-value cases FACE BY FACE, and a NON-UNIFORM BORDER — the only kind that
    proves the pad's ±Z transposition, because a uniform plane is symmetric (the mutation test that dropped the
    transposition passed until an asymmetric-border case existed, and now fails).
  * **THE MUTABLE STATE OF A KERNEL MUST BE A `Var` LOCAL, AND THAT COST A TEST ROUND TO LEARN.** The first GPU run
    reported every look's COUNT correctly and every slice's CONTENT one key late — the top slice held the bottom's
    faces, the last slice's data fell off the end — and `renderer.log` was empty, so nothing had failed to compile.
    The cause: the scan's running total and the emit kernel's per-key rank were kept in STORAGE CELLS
    (`total.element(uint(0)).assign(...)`, `cursors.element(key).assign(...)`). TSL nodes are LAZY: a value "read"
    with `const here = buffer.element(i)` is an expression, not a snapshot, so it was re-evaluated after the
    assignment and the table came out shifted by one key. Both are now `Var`s (mutable WGSL locals), the per-key
    cursor BUFFER is gone entirely, and the destination is SNAPSHOTTED into a `Var` before the rank advances — the
    writes then use the position that face owns, whatever order the compiler picks. The gate pins all three: the
    `Var`s exist, `total.element(uint(0))` appears exactly ONCE (after the loop), and no `cursorAttr`/`cursors.element`
    remains in the GPU path. **ITS SECOND RUN NARROWED IT FURTHER, and the same rule fixed the rest**: the slice table
    was then correct and every look's count right, but a FEW faces per slice carried another voxel's coordinates —
    the cull test and the write disagreed about WHICH VOXEL was being meshed, because both were counter-derived
    expressions re-evaluated at different points. The iteration's own `lx`/`ly`/`lz` **and** its pad address are now
    `Var`s too, assigned at the TOP of the loop body (as explicit statements, so they run once per iteration whatever
    three decides about where the declaration lives), and the cull test, the neighbour test and the write all read
    those locals. The gate pins the three shapes: the locals exist, they are assigned in that order at the top of the
    loop, and no raw counter expression reaches a test or a write.
  * **AND WHEN THE NUMBERS ARE RIGHT BUT THE BYTES ARE NOT, THE PROBE DUMPS THE EMITTED WGSL.** `renderer.debug.
    onNodeBuilderCreated` (r186) hands over every node builder; the probe keeps the ones carrying a `compute` node
    (the three kernels arrive in dispatch order) and, on the FIRST mismatching case, writes the emit kernel's actual
    `computeShader.code` into `debug.log` as `MESHPROBE WGSL …` lines (capped at 1400). A node graph's statement
    order cannot be read off the TypeScript that produced it — two rounds of "the counts are right and the bytes are
    not" were diagnosed from `renderer.log` being EMPTY plus the shape of the differences, and the dump is what makes
    the next one a reading rather than an inference.
  * **AND THE PROBE CHECKS THE SLICE TABLE BEFORE THE GEOMETRY (`slice table ok` / `BROKEN` in its per-case line).**
    `starts[key]` must be the prefix sum of the counts below it and the last prefix the face total — a broken table
    explains a whole class of content mismatches in one number, which the first run's log had to be
    reverse-engineered into.
  * **`M`, in a world, runs it and reports.** Synthetic patterns first (empty, uniform solid with air or solid
    neighbours, solid with one AIR voxel, a single block, three value bands, a checkerboard, a patterned border),
    each carrying a CLOSED-FORM face count so the CPU reference itself is checked too; then up to six REAL chunks
    from the player's column. One line per case, a RESULT line with the GPU-vs-CPU milliseconds, and a toast. A
    backend without compute turns it into a logged no-op, and — the M0 lesson — a WGSL/pipeline error leaves the
    accumulators at their reset value rather than rejecting the `await`, so that case is reported as its own
    verdict. The gate pins the ONE `.toAtomic()`, the derived face table, the walk decode and the closed forms; the
    WGSL itself is only verifiable by pressing `M`.
    **MEASURED on the user's machine**: `OK — 11 case(s), 121225 faces, every drawn vertex, normal and UV
    identical`, the worst case a 98304-face checkerboard, plus two real chunks; the GPU half cost 694 ms against the
    CPU's 58 ms **because of the READBACK the probe needs and the drawing side will not** (a dispatch+readback round
    trip is 20-30 ms; the first call also compiles the pipelines, ~200 ms).
  * **WHAT IS NOT DONE: the LIVE path does not use these buffers yet.** The far ring still draws through M3a's
    `BatchedMesh` buckets, fed from CPU meshes. Wiring the GPU-resident geometry into it — per-look ranges, and
    per-cell visibility because the reserve (P2.00) and the fades (P1.98/99) need it — is the step after this one,
    and it is where the flight-time frame cost should finally move.
  * **M2c STEP 1 — THE GEOMETRY IS NOW DRAWN FROM THE COMPUTE BUFFERS, on ONE real chunk, and it is ADDITIVE.** The
    drawing side is the one thing this repo cannot test (a pipeline that binds a compute-written buffer is a device
    question), so `M` now also puts a **floating copy** of one real chunk in the scene, 40 blocks above the chunk the
    CPU meshed: same column, one flat colour per face KIND (top green, sides grey, bottom brown, via one geometry
    GROUP per look slice), so the three things to verify are all visible at once — that a `BufferGeometry` whose
    attributes ARE the mesher's `StorageBufferAttribute`s renders at all, that its slices/material indices land
    right, and that its silhouette matches the terrain below it. Nothing in the live path changes; a failure leaves
    the world exactly as it is. **IT IS PLACED AT THE CHUNK'S NEAREST TORUS REPRESENTATION (`nearestWrap`), NOT AT
    ITS WRAPPED LATTICE INDEX, and that was a report**: the wrapped index is the chunk's torus IDENTITY, not where it
    is drawn, so using it as the block origin put the copy at `x = 16224` while the player stood at `x = -137` — past
    the seam `M` looked like it drew nothing at all. The chunk's NAME in the log stays wrapped (it is the real key);
    only the origin is flat, and it is what the stream itself uses (`chunk-stream`'s `placeMesh`).
  * **AND A WORLD WITH NO OVERHANGS HAS NO BOTTOM FACES AT ALL — the other half of that same report.** The
    terrain is a pure 2D height field filled from each chunk's floor up to its surface (`world.ts`'s
    `generateChunk`), so no voxel ever has AIR beneath it and kind 1 is never emitted anywhere; the copy's `keys 2`
    (two (value, kind) slices) said so in one number. Adding to the confusion: the copy's underside looks hollow
    anyway, because a lifted mesh keeps the culling the mesher did WITH its neighbours (the chunk below is solid) and
    because the material is single-sided — you must look UP at the copy to see a downward face even when one exists.
    To see brown: place a block, stack a second one on top, break the lower one, then press `M` again (`keys` becomes
    3). The probe's own synthetic cases cover it (`uniform-solid` and `one-block` both report `keys 3` and match).
  * **THREE GIVES A COMPUTE BUFFER THE USAGES A VERTEX BUFFER NEEDS — verified in r186's `WebGPUBackend` before any
    of this was written**: `createStorageAttribute` = `STORAGE | VERTEX | COPY_SRC | COPY_DST`. So the buffer the
    kernels fill is the buffer three binds — no readback, no CPU copy. **AND THE DRAWN LAYOUT IS `vec4`, NOT
    `vec3`**: `WebGPUAttributeUtils.createAttribute` pads a STORAGE attribute with `itemSize === 3` to `vec4`
    ("WGSL does not support packed vec3 data in storage buffers") and REPLACES the attribute's array with the padded
    copy before the GPU buffer exists — a kernel writing a packed layout into that buffer would desync the vertex
    layout from its data. `DRAWN_STRIDE = 4` (positions with `w = 1`, normals with `w = 0`) is therefore the mesher's
    output layout, and the probe's comparison against `meshChunk` reads the two sides with their own strides (the CPU
    mesher stays packed at three).
  * **THE GEOMETRY IS NON-INDEXED (`VERTS_PER_FACE = 6`), AND THAT IS A USAGE RULE, NOT A PREFERENCE — it was a live
    failure.** A buffer's usages are fixed when it is FIRST created and **whichever binding asks first wins**:
    `Attributes.update(attribute, type)` only creates the buffer while `data.version === undefined`, so the compute
    kernel binding a `StorageBufferAttribute` creates it as `STORAGE | VERTEX | COPY_SRC | COPY_DST`; the index
    binding arriving later gets no say. The first M2c draw then failed validation on EVERY frame — `renderer.log`
    grew to 1.78 MB with 2665 copies of `Buffer usage (CopySrc|CopyDst|Vertex|Storage) doesn't include
    BufferUsage::Index` and an invalid command buffer, which took the WHOLE world render pass down with it (not just
    the additive copy) — while the additive design promised a failure could not touch the live path.
    `createIndexAttribute` DOES add `STORAGE` to `INDEX` when a storage attribute gets there first, so the indexed
    layout is reachable with a priming draw before the first dispatch, but it depends on binding ORDER for ever;
    repeating each face's four corners into two triangles cannot hit the trap at all and costs nothing a voxel mesh
    cares about (faces share no vertices with each other anyway: 6 vertices per face instead of 4). `out.index` is
    therefore GONE — from `MesherOutput`, from the emit kernel, from `PackedGeometry` and from the probe's geometry
    (the two triangles are the shared `FACE_CORNERS` `[0,1,2,0,2,3]` on both sides, so the probe compares the CPU's
    indexed vertices THROUGH that table and never reads its index buffer).
  * **THE OUTPUT BUFFERS ARE INJECTABLE (`MesherOutput`), AND THAT IS THE SHAPE THE ROLLOUT NEEDS.** `GpuChunkMesher`
    takes the buffers the kernels write, because a capacity is baked into a storage array's length and therefore into
    the kernel: one output set = one kernel build. A per-chunk output set would mean a pipeline build per chunk
    (~200 ms), so the production rollout must share ONE set per rung and address a chunk's region with a **base
    offset** — which is why the parameter exists and why the probe (one chunk, one build) is the right first step.
  * **AND M2c STEP 2a — THE ARENA — IS LANDED: ONE KERNEL BUILD, MANY CHUNKS.** The per-chunk output set was the one
    shape that could not ship (a capacity is baked into a storage array's length, so it meant a ~200 ms pipeline
    build per chunk), so the mesher now takes a BATCH: `MESHER_SLOTS` chunks share one output set and land in it at
    offsets THEY chose. Four kernels, and the slot is **decoded from the thread id** — `slot = instanceIndex / KEYS`
    (emit) or `/ CHUNK_VOLUME` (census) — so nothing has to be re-uploaded between chunks and there is no per-dispatch
    state for three's upload timing to disagree about:
    1. `census` — dispatched over `slots * CHUNK_VOLUME`, counting each slot's keys into `counts[slot*KEYS + key]`;
    2. `scan` — ONE THREAD PER SLOT (1024 iterations each), that slot's exclusive prefix sum into its own `starts`,
       plus its total in `totals[slot]`;
    3. `bases` — ONE thread over the slots: the exclusive prefix sum of the totals, i.e. where each slot begins in the
       arena, with the grand total in the buffer's last cell (`slots + 1` cells). **This is what lets the CPU stay
       ignorant of the face counts** — the offsets are decided on the device, per batch, with no round trip;
    4. `emit` — one thread per (slot, key), writing at `bases[slot] + starts[slot][key] + rank`, i.e. ARENA-ABSOLUTE.
    `run(inputs)` returns one `PackedGeometry` per input: its own `positions`/`normals`/`uvs` SLICE (a `subarray` of
    the one arena, so nothing is copied), its `counts`/`starts` tables, and the `base` that says where the slice
    really is. `slots[].start` is relative to the slot (what `geometry.addGroup` wants); `base + start` is the
    arena offset a whole-arena draw would use. The CPU twin is ONE implementation, not two: `packFromPad` is
    `packBatchFromPad([padded], capacity)[0]`. `check:ecs` DRIVES the arena over five synthetic chunks (one of them
    empty) and asserts the three things the rollout depends on — every slot still equals `meshChunk`, the offsets are
    the running sum (no overlap, no gap, an empty slot still occupies its offset), and each slice really is the arena
    window its `base` points at (read through the shared buffer, which a per-slot comparison could not see) — plus
    that an arena one face too small THROWS rather than truncating. `M` runs the same thing on the device over up to
    `MESHER_SLOTS` real chunks, reports it as `MESHPROBE arena: …` and counts it in the verdict.
  * **AND THE ARENA'S FIRST LIVE RUN FOUND A REAL BUG THE GATE COULD NOT — THE TWO DISPATCH STRIDES MIXED.** There
    are THREE thread layouts and they do not share a stride: `census` is dispatched over `slots * CHUNK_VOLUME` (one
    thread per VOXEL), the scan over `slots` (the slot IS the thread), and `emit` over `slots * KEYS` (one thread per
    (slot, key)). The first version served all three from ONE set of helpers, so the census took its walk ordinal
    from `i % CHUNK_VOLUME` and its pad base from `(i / KEYS) * PAD_CELLS`: most threads addressed memory past the
    batch, and **an out-of-range storage read answers 0, which is AIR**. The report was `MISMATCH — 10 of 12
    case(s)`: `uniform-solid` 1152 faces against the CPU's 6144, `one-block` NONE at all, `real(0,4,0)` 184 against
    243 — while EVERY case still logged `slice table ok` and a plausible `keys N`, because the tiny counts that did
    land were self-consistent. **That is the shape of bug a count can never catch, and it is exactly why the probe
    compares bytes face by face instead of numbers.** FIXED by naming the decodes apart
    (`censusSlot`/`censusOrdinal`/`censusPad`/`censusKey` = `i / CHUNK_VOLUME`;
    `scanKey` = the thread itself; `emitSlot`/`emitKey`/`emitKeyBase`/`emitPad` = `i / KEYS`), by DELETING the
    ambiguous helpers so no kernel can reach for the wrong stride, and by pinning both families and the absence of the
    old names in the gate (the CPU twin's own `emitSlot` was renamed `writeSlot` so the two halves cannot shadow each
    other either). The probe's per-case path also went back to `slots = 1`, so its timings stay comparable with the
    runs from before the arena.
  * **WHAT M2c STILL NEEDS, in order**: (a) the ARENA'S ALLOCATION POLICY — how big it is, how a chunk gets a region
    as the ring moves, and what happens when it is full. The region CANNOT be reserved worst-case: ~180-240 B per
    face (6 vertices × vec4 position + vec4 normal + vec2 uv) against a far ring of ~5000 chunks would be gigabytes,
    so it is a bump allocator over a per-rung arena with compaction (or a packed vertex format) and a CPU-mesher
    fallback for the overflow. `M`'s arena line is the measurement that decides it (faces per chunk, hence bytes per
    chunk); (b) the per-chunk DRAW METADATA — `drawRange`/`groups` need each chunk's slices, which live in the
    device's tables: either a batched readback or a compute-written indirect draw list (`IndirectStorageBufferAttribute`
    = `STORAGE | INDIRECT`, and the backend already consumes `renderObject.getIndirect()`); (c) then the far ring's
    stream swaps its CPU meshes for these, with the reserve and the fades intact (per-Mesh `visible` and per-chunk
    material copies behave exactly as today).
* **`K` IS THE GPU SAMPLER PROBE (M0 of the GPU route, `plugins/render/systems/lod-gpu-probe.ts`).** The LOD's
  sampling is the engine's one CPU wall: a coarse super voxel takes the max/min height over `step × step` fine
  columns, so a rung-6 column costs ~290 ms ON THE MAIN THREAD and the whole six-rung ladder ~71 s of it
  (measured; ROADMAP P2.06). `K`, in a world, runs the SAME field as a TSL compute kernel — one thread per SAMPLE,
  `step²` per grid cell — compares every value against `lodSampleGrid` (the production CPU grid, which is
  why that accessor is exported) and logs one line per rung plus a verdict, with a toast for the summary. **It
  exists to answer ONE question before anything is moved to the GPU: can f32 reproduce the f64 field exactly?**
  A one-block disagreement is not cosmetic — the coarse surface may never sit BELOW the fine one (P1.93) — so the
  probe reports the difference instead of asserting there is none, and CLASSIFIES it: differences of ONE block are
  `PRECISION` (f32 vs f64 rounding, fixed by a fround discipline or a one-block margin), anything larger is a
  `PORTING BUG` in the GPU field. It found two of the latter, both before any of M1 was written: the hill stack's
  own seed (`TERRAIN_NOISE.hillSeed`) had been replaced by the bare one (a field 20-26 blocks off), and then the
  kernel's NESTED `Loop`s aliased their counters — three names the loop variable `i` by default, so the inner loop
  shadowed the outer and every cell sampled only its DIAGONAL, `1/step` of the samples, which is why the error grew
  with the rung (max |Δ| 2/3/8 at step 8/16/32, reproduced on the CPU by modelling "diagonal only"). The kernel
  therefore uses ONE flat `Loop(step²)`; both seeds and every octave come from `TERRAIN_NOISE`, and the gate asserts
  exactly that — as does the field's own module (`lod-gpu-field.ts`), which the probe and the M1 sampler SHARE so
  there is exactly one GPU copy of `terrainHeight` in the tree. It is a probe: it owns no component, changes no
  streaming state, and its own CPU reference is the slow
  half (~1 s), so a stall while it runs is expected and logged. **Its layout is the production one**: one thread per
  SAMPLE with an atomic reduce per cell (`columns × cells × step²` threads — 2.37M for a step-32 batch), because
  the first version ran one thread per GRID CELL with an inner loop of `step²` samples, which left the device idle:
  605 ms for the batch set where the thread-per-sample kernel takes 340 ms, and it was 12× SLOWER than the CPU at
  step 2, where the per-rung dispatch+readback round trip dominates. **Its `samples/s` figure was a BUG until M1** —
  the formula clamped its divisor in the wrong unit (`gpuTotal / 1000` is SECONDS, so `Math.max(1, …)` pinned it to
  1 for any total under 1000 ms and every run printed "4M/s" whatever it did); the honest numbers are ~11.8M/s
  against the CPU's 6.3M/s, round trips included, and the line now says `M/s` to one decimal.
* **A CHUNK THAT APPEARS FADES IN AND ONE THAT LEAVES FADES OUT (P1.98/P1.99 — `FADE_IN_MS` = 220 ms,
  `FADE_OUT_MS` = 260 ms, `J` switches both off).** The reported complaint was «区块加载就闪» — a chunk that
  streams in popped at full opacity, which reads as a flash (worst on the far ring, whose chunks cover 64×64
  blocks), and the mirror image of it: a chunk that LEAVES the window vanished on the frame it left — which is
  the same pop, at the ring boundary, where the coarse mesh disappears as the fine one replacing it starts to
  fade in. Both directions draw the chunk with its OWN COPY of the material (`transparent`) and swap the SHARED
  one back when the fade ends; the difference is which end of the opacity range they start at and what happens
  at the end (`FADE_IN` puts the shared material back, `FADE_OUT` takes the mesh, its geometry and the copies
  down). Five things are load-bearing:
  * **THE COPY IS WHAT MAKES IT POSSIBLE AT ALL.** A chunk's materials are shared per (look, tier), so a
    per-chunk opacity needs a clone; `pushFade` makes the copies from the very resolution `materialsFor` just
    returned, so a `G` tint or an `H` wireframe comes along with them. `depthWrite` stays ON: the chunk keeps
    occluding itself correctly (depth-tested), so a fading chunk never shows its own back faces — the only thing
    it blends with is what is already drawn behind it. (A consequence worth knowing: because the coarse surface
    is never BELOW the fine one, a leaving coarse chunk blends OVER the fine chunk arriving behind it — the ring
    swap reads as a cross-fade rather than as a hole.)
  * **IT IS DRIVEN BY THE LANE'S DELTA, NOT BY WALL-CLOCK TIME** (`step(deltaMs = 1000/60)`, the plugin passing
    `ctx.dt * 1000`), which is what makes the fade frame-rate independent and what lets the gate finish one with
    a single big `step`. `FADE_OUT_MS` is deliberately a little LONGER than `FADE_IN_MS`: where the two meet, the
    leaving mesh must still be there while the arriving one is still nearly invisible.
  * **AN EDIT NEVER FADES (P1.18i).** `beginFade` is called from `build`, `buildFar` and `applyResult` — the
    FIRST appearance of a chunk — and never from `rebuild`, because the block the player just dug is the one
    thing they are watching. A fade already in flight when that chunk is edited is DROPPED by the guard at the
    top of `advanceFades` (a mesh that no longer holds its own copies); that guard is also what frees it, which
    is why no other path (edit, restyle, pack reload) has to remember to end a fade. An OUT fade hit by that
    guard is still RETIRED instead of dropped: its whole point is the removal, so dropping the entry without
    removing the mesh would leave a ghost in the scene for ever.
  * **A MESH THAT LEAVES THE WINDOW LEAVES THE CACHE AT ONCE AND THE SCENE LATER.** `unloadOutside` deletes the
    key (so nothing treats the chunk as loaded and the streaming budget may rebuild it) and then hands the ENTRY
    to `beginFadeOut`, which answers whether the fade took the mesh over. The mesh, its geometry and the copies
    are only taken down when the fade ends — or at once when `J` is off, or past `FADE_OUT_MAX` leaving meshes at
    the same time. That cap is sized for the MASS unload (a teleport into a world = the whole previous window,
    thousands of meshes, all hundreds of blocks away and behind the camera): a NORMAL move retires a whole STRIP
    — the window is a square, so crossing one column drops ~15 columns × 8 Y chunks, measured at ~250 meshes.
    A chunk that comes BACK while its ghost is still fading takes that ghost down first (`killDying`, called by
    `build`/`buildFar`), or the same chunk would be in the scene twice for the rest of the fade.
  * **`J` TURNS BOTH OFF** and ends every fade in flight at once (`finishAllFades`): the arriving ones reach full
    opacity now, the leaving ones are taken down now. Ending them at the switch is not cosmetic: with the effect
    off nothing would ever finish a fade, so a chunk caught mid-fade would stay translucent for ever. `J` is
    SESSION-ONLY and overrides both rings; the PERSISTED choice is the two settings rows below.
  * **THE FADE IS ONE UNIFORM SWITCH (P2.01 → P2.05): `settings.fadeLod`, plus the `J` key as the session-only
    master.** A chunk that APPEARS fades in and one that LEAVES fades out — a real 32³ chunk of the fine ring
    and a coarse cell of any LOD rung alike. The history is worth knowing because it explains the shape: the
    effect began over both rings (P1.98/P1.99), was split per ring when the reserve (P2.00) made them different
    questions (P2.01), narrowed to the OUTERMOST rung (P2.04, on the argument that every rung inside it is
    swapped for a reserved cell and has nothing to soften), and is uniform again by request (P2.05): which rung a
    chunk belongs to is an implementation detail of the window, not the player's question. The reserve makes it
    safe in every case — a coarse cell is drawn until the finer chunks over it are BUILT AND OPAQUE, so a
    translucent chunk never uncovers the sky, it only lets the coarser level show through while it arrives.
    `FadeOptions.chunks` is the RETIRED pre-P2.05 fine-ring switch: still read from an older `settings.json`
    (so nothing reads as repaired) and no longer consulted — the row that set it is gone from the panel. The
    value lives in the `FADE_OPTIONS` RESOURCE because `chunk-stream` reads
    it every step, the panel changes it through the `SetFadeOption` COMMAND, and the save is HANDED the new
    value (reading the resource back would write the state the user just left) — the same shape as the frame cap
    and vsync.
  The gate drives all of it on a real stream (0 opacity on the first step → no progress with a zero delta → half
  the opacity at half the time → the shared material back, copies freed, at `FADE_IN_MS` → an edit cutting a
  fade short without the chunk going translucent again → a window move with `J` off giving opaque chunks at once
  and with `J` on giving invisible ones again → and, for the other direction, a leaving chunk that is STILL IN
  THE SCENE at full opacity, at half the way down at half the time, and out of the scene with its geometry and
  its copies freed at `FADE_OUT_MS` → a chunk that comes back while its ghost is fading → `J` off removing a
  leaving chunk at once). Both directions were mutation-tested: removing the `beginFadeOut` call, and never
  taking a ghost out of the scene, each fail the assertion that exists for it.

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
  **ONE flag has since been added back (P2.07, by request): `--force_high_performance_gpu`,** and it is not about
  frame pacing but about WHICH GPU the WebView runs on. `WebGPURenderer` already asks for the discrete adapter
  (`powerPreference: "high-performance"`, `boot/main.ts`), but that is a request INSIDE the webview: on a hybrid
  laptop Windows picks the adapter for the **WebView2 process** and defaults to the power-saving one, so the engine
  was drawing on the integrated GPU with the discrete card idle (the user's Task Manager observation). Windows'
  per-app Graphics preference fixes the same thing per install; the flag makes it the default. The informed-consent
  cost is battery life, and on a machine with only an integrated adapter Chromium ignores it. The result is
  verifiable from the logs: the startup prints the argument list in force (`BOOT webview args: …`, debug.log), and
  its GPU stage now prints the ADAPTER it actually got (below).
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
  world — now at up to 7168 blocks instead of ~256 (the outer rung, P2.03), which makes it more noticeable, not
  less. Two numbers decide how much of it you actually see: `DEFAULT_LOD.reach`/`tiers` (data/world/lod.ts), and
  **the camera's FAR PLANE** (`boot/main.ts`, 12000 blocks since P2.04) — everything past it is culled as a whole
  object, so a ladder that reaches further than `far` is built, paid for and never drawn (the six-rung ladder did
  exactly that to its own outer rung while `far` was 5000). `near` may NOT be raised to buy depth precision, and
  the limit is not the 0.3-wide body: a wall you are touching is 0.3 blocks to the SIDE, so the frustum only
  reaches it at a depth of `0.3 / tan(halfFovH)` (≈0.22 at 16:9, less on a wider window) — a `near` above that
  clips a sliver of wall at the left/right screen edges and you see through the wall beside you (measured at
  0.25). It is 0.1; the answer to distance z-fighting is `logarithmicDepthBuffer`, not `near`. To push the rim
  out further, raise `reach`/`tiers` AND `far` together, or reintroduce a `scene.fog`.
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
