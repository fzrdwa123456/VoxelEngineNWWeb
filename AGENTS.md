# AGENTS.md — guide for AI assistants (and humans who want the fast tour)

Read this before changing anything. It maps the architecture, the invariants that keep it
correct, and where new code goes. The user-facing README (Chinese) covers build/run and the
mod/resource-pack format; this file covers how the CODE is organized and which lines are
load-bearing.

**This file describes only what EXISTS.** Everything planned or deliberately skipped is in
`ROADMAP.md` — read that too before proposing work. If the two ever disagree, this file is right and
`ROADMAP.md` is stale.

## What this is

VoxelEngineNWWeb — a Minecraft-style first-person sandbox on NW.js (Chromium + Node in one
process) with a three.js WebGPU renderer, packaged as a portable Windows directory.

**Current world state: a flat, EDITABLE voxel world exists; real terrain does not.** `src/voxel/`
is a chunk system (32³ chunks) whose generator fills every chunk with the engine's built-in
magenta/black checker block. `ecs/systems/collision.ts` resolves the player AABB against it (you
land, walk, jump) and `ecs/systems/interaction.ts` breaks and places blocks with the mouse.
Topology is deliberate: **X/Z is a TORUS** (`WORLD_CHUNKS_X/Z`), and **Y is bounded but split in
two** — `[WORLD_MIN_Y, TERRAIN_TOP_Y)` is ground, `[TERRAIN_TOP_Y, WORLD_MAX_Y)` is writable
BUILD SPACE, and below WORLD_MIN_Y everything is bedrock. There is no stone/grass/biome content
and only ONE block type, and the planet/LOD systems are still gone. `generateChunk()` in
`voxel/world.ts` is the ONE place to replace when real terrain arrives — nothing else in the
engine knows what a block "is".

## Directory map — what goes where

```
src/
├── main.ts                 composition root: provision the World's resources, construct the
│                           systems, register them (with explicit after/before constraints),
│                           wire UI callbacks. It ALSO owns the frame loop — ONE rAF chain for the
│                           process, started once at the bottom of the file, whose BODY the loop mode
│                           picks (`frame()`: "game" = fixed-step accumulator + FPS-cap gate +
│                           `world.render`; "menu" = the menu background + `world.renderUi()`;
│                           "load" = a LOADING SCREEN is up, i.e. the ui lane alone). That block at the
│                           bottom is also the BOOT DRIVER (reveal the window, check the settings,
│                           initialise the GPU, announcing each stage on the loading screen first) and
│                           `enterWorld()` is the WORLD DRIVER (build the spawn window behind that same
│                           screen) — see "Boot" below.
│                           `setLoopMode("load" | "game" | "menu")` is a pure
│                           mode write — there is no second chain to start or stop and nothing to
│                           cancel. It holds no game logic and reads no component column, and it keeps
│                           NO listener of its own: the ones whose default action must be cancelled
│                           inside the event (pointerlockchange log, ESC/contextmenu preventDefault,
│                           the Space shield) are `platform/window-guards.ts`, the ONE resize listener
│                           is `platform/viewport.ts`, and everything else is a queued device intent
│                           or a command.
│                           It has NO `setInterval` and no second "is it running" flag.
├── blockregistry.ts        block data registry (merges blocks.json across packs). NOTE: the
│                           voxel mesher does NOT consult it yet — see voxel/ below.
├── voxel/                  the block world. No three.js, no ECS, no behaviour:
│   ├── chunk.ts            32³ chunk storage. A uniformly filled chunk holds ONE value and
│   │                       allocates no array until it is first written — that is what makes the
│   │                       tall build space free; isUniform also drives the mesher's fast paths
│   ├── world.ts            VoxelWorld: chunk map, torus wrap in X/Z, a SPLIT Y range (ground
│   │                       below TERRAIN_TOP_Y, writable build space above, bedrock below
│   │                       WORLD_MIN_Y), getBlock/isSolid/setBlock/topSolidY, the dirty-chunk
│   │                       set (takeDirty) and `generateChunk()` — THE terrain entry point
│   └── raycast.ts          Amanatides & Woo voxel DDA -> first solid block + its face normal
├── ecs/
│   ├── core/                the ECS itself: no game knowledge, no three.js, no DOM
│   │   ├── entity.ts        generation-checked handles (`index << 8 | generation`) + the slot
│   │   │                    allocator. A stale handle is DETECTABLE, not silently reused.
│   │   ├── component.ts     defineComponent (SOA: one typed array per field) / defineRecord
│   │   │                    (one plain record per entity) + the dense/sparse membership lists
│   │   ├── query.ts         cached sparse-set intersection. refresh() once per step; the result
│   │   │                    is then stable, because structure only changes at a barrier
│   │   ├── store.ts         entities + component columns + the query cache + structuralVersion
│   │   ├── schedule.ts      the three stages, named systems, after/before resolution + verification,
│   │   │                    declared access sets, the derived batches, the dependency rule and the
│   │   │                    runtime barrier check. The scheduling half of parallelism.
│   │   ├── commands.ts      CommandType/defineCommand + the deferred queue
│   │   └── resource.ts      Resource<T> handles (typed tokens, not string keys)
│   ├── World.ts             the façade and the ONE import path: spawn/despawn/insert/remove/has/
│   │                        get/query, insertResource/resource, addSystem, commands, start,
│   │                        stepFixed/render/renderUi. Re-exports the core types.
│   ├── components/          component DEFINITIONS (pure data + spawn helpers). Player.ts defines
│   │                        them all: POSITION/PREV_POSITION/ORIENTATION/VIEW/BODY/REACH/
│   │                        INTERACTION/PLAYER (SOA) and MOTION/CONTROL/INVENTORY (records).
│   │                        10 of the 11 are ENTITY-AGNOSTIC; only PLAYER and spawnPlayer() are
│   │                        player-specific. Spawn helpers: attachMovable() declares what a
│   │                        physical body needs, spawnMovable() makes an NPC/prop, spawnPlayer()
│   │                        adds the locally driven parts, placeEntity() moves POSITION and
│   │                        PREV_POSITION together. HUMANOID_BODY / DEFAULT_REACH are spawn
│   │                        DEFAULTS, not state. No three.js, no registry import.
│   ├── resources.ts         the world-scoped singletons: LOCAL_PLAYER (an entity handle), VOXEL,
│   │                        INPUT_STATE (pointer-lock/device state) and INPUT_TIMING (the state the
│   │                        input race guards keep: which mousemove is the synthetic lock-instant one,
│   │                        whether the unlock was OURS, the grace deadline, the offscreen cache and the
│   │                        F3 SPACE/MOUSE counters — the fields, not the logic), UI_MODAL (which modal UI
│   │                        surfaces are open AND which settings sub-page is up: mainMenu / menu /
│   │                        inventory / settings / gen — the sub-page is navigation DATA, not a view
│   │                        field), FPS_CAP (the frame-rate cap AND its domain: read by the loop's
│   │                        frame gate every frame, printed by diagnostics, persisted as a setting;
│   │                        CAP_MIN/CAP_MAX/CAP_STEP live here because `sanitizeFrameCap` clamps and
│   │                        snaps into them — `fpsCap: 1` loads as 30, `300` as 0/unlimited — so the
│   │                        stored value is always one the slider can express),
│   │                        and the three the UI systems own: KEY_EVENTS (key AND mouse-button EDGES
│   │                        published by the device layer — the world's one event log, a
│   │                        READ-ONCE-PER-CONSUMER channel: each consumer holds its own KeyEdgeReader
│   │                        cursor, so ui.picker and ui.navigation both see every edge exactly once),
│   │                        PICKER_STATE (the F3+F4 picker's open/sel/held keys) and TOAST (the HUD
│   │                        message + its wall-clock deadline, armed by the ShowToast command).
│   │                        Plus DELAYED_INTENTS: the "do this in a moment" queue — a LIST of
│   │                        `{ at, kind: relock|cursor|lockRetry, arg }` deadlines on the SAME wall clock,
│   │                        applied once per frame by `ui.delays`. It is the toast's shape because
│   │                        four `setTimeout`s used to own that question (see ecs/systems/delays.ts).
│   │                        Plus LOADING_STATE: the LOADING SCREEN (active, progress, the stage's
│   │                        i18n key, and the settings check's outcome as a key + a list of names).
│   │                        The drivers publish it through SetLoadingStage; `ui.loading` paints it —
│   │                        the screen is data, and main.ts builds no element. Its i18n KEYS are
│   │                        `loading.*` (a pack-visible rename: a pack overriding `boot.*` must
│   │                        move them).
│   │                        A scroll position is deliberately NOT a resource (or a component): a
│   │                        scrollable list starts at the top on every visit and otherwise belongs to
│   │                        the browser — see ecs/ui/system.ts.
│   │                        And the CONFIGURATION that is read on the tick: LOCALE (the language in
│   │                        force — the reconciler re-derives every widget's text from it every
│   │                        frame), FONT and UI_SCALE (which font pair / scale mode is applied), and
│   │                        KEYMAP (action -> bind code, asked by movement/interaction/input every
│   │                        step). ui/i18n.ts, ui/fonts.ts, ui/uiscale.ts and platform/keybinds.ts own
│   │                        the FILES and read/write these objects; every reader declares them
│   │                        (`readsExternal`). Assets are NOT here: the dictionaries, the block
│   │                        registry and the background kind are loaded once from the packs and never
│   │                        change, so they are constants (the menu background kind is memoised because
│   │                        the menu frame asks for it every frame).
│   │                        Also the predicates the gameplay gate reads:
│   │                        canControl(devices, ui), isModalUi, isMenuUi. A neutral file so no
│   │                        system imports another and voxel/ stays ECS-free.
│   ├── presentation.ts      the three.js / GPU / DOM objects the WORLD owns: SCENE3D, CAMERA3D,
│   │                        RENDERER3D (the device layer takes its canvas from `domElement`),
│   │                        PERF_SAMPLER, CANVAS_HOST (index.html's `#app`), UI_MOUNT (the root every
│   │                        widget is appended to) and CHUNK_MESHES (the chunk-mesh cache: parent group,
│   │                        meshes, the "no geometry" set — `createChunkMeshCache(group)`). These used
│   │                        to be constructor ARGUMENTS; a system resolves what it uses in its own
│   │                        constructor body instead, which gives each object one owner and makes it a
│   │                        SEAM a test can stub (the Node gate drives the chunk stream with a plain
│   │                        object for the group). Type-only imports of three.js, so this module stays
│   │                        loadable in Node. It does NOT change the schedule: the conflict model is
│   │                        keyed by the declared target NAMES (`camera3d`, `chunkMeshes`, …), not by
│   │                        resource handles, so those declarations stay as they are.
│   ├── commands.ts          the concrete commands: SetMode, Teleport, SelectSlot, SwapSlots, ShowToast,
│   │                        SetLoadingStage (a partial stage update for the loading screen) and
│   │                        SetFpsCap (the one setting that is also world state — the frame gate reads
│   │                        the resource every frame, so a UI callback may not assign it).
│   │                        The ONLY way non-system code (UI, DOM handlers, main.ts) may change state.
│   └── systems/             all behavior:
│       ├── input.ts        pointer-lock state machine + mouse/key/bind capture. Fixed lane, FIRST:
│       │                   its `step()` drains the intents the DOM listeners queued (a key, a scaled
│       │                   view delta, a jump/fly value) into the CONTROL keys, the VIEW deltas and
│       │                   MOTION — so no gameplay component is written outside a system run, and the
│       │                   schedule can order it against the controller/movement/collision that read
│       │                   it. The listeners still decide everything at EVENT time (IMPORTANT:
│       │                   RACE-SENSITIVE, rule 3), and INPUT_STATE stays event-time too: the lock
│       │                   state machine must react synchronously to a pointerlockchange. It does NOT
│       │                   carry a cached "a click may grab the lock" flag — that was a second copy of
│       │                   `!isModalUi(UI_MODAL)`, so the canvas-click handler and the raw-input
│       │                   takeover test ask UI_MODAL at the moment of the question. It owns
│       │                   the MOUSE-BUTTON listeners as well as the keyboard ones (mousedown is
│       │                   guarded by `isCapturing()`, maps the button to a bind ACTION and CODE,
│       │                   publishes a button edge and takes the press/release decision — a button
│       │                   bound to "inventory" produces ONLY an edge, because whether the bag opens
│       │                   is ui.navigation's call). The RAW-MOUSE deltas arrive per event
│       │                   (`rawDelta`, ~4 ms: the Rust push cadence) and are APPLIED once per frame
│       │                   (`frameLook`, called by the frame before any fixed step). There is no timer
│       │                   in that path any more: the 8 ms poll it replaced was stretched to 9–12 ms
│       │                   whenever a key was held (Chromium runs input tasks before timer tasks), so
│       │                   the number of look samples per frame jumped between 0 and 3 and the view
│       │                   juddered — measured with the `FRAME … pf=[…]` probe. Its race-guard FIELDS are
│       │                   the INPUT_TIMING resource
│       │                   (which mousemove is the synthetic one, whether the unlock was ours, the
│       │                   grace deadline, the offscreen cache, the F3 counters) — the LOGIC and its
│       │                   order stay in the listeners, untouched. The queued intents are deliberately
│       │                   NOT a resource: nothing outside may see a half-applied frame. The only system
│       │                   with DOM listeners, so it resolves its
│       │                   data in the constructor rather than at start(). A click may capture the mouse
│       │                   only while a WORLD runs (`inWorld` is injected): the loading screen owns no
│       │                   modal flag, so the UI_MODAL guard alone let a click there engage the native
│       │                   capture before a world existed — and the entry then re-locked on top of it.
│       │                   The companion rule lives in main.ts: a WINDOW GEOMETRY change is a device
│       │                   signal (Rust's `win-geometry` on Resized/Moved/DPI) treated like losing the
│       │                   window — hand the mouse back, pause if playing — because dragging a border
│       │                   keeps the window FOCUSED (no blur) while the capture's ClipCursor rectangle
│       │                   goes stale (see ROADMAP §5.2 P1.10).
│       ├── controller.ts   drains the VIEW deltas → yaw + pitch clamp (pitch is clamped to
│       │                   ±89.4° in EVERY mode; there is no wrap past the zenith). While the
│       │                   player is UNCONTROLLABLE it DROPS the buffer instead of holding it:
│       │                   holding it replayed the last fraction of a tick's mouse movement the
│       │                   moment ESC/the backpack gave control back, which read as "the view
│       │                   slides by a few degrees after closing the UI"
│       ├── movement.ts     mode-dependent locomotion over every entity matching
│       │                   CONTROL+POSITION+ORIENTATION+MOTION (query-driven). Integrates the
│       │                   tick PROVISIONALLY — collision re-integrates and resolves it.
│       ├── snapshot.ts     fixed lane, after player.input: PREV_POSITION := POSITION for every entity
│       │                   carrying both. It feeds the render interpolation AND the collision sweep
│       │                   origin, and it is query-driven because a local-player-only write silently
│       │                   broke collision for every other entity (see the file header).
│       ├── collision.ts    AABB vs the voxel grid, one axis at a time, sub-stepped. Runs AFTER
│       │                   movement in the fixed lane, sweeping from PREV_POSITION — which is part
│       │                   of its QUERY, so an entity without one is not swept at all (it falls,
│       │                   loudly) rather than swept from a bogus origin (it jitters, quietly).
│       │                   Reads BODY per entity. Owns motion.onGround and zeroes motion.vy on
│       │                   contact; skips spectator (noclip).
│       ├── interaction.ts  break (left) / place (right) through a voxel raycast + the target
│       │                   outline. QUERY-DRIVEN over CONTROL+POSITION+ORIENTATION+INTERACTION+
│       │                   REACH+BODY, so every entity gets its own reach, body box and rate
│       │                   limits. Polls CONTROL.keys with a dt cooldown (no event listeners),
│       │                   refuses placement overlapping the body box, and reads the hand from
│       │                   INVENTORY — there is no UI callback. An uncontrolled LOCAL player
│       │                   (PLAYER marker) never edits blocks, so UI clicks cannot; NPCs keep
│       │                   acting. The block TYPE it reads is not yet written into the world
│       │                   (one voxel value — see ROADMAP.md §3.2).
│       ├── chunkstream.ts  render lane: keeps the chunks around the player generated, meshed
│       │                   and placed at their nearest torus representation (budgeted), and
│       │                   drains VoxelWorld.takeDirty() so block edits re-mesh immediately.
│       │                   It also owns the WARM-UP a world entry drives: `warmUp` builds a whole
│       │                   window at once behind the loading screen, and `needsWarmUp` answers
│       │                   "is there anything left to build here" (false = enter at once).
│       │                   The MESH CACHE (the parent group, the meshes, the "no geometry" set) is the
│       │                   CHUNK_MESHES resource, not a private field; the system keeps only the
│       │                   window bookkeeping (the wanted set and the last column it was built for).
│       └── diagnostics.ts  render lane: perf window, the PHYS log line, the input queues'
│                           incremental forwarding, the GPU timestamp read; it WRITES THE F3 TEXT
│                           WIDGET (not the DOM) and refreshes the F3 panel
│       └── delays.ts       ui lane, after ui.navigation: the DELAYED INTENTS (ecs/resources.ts::
│                           DELAYED_INTENTS) — whatever WALL-CLOCK deadline has passed is applied here
│                           through injected effects. It is the shape the toast uses (data, not a
│                           timer), and it exists because four `setTimeout`s used to be the only way
│                           to say "in a moment": closing the backpack relocking the mouse, the lock
│                           manager's 1300 ms retry, and the cursor re-asserts at 0/120 ms (focus
│                           regained) and 0/32/80 ms (the menu/Apps key — the layer that wins the
│                           cursor-flash race, so it is the one place a missed deadline is visible)
│   ├── ui/                  the UI WIDGET layer — "UI is data" (see ECS conventions):
│   │   ├── theme.ts         UI_THEME: every colour token, plus recipeStyle(), the ONE style table
│   │   │                    (recipe + state -> style string), plus the global stylesheet an inline
│   │   │                    style cannot express. DOM-free, pure.
│   │   ├── widgets.ts       the widget components (UI_TREE/UI_TEXT/UI_LOOK/UI_STATE/UI_ACTION/
│   │   │                    UI_INPUT/UI_LAYOUT/UI_IMAGE/UI_TIP/UI_BIND) and the PREFABS that make
│   │   │                    them reusable: panel/label/button/grid-key/slider/list + the setters.
│   │   ├── actions.ts       UI_ACTIONS: the action TABLE (id -> handler) as a resource. A clickable
│   │   │                    widget carries an id; the reconciler dispatches, and knows nothing
│   │   │                    about what a "settings panel" is.
│   │   ├── hud.ts           UiHudSystem: the GAMEPLAY gate, first in the lane. The crosshair and the
│   │   │                    hotbar are spawned VISIBLE and nothing wrote their flag, so they showed at
│   │   │                    the main menu, on the loading screen and OVER the pause menu (hotbar z-31 >
│   │   │                    that menu's root z-30), with clickable slots. `inWorld()` owns them now.
│   │   ├── loading.ts       UiLoadingSystem: the LOADING SCREEN (the startup, and a world entry), and
│   │   │                    the only reason a `load` frame has a body. It reads LOADING_STATE and
│   │   │                    writes its widgets: the stage line as a key, the percentage raw, one
│   │   │                    `active` boolean per bar segment, the settings check's label + name list.
│   │   │                    Registered before the other widget-data writers: it writes the same
│   │   │                    components, so the conflict rule needs an order.
│   │   ├── bindings.ts      UI_SOURCES (id -> a getter) + UiBindingSystem: a widget that declares
│   │   │                    UI_BIND takes its VALUE from shared state every frame instead of holding
│   │   │                    a private copy. Two settings panels showing one setting cannot drift.
│   │   ├── picker.ts        UiPickerSystem + spawnPickerPanel: the F3+F4 game-mode picker. It consumes
│   │   │                    the key EDGES the device layer publishes (a held-key set cannot say "F3
│   │   │                    went down just now"), owns PICKER_STATE, toggles the F3 debug panel through
│   │   │                    that panel's own UI_STATE, and changes the mode through the injected
│   │   │                    SetMode command. The panel and the chord are GAMEPLAY UI, gated on
│   │   │                    `inWorld()`: outside a world it only consumes the edges (see hud.ts).
│   │   ├── toast.ts         UiToastSystem: the HUD message. The text is an i18n KEY and the deadline is
│   │   │                    a WALL-CLOCK time in the TOAST resource (the ui lane runs with dt = 0 while
│   │   │                    the menu pumps it, so a dt counter would never expire there) — armed by the
│   │   │                    ShowToast command, applied and taken down by this system. A view owning a
│   │   │                    setTimeout was the reason a toast could not outlive its caller.
│   │   ├── keybind.ts       UiKeybindSystem + KEYBIND_GESTURE/KEYBIND_PANELS: the bind panels are
│   │   │                    DERIVED data (chip labels/selection, keycap legends/bound state) written
│   │   │                    every frame from the bind table, so two panel instances cannot desync; the
│   │   │                    drag's state (which chip, which keycap, the live pointer, the click shield)
│   │   │                    is data too. The ARM PATHS stay in ui/menu.ts (click-synthesis timing), and
│   │   │                    the rubber band is a WIDGET: this system writes its geometry (UI_LAYOUT) and
│   │   │                    its shown flag from the gesture + the POINTER resource, and the reconciler
│   │   │                    paints it — the view owns no element and no mousemove listener any more.
│   │   ├── navigation.ts    UiNavigationSystem + stepBackSettings(): which MODAL SURFACE is up, as
│   │   │                    data. It drains the same key/button EDGES through its own reader and
│   │   │                    takes the decisions the ESC if-chain used to take over five views'
│   │   │                    private fields: ESC steps the sub-page ladder (`gen` -> false, the
│   │   │                    settings LIST -> null, any other sub-page -> the list) and only then
│   │   │                    closes the container, the inventory key and its mouse bind toggle the
│   │   │                    bag, and it is the ONE PAINTER of the modal widget trees (a surface's
│   │   │                    `show()` is a data write; nothing else turns UI_MODAL into UI_STATE). The
│   │   │                    pointer-lock EFFECTS arrive as injected callbacks, so the module stays
│   │   │                    DOM-free, and the two actions that only mean something IN a world (ESC
│   │   │                    opens the pause menu, the inventory key opens the backpack) are gated on
│   │   │                    `inWorld()` — a loading screen is exactly the state where neither may fire.
│   │   │                    Registered BEFORE ui.widgets and after the other widget-data writers.
│   │   │                    A declared `after` is honoured in EITHER registration order (the batcher
│   │   │                    resolves its adjacency — see ROADMAP §3.9); the trees it paints are injected
│   │   │                    through a getter because the menus are wired after the Schedule is built.
│   │   └── system.ts        UiRenderSystem: reconciles every widget's element once per frame
│   │                        (mount / unmount / update) and is the ONLY code that creates, styles or
│   │                        listens to one. It also applies the GLOBAL STYLE to the document
│   │                        root — the font pair and the root font size, read from the FONT / UI_SCALE
│   │                        resources (injected as `currentFontCss()` / `currentRootFontPx()`) and
│   │                        written only when they change, which is why a resize needs no callback.
│   │                        The EVENTS ARE DELEGATED to the mount root: ONE listener per type for the
│   │                        whole tree (it used to attach six to every widget at mount time, each a
│   │                        closure over an entity), and the widget an event belongs to is found by
│   │                        walking up from `ev.target` — the same walk `hitTest` makes. Hover is an
│   │                        ancestor-chain DIFF over the bubbling `mouseover` (mouseenter/mouseleave do
│   │                        NOT bubble): the widgets above the new target are compared with the ones
│   │                        the previous event left, and the difference is the enter/leave set, so a
│   │                        parent and a child can still be hovered at once.
│   │                        It is POINTER-ONLY: a keyboard-generated `click` (TAB then ENTER/SPACE, or a
│   │                        programmatic `.click()`) carries `detail === 0` and is dropped, because the
│   │                        UI is mouse-driven — a real press/release carries the click COUNT. The
│   │                        focus ring and a focused slider's arrow keys are NOT filtered (only `click`
│   │                        is), so if the keyboard should not reach the UI at all, that is a separate
│   │                        `tabIndex` decision.
│   │                        It owns hover/press state, the marquee
│   │                        for text that does not fit, the "back to the TOP" edge of every role the
│   │                        theme lists as scrollable (an EDGE, not a stored position: a list starts
│   │                        at the top whenever its PANEL — or any ancestor — becomes visible, and
│   │                        while it stays up the position is the browser's), and the hit test the
│   │                        key bind drag asks ("which widget is under this point"). In the ui STAGE.
├── rendering/              anything drawn: camera-view.ts (the CameraViewSystem: interpolation from
│                           PREV_POSITION -> POSITION plus the orientation quaternion, written into the
│                           world's CAMERA3D resource, and the
│                           shared viewDirection() the block raycast uses — a CONSUMER of the
│                           snapshot, never its writer),
│                           menu-background.ts (the MenuBackgroundSystem: the main menu's panorama +
│                           spin/flip state, which IS the MENU_BACKGROUND resource; deliberately NOT
│                           registered in a lane — a MENU frame never runs the render lane, so what it
│                           buys is an OWNER for the state and one entry point, not a batch),
│                           textures.ts (pack chain resolution), blockicons.ts (icon baking),
│                           chunkmesh.ts (face-culled chunk geometry + the checker material)
├── platform/               host/browser services, produce data only: shell.ts (NW.js:
│                           settings/logs/window — it owns settings.json, whose VALUES live in the
│                           config resources, and it owns the DIAGNOSTIC-PROBE SWITCH: the settings
│                           panel's "Diagnostic log" toggle, default ON, filters the probe lines
│                           (`FRAME`/`LOOK`/`RAWLAG`/`RAWMON`/`STALL`/`PHYS`/`SPACE#`/`MOUSE#`/
│                           `HOOKPROBE`) inside `logDebug`, while `appendDebugLog` — the error/console
│                           channel — always writes; the probe PREFIX TABLE there is the one place a
│                           new probe has to be registered), keybinds.ts (owns the DEFAULTS + code validation and
│                           reads/writes the KEYMAP resource), rawinput.ts, pointerlock.ts (relock +
│                           the cursor; it publishes NO cached "click may grab the lock" any more, and it
│                           REFUSES to capture while the window is not in the FOREGROUND — the native
│                           ClipCursor path has no such check of its own, unlike the browser's
│                           requestPointerLock, so the gate is explicit; the Rust emitter adds a
│                           system-level net that tears a background capture down and emits `capture-lost`,
│                           which the frontend handles exactly like a blur),
│                           debuglog.ts, perf.ts, window-guards.ts (the listeners whose default action
│                           must be cancelled INSIDE the event: the pointerlockchange log, the ESC and
│                           contextmenu preventDefaults, the Space shield, and the menu/Apps-key cursor
│                           re-assert), bind-gesture.ts (the bind gesture's five DEVICE listeners: the
│                           one-shot click shield, the merged mouseup = shield fallback + drag end, the
│                           wheel block, the key capture and the drag's mousedown — its STATE is
│                           KEYBIND_GESTURE, its panels are `ui.keybind`, and only this event-time half
│                           stays in `ui/menu.ts`'s arm paths), viewport.ts (the ONE `window` resize
│                           listener; it only PUBLISHES the VIEWPORT resource)
└── ui/                     DOM interfaces. `loading.ts` (the loading screen's tree: the startup AND
                            a world entry), `hud.ts`, `menu.ts` (pause menu + shared settings panel, key
                            binds included), `mainmenu.ts` and `inventory.ts` build their widget trees
                            during wiring and afterwards only write component data: no
                            createElement, no style string, no CSS-as-state, no colour literal, and no
                            visibility field of their own — `show()`/`hide()` write `UI_MODAL`, which
                            `ecs/ui/navigation.ts` turns back into widget visibility. The F3+F4
                            picker and the key bind gesture's state are systems/resources in `ecs/` now.
                            What remains here is the WIRING (which widget goes where, which
                            action id a button carries), the arm paths of the bind gesture, and the
                            views' component writes. The one named exception is the key bind DRAG RUBBER
                            BAND (an SVG overlay in `menu.ts`, drawn on request from the keybind system).
                            The config modules are VALUES ONLY: `i18n` answers from the LOCALE resource,
                            `fonts`/`uiscale` publish the font css pair and the root font size
                            (`currentFontCss()` / `currentRootFontPx()`), `background` answers from the
                            pack chain (memoised) — and the RECONCILER is what applies the global style.
                            Every modal surface PUBLISHES its
                            visibility into UI_MODAL instead of making gameplay ask six container
                            booleans whether a UI is up.
packs/                      official example mod + resource pack (copy into game/)
launcher/, rawinput/        native sources (C launchers, Rust input plugin)
scripts/                    build chain (`npm run build`): tsc && vite build → rearrange.mjs →
                            gcc launcher/launcher.c (launcher.exe). get-nw.mjs is a SEPARATE
                            `npm run get-nw` step, not part of build; build:cursor/build:winctl
                            are separate too. dump.tmp.mjs is a leftover.
app/                        NW.js manifest source (rearrange.mjs copies it to game/core/)
```

Placement rule of thumb: touches the OS/browser/NW.js → `platform/`; touches three.js/pixels →
`rendering/`; mutates entity data per tick → `ecs/systems/`; entity state itself →
`ecs/components/`; visible DOM → `ui/`.

## The three lanes (how the loop runs)

The schedule has three stages — `fixed`, `render`, `ui` — and they do NOT all stop together. That
is the whole reason the third one is separate.

```
rAF game loop — ONE chain; `frame()` picks its body from `loopMode` (see setLoopMode in main.ts):

  frame()          // one rAF chain for the whole process, re-armed at the end of every frame
    "game" -> renderFrame():
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
      FPS-cap gate: when FPS_CAP.cap > 0 and the frame budget is not yet met, RETURN here
                    (physics above already advanced; only drawing/stats are gated)
      world.render(alpha, delta)                 // alpha = remainder of the physics tick
          BARRIER again, so a UI/menu command lands before this frame is drawn
          render lane:
            1. cameraView.render(alpha)            // position lerp + orientation quaternion
            2. chunk.stream                        // generate / mesh / place chunks (budgeted)
            3. diagnostics                         // perf/PHYS log/F3 (writes the F3 TEXT widget)
            4. renderer.draw                       // renderer.render(scene, camera)
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
```

**There is ONE loop and ONE MODE, not three loops and a pile of flags.** `setLoopMode("load" | "game" |
"menu")` is a PURE MODE WRITE — the chain is already running, so there is nothing to start, stop or
cancel. Every call site says which state it wants (boot, entering a world, back to the main menu)
instead of which one to leave. "Are we playing" is DERIVED (`inWorld()`), and `check:ecs` asserts there
is exactly ONE `requestAnimationFrame`, no `cancelAnimationFrame`, and a frame body that dispatches on
the mode. The mode starts as `"load"` so the first transition always applies; the boot block ends by
calling `frame()` directly, which is the single place a frame is kicked off. (Why this shape replaced
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
SCHEDULE render: 4 systems, 2 batches, 3 parallel pair(s) [(cameraView.render ~ chunk.stream ~ diagnostics) | renderer.draw]
SCHEDULE ui: 10 systems, 9 batches, 1 parallel pair(s) [(ui.hud ~ ui.bindings) | ui.loading | ui.inventory | ui.picker | ui.toast | ui.keybind | ui.navigation | ui.delays | ui.widgets]
```

Reading those reports: the fixed lane's batch 0 is a REAL read-after-write (`player.input` writes
the VIEW/keys the three systems after it consume), and its edge to `motion.snapshot` is a declared
PESSIMISATION kept so the tick still drains first. `renderer.draw` must follow its two producers. The
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

**The world itself is built on ENTRY, not at startup** (`enterWorld`): the Teleport goes through the
barrier first (the warm-up reads POSITION), then `world.spawn` → `world.terrain` (`chunkStream.prime`)
→ `world.chunks` (`chunkStream.warmUp`, which meshes the WHOLE spawn window instead of spreading it
over ~100 frames) → `world.ready`, and the mode hands over to `game` in the same ui lane that takes the
screen down (a game frame draws the scene BEFORE its ui lane, so no empty frame shows). `boot()` must
not touch `chunkStream` at all — the gate asserts that separation, and it is why the main menu is up
after ~0.45 s instead of ~2 s. A RE-entry into a window that is still built skips the screen entirely
(`chunkStream.needsWarmUp`), because a screen that appears for one frame is worse than none.
**EACH driver ACTIVATES the screen itself** (`SetLoadingStage { active: true }`): the startup's last stage
sets `active = false`, so the entry has to set it back — this shipped broken twice, and the gate now
asserts the flag per driver. It also has to enter `load` mode (it is driven from the MENU).

The per-stage yield is a `setTimeout` macrotask, NOT a second `requestAnimationFrame` chain: the process
still owns exactly one, and the gate asserts it.

**The settings FILE is checked at boot, repaired, and written back.** Every config module validates its
own field and silently falls back when it cannot (`loadLang` ignores a language outside zh/en/ja,
`sanitizeFrameCap` turns a hand-edited `fpsCap: 1` into 30, `loadBinds` drops a code it does not know).
That is right at LOAD time, but it left the file saying one thing while the game used another — the bad
value survived on disk, unreported, and every launch guessed again. `platform/shell.ts`'s
`diffSettings(raw, inForce)` is a PURE comparison that repairs by rewriting each unusable value with the
one in force, reporting a keybind per ACTION and KEEPING keys the engine does not know (an older build
must not trim a newer file). `inForce` doubles as the schema. An UNREADABLE file is different: it is
copied to `config/settings.bad.json` and rebuilt from the values in force. The outcome goes to
debug.log and onto the loading screen (`loading.fixed` / `loading.unknown` / `loading.rebuilt` + the names),
which is also how it is tested by hand.

**There is no multi-core executor — the schedule is the scheduling HALF only.** It knows what may run
concurrently and `check:ecs` proves the grouping; the blockers are the DATA MODEL (record components are
JS objects a Worker can only clone; the voxel Map is not shareable), written out in ROADMAP §3.9.

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
3. **The pointer-lock/input race code in ecs/systems/input.ts is timing-sensitive**
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
- **A GPU/DOM object is a RESOURCE, not an argument** (`ecs/presentation.ts`). There is one scene, one
  camera, one renderer, one UI mount root and one chunk-mesh cache per world, and they do not die with
  an entity: that is the definition of a resource. They used to be constructor dependencies, which made
  the objects a system writes every frame the only shared state in the process with no owner — and the
  only way to learn who used one was to read main.ts. Now the composition root creates the object,
  inserts it, and each system resolves it in its constructor body (iron rule 6); a test drives a render
  system by inserting a stub. What is still NOT a resource and never will be: the objects a system
  BUILDS for itself (the block outline, the menu-background panorama scene, a baked icon canvas) —
  those die with their owner, and the DOM/GPU elements of a VIEW (an element, an SVG rubber band) are
  their view's business. The DECLARED TARGETS (`camera3d`, `chunkMeshes`, `framebuffer`) stay in the
  access sets: the schedule models names, not resource handles.
- **CONFIGURATION splits the same way, by whether it is READ ON THE TICK.** A setting that a system or
  the reconciler asks for every step/frame IS world state and lives in a resource (`KEYMAP` — read by
  movement/interaction/input every tick; `LOCALE` — the reconciler re-derives every widget's text from
  it every frame; `FONT`/`UI_SCALE`; `FPS_CAP`). A setting read only when its panel opens, or written
  only when it changes, is plain configuration and stays in its module (`windowMode`, `vsyncDisabled`,
  the settings FILE itself). Either way the config module owns the file and the validation, and the
  resource is the single owner of the value in force. `background.ts` and `blockregistry.ts` are
  neither: they derive their answer from the PACK CHAIN, which never changes after boot, so they are
  assets — the menu background kind is memoised because the menu frame asks for it every frame.
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
  cooldowns), INVENTORY (stacks + selected slot) and the PLAYER marker.
- Systems never import each other. Shared device/global state is a RESOURCE
  (`world.resource(INPUT_STATE)`, `LOCAL_PLAYER`, `VOXEL`); per-entity state is a component. That
  is the whole rule — if two systems need the same thing, one of those two is where it goes.
- **A system declares what it touches, in its own module** (`SNAPSHOT_ACCESS`, `MOVEMENT_ACCESS`,
  ... in `ecs/systems/*.ts`, spread into the registration in `main.ts`). Options: `reads`,
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
  the DOM to hide itself), and `ecs/ui/navigation.ts` is the ONE painter — it maps that state onto the
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
  (see `ecs/ui/system.ts`).
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
  shape into a widget surface. (`rendering/blockicons.ts` exports `clampIconSize`/`iconCacheKey` so
  the peek and the bake cannot disagree about what a cache entry is called.)

## Testing

There is no test runner: `node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` (strict,
zero errors) plus a MANUAL flythrough. **The click-by-click checklist — the startup screen and the
settings check, the world, the movement modes, every menu, the key binds, the inventory — is in
`docs/TESTING.md`**, together with what a failure at each step means. Read it before saying a change
works, and extend it when a behaviour lands.

**`npm run check:ecs` is the automated gate for the ECS** (`scripts/check-ecs.mjs`, 54
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
  and diagnostics declaring every external target it really touches.

Run it after touching the ECS, a component, a command, a resource, a recipe, a stage or any system's
access declaration. Some checks read SOURCE TEXT, so they strip comments first: a comment that
documents what a migration removed must not fail the migration.

For one-off experiments, `ecs/core/` is pure logic (no three.js, no DOM) and can be verified
standalone. The recipe that works in this repo — TS 7 needs `--ignoreConfig`, and the emitted
CommonJS needs a `{"type":"commonjs"}` package.json in its output directory because the repo root is
`"type":"module"`:

```
node ./node_modules/typescript/bin/tsc src/ecs/core/entity.ts src/ecs/core/component.ts \
  src/ecs/core/query.ts src/ecs/core/store.ts src/ecs/core/schedule.ts src/ecs/core/commands.ts \
  src/ecs/core/resource.ts src/ecs/World.ts --ignoreConfig --outDir .tmp/ecstest --rootDir src \
  --module commonjs --target es2022 --strict --skipLibCheck --types node \
  --lib es2022,dom,dom.iterable
```

then `require()` the output from a throwaway `.cjs` and assert. Delete `.tmp` when done. Keep `.tmp`
OUTSIDE `node_modules` and inside the repo, or `require("three/webgpu")` will not resolve.

That trick reaches further than `ecs/core/`: `components/Player.ts`, `commands.ts`,
`systems/snapshot.ts`, `systems/collision.ts` and `voxel/world.ts` also import no three.js, and the
VOXEL resource is only ever used through `isSolid()`. So the whole fixed lane can be REPLAYED in
Node — register the snapshot + collision systems on a real `VoxelWorld`, integrate a fake gravity
step between them, and assert where an entity lands. Wrapping the voxel in an object that counts
`isSolid()` calls turns "the sweep origin went stale" into a number, which is how the
local-player-only snapshot bug was pinned down.

## Pending work

Not here: the roadmap, the gaps, the deferred decisions and the debt backlog are in **ROADMAP.md**.
When work lands, move the entry here and delete it there.

## Known gaps (do not "fix" without asking)

- The voxel world has NO content: `generateChunk()` (voxel/world.ts) fills every chunk with a
  single block — no heightmap, biomes or ores. Breaking and placing DO work, but there is only
  ONE block type: placement always writes SOLID. `interaction.ts` reads the selected slot's type
  from INVENTORY (so the selection is real component data and the UI cannot disagree with it), but
  there is no per-value material or voxel palette to write it into yet. The mesher draws the
  built-in checker texture (CHECKER_TEXTURE_URL) instead of consulting blockregistry.ts, so mod
  blocks appear in the hotbar and not in the world.
- Chunk data is never evicted: the map can hold up to WORLD_CHUNKS_X * WORLD_CHUNKS_Z *
  CHUNK_Y_COUNT = 32 * 32 * 8 = 8192 chunks. A uniform chunk allocates NO array at all (see
  voxel/chunk.ts), so real memory is only the chunks a player actually edited — but raising the
  period, or making generation non-uniform, needs eviction first.
- `ecs/systems/interaction.ts` writes the outline transform (three.js presentation state) from
  the FIXED lane. Deliberate: it is the same tick that produced the raycast result.
- The scene has NO fog, so the rim of the streamed chunk window is visible as the edge of the
  world. Raise RENDER_RADIUS_CHUNKS (ecs/systems/chunkstream.ts) to push it out, or reintroduce a
  `scene.fog` — those two values were previously tuned as a pair.
- `input.ts` still carries `const top = NaN; // ... (was groundTop())` in its SPACE log. That is
  display-only and deliberately untouched (rule 3 territory); the real surface height is
  `VoxelWorld.topSolidY()`, used by ecs/systems/diagnostics.ts and the F3 panel.
- The torus is drawn by placing each chunk at its nearest representation, which is perfectly
  seamless while the world is uniform. Real terrain will need ghost meshes near the seam (or a
  much larger WORLD_CHUNKS period), otherwise the wrap will visibly snap.
- Inert remnants of the removed engine — dead code and stale comments, NOT bugs; do not
  "restore" or "fix" them: the main menu's world-type panel (`mainmenu.ts` gen panel plus the
  i18n keys main.genTitle/genSuperflat/genNoise; main.ts's `onStartSingle` logs `mode` and then
  discards it), and comments mentioning BlockWorld or the REMOVED chunk system (the new chunk
  system in voxel/ is unrelated). The hand-built loading overlay that used to sit here is GONE: it was
  replaced by the loading screen (`ui/loading.ts` + `LOADING_STATE`), and a world-entry preload belongs in
  that resource, not in an element built by the composition root.
- `ui/menu.ts` was rewritten around an explicit binding-interaction state machine (click
  shield + capture-free drag + physical capture, all documented at the top of the file).
  Still the densest file — the two shield-arm paths and the Esc-during-drag branch are
  load-bearing click-synthesis handling. Do not merge the arm paths. The GESTURE'S STATE is
  `KEYBIND_GESTURE` data now and the panels are derived by `ui.keybind`, so what is left here is the
  event-time half (which listener fires, when the shield arms) — and NOTHING ELSE: the rubber band is a
  widget whose geometry `ui.keybind` writes, and the pointer position comes from the `POINTER` resource,
  so this file creates no element and listens for no mousemove.
- **The low-level keyboard hook is INSTALLED BUT NEVER CALLED.** `rawinput.rs::esc_hook` gets a valid hook
  handle and its thread pumps messages, yet the probe line (`HOOKPROBE seen=…`, written to debug.log 4 s /
  8 s / 12 s after start) reports `seen=0` after dozens of keystrokes, with the foreground window confirmed
  to be our own process. So "swallow the key before Windows/Chromium sees it" **is not available in this
  environment**, and the ESC protection it was written for has never actually been active (harmless in
  practice: the native capture means there is no browser lock to escape). Anything that must have a key
  suppressed has to be done in the page or in a window procedure — do not build on the hook.
- **The menu/Apps key's one-frame cursor flash is a RACE we win, not a call we cancel.** Chromium treats that
  key (and Shift+F10) as "show a context menu" and REVEALS the system cursor for it; the reveal happens
  outside the page (WebView2/Windows), so `preventDefault` cannot stop it. `platform/window-guards.ts`
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
- Multiplayer is a placeholder button.
