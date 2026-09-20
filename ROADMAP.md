# ROADMAP.md — what is NOT built yet, and what was deliberately left alone

**Companion to `AGENTS.md`. Read both; they never overlap:**

| File | Answers | Rule |
|---|---|---|
| `AGENTS.md` | what the code **IS** today | treat as fact |
| `ROADMAP.md` (this file) | what the code is **NOT** | treat as intent, never as fact |

## How to use this file

1. **Nothing here is implemented** unless it says `DONE`. Never assume a feature exists because it
   is described here — grep for it in `src/` first.
2. Three kinds of entry, and they are not interchangeable:
   - **ROADMAP** — not built at all.
   - **GAP** — built, but incomplete or knowingly limited.
   - **DECISION** — deliberately not done. These have a reason. **Do not "fix" a DECISION without
     asking**; several of them look like bugs and are not.
3. ⚠️ marks work that touches race-sensitive code (`AGENTS.md` iron rule 3) or that can only be
   verified by running the game. Contract a human before touching those.
4. **When you implement something, MOVE it into `AGENTS.md` and delete it here.** A stale roadmap
   is worse than no roadmap: it makes you build what already exists.
5. Numbers come from measurements or from the code. Where a number is a measurement, the method is
   named so you can repeat it.

---

# 1. Where the project is right now

A Minecraft-style first-person sandbox on NW.js + three.js WebGPU, with a working **flat, editable
voxel world** and nothing else in it yet.

| Works today | Where |
|---|---|
| 32³ chunks, generated on demand, meshed face-culled, streamed around the player | `src/voxel/`, `src/rendering/chunkmesh.ts`, `src/ecs/systems/chunkstream.ts` |
| X/Z is a **torus** (period 32 chunks = 1024 blocks), seamless via nearest-representation drawing | `src/voxel/world.ts` (`nearestWrap`) |
| Y is **split**: `[0,128)` ground, `[128,256)` writable build space, bedrock below 0 | `src/voxel/world.ts` |
| AABB collision, sub-stepped per axis; player lands, walks, jumps | `src/ecs/systems/collision.ts` |
| Break (LMB) / place (RMB) through a 6-block voxel raycast, with a white target outline | `src/ecs/systems/interaction.ts`, `src/voxel/raycast.ts` |
| Three movement modes (walk / creative fly / spectator), fixed 120 Hz step + render interpolation | `src/ecs/systems/movement.ts`, `src/rendering/camera-view.ts` |
| Pointer lock, raw mouse input fallback, keybinds, inventory UI, 3 languages, settings | `src/platform/`, `src/ui/` |
| **Input is a scheduled system** (fixed lane, first): the DOM listeners decide every guard at EVENT time and queue a named INTENT (`key`/`look`/`motion`); `step()` writes CONTROL/VIEW/MOTION, so no gameplay component is written outside a system run and the schedule orders input against the controller/movement/collision that read it. It also OWNS the mouse-button listeners (a button bound to "inventory" publishes an edge and nothing else) and the 8 ms raw-input poll (`startRawPolling`, called once by `main.ts`) | `src/ecs/systems/input.ts` (`INPUT_ACCESS`) |
| A **pure ECS**: generation-checked entity handles, SOA typed-array columns, cached sparse-set queries, resources, deferred commands, a three-stage schedule whose declared order is verified at boot | `src/ecs/core/`, `src/ecs/World.ts` |
| The schedule also **derives parallelism**: systems declare access (components + external targets), `world.batchesOf(stage)` returns the groups that may run in any order, a stage whose systems touch the same thing without a declared edge throws at boot, and the grouping is logged as `SCHEDULE ...` | `src/ecs/core/schedule.ts`, `world.scheduleReport()` |
| The player's ENTIRE state is components — position, previous position, orientation, buffered view deltas, motion, control, body box, reach, interaction cooldowns, inventory (stacks + selection) and a zero-size PLAYER marker; its DOM view reconciles from that data once per frame | `src/ecs/components/Player.ts`, `src/ui/inventory.ts` |
| **UI modality is EXPLICIT**: every modal surface publishes its visibility into the `UI_MODAL` resource, and one gate (`canControl(devices, ui)`) takes the input away from the local player (its body keeps being simulated) — instead of six container booleans OR'd at five call sites. Which settings sub-page is up is the same resource (`UI_MODAL.settings`/`gen`), so no view keeps a visibility field of its own | `ecs/resources.ts`, `ui/menu.ts`, `ui/mainmenu.ts`, `ui/inventory.ts` |
| **UI NAVIGATION is a system, not a branch**: `ui.navigation` reads the same key/button EDGES (ESC, the inventory key, a mouse button bound to "inventory") and turns `UI_MODAL` into widget visibility — the ONE painter of the modal trees. ESC walks the sub-page ladder one rung at a time through a single shared mapping (`stepBackSettings`, which the Back buttons and both `goBack()`s also call), and the pointer-lock effects (unlock on open, relock on close) are edge-triggered from the state | `src/ecs/ui/navigation.ts` |
| A **UI WIDGET layer**: widgets are entities (`UI_TREE`/`UI_TEXT`/`UI_LOOK`/`UI_STATE`), prefabs (`spawnPanel`/`spawnLabel`) are the reuse unit, one system reconciles their DOM, and every colour/space/size is a `UI_THEME` token | `src/ecs/ui/`, `ui/hud.ts`, `ui/menu.ts` |
| The UI's **behaviour** is scheduled too, not just its data: the F3+F4 picker (`ui.picker`, driven by key EDGES the device layer publishes), the HUD toast (`ui.toast`, a wall-clock deadline in a resource, armed by the `ShowToast` command), the key bind panels + drag gesture (`ui.keybind`, panels derived every frame, gesture state in `KEYBIND_GESTURE`) and the modal navigation (`ui.navigation`) — the old `ui/gamemode.ts` class is gone, and the ESC if-chain that lived in `main.ts` is gone with it | `src/ecs/ui/picker.ts`, `toast.ts`, `keybind.ts`, `navigation.ts` |
| One-command build with a greppable verdict | `scripts/build-all.mjs` (`RESULT: OK / INCOMPLETE / FAILED`) |

**What it is NOT:** there is no terrain generator, no second block type, no saving, no entities
besides the player, no tests, and no planet/sphere/space anything.

---

# 2. ROADMAP — the planet voxel game

Ordered so that every stage is playable on its own. Do not skip: each stage fixes the coordinate or
orientation assumptions the next one depends on.

| Stage | Status | What | Entry point / note |
|---|---|---|---|
| **P0 ground** | `DONE` | flat world, chunks, collision, edit | `generateChunk()` in `src/voxel/world.ts` |
| **P1 terrain** | `TODO` | replace the uniform fill with a real (noise) generator | **`generateChunk()` is the ONLY place that knows what a block is.** Everything else asks `isSolid()`. Start here. |
| **P2 floating origin** | `TODO` | split coordinates into `int cell + float local`, render camera-relative, update by **delta only** | Must land **before** anything writes absolute world coordinates. The absolute-position writes are now funneled into ONE place — the `Teleport` command (`src/ecs/commands.ts`) — which is exactly where the cell/local split goes. Reference technique: [big_space](https://docs.rs/big_space/0.6.0/i686-unknown-linux-gnu/big_space/) |
| **P3 radial gravity** | `TODO` | `ORIENTATION.up` = local surface normal instead of the constant `(0,1,0)` | ⚠️ **Known blocker**: `src/ecs/systems/controller.ts` sums view deltas and applies them once per tick **because** `up` is constant. With a changing `up`, "sum then apply" ≠ "apply each". That optimisation must change in the same commit. |
| **P4 sphere + LOD** | `TODO` | cube-sphere quadtree; near = real voxels, far = heightmap | Do the sphere **after** P3; do LOD after the sphere looks right without it. |
| **P5 space layer** | `TODO` | several bodies, orbits, nested reference frames | Only possible once P2 exists. |
| **P6 seamless** | `TODO` | atmosphere, LOD hand-off, ships | Last. |

**Explicitly warned against** (this is the classic way these projects die): starting at P4/P5/P6,
or building a sphere before there is any terrain to put on it.

---

# 3. GAPS in what already exists

## 3.1 Terrain and content
- **GAP** `generateChunk()` (`src/voxel/world.ts`) fills each chunk with ONE value. No heightmap,
  no biomes, no ores, no caves. `TERRAIN_TOP_Y = 128` is a constant, not a function of x/z.
- **GAP** There is no decoration/population pass (trees, structures) and no place to hook one.

## 3.2 Blocks
- **GAP** Exactly one block type (`SOLID = 1` in `src/voxel/chunk.ts`). Placement always writes
  `SOLID`, so **which hotbar slot is selected does not matter yet** — `interaction.ts` reads the
  selected stack's type straight from the INVENTORY component (no UI callback, no mirrored copy),
  but there is nowhere to write it. Making selection meaningful = palette values in the voxel data
  + per-value material/UV selection in `chunkmesh.ts` + `isSolid()` accepting any non-AIR value.
- **GAP** The mesher draws the engine's built-in checker texture (`CHECKER_TEXTURE_URL`) and **never
  consults `src/blockregistry.ts`**. So mod blocks appear in the inventory and not in the world.
- **GAP** `BlockDef.hasMissingTexture` is written but **read by nobody** (`src/blockregistry.ts`).
- **GAP** Breaking is instant: no hardness, no progress, no drops, no sound, no particles.

## 3.3 World storage
- **GAP** `VoxelWorld.chunks` is **never evicted**. Capacity is bounded only by the torus period:
  32 × 32 × 8 = **8192 chunk slots**. Uniform chunks allocate nothing (see `chunk.ts`), so real
  memory is only the chunks that were actually edited — but raising `WORLD_CHUNKS_X/Z`, or making
  generation non-uniform, needs eviction first.
- **GAP** Edited blocks are **lost on exit**. `game/saves/` exists and is unused; there is no
  serialisation of `VoxelWorld` at all.
- **GAP** The dirty set (`takeDirty()`) is consume-and-clear with no persistence: if a caller drops
  it, that rebuild is lost silently.

## 3.4 Collision
- **GAP** AABB only. No step-up (you cannot walk up a 1-block step), no ladders, no water, no
  slopes, no entity-vs-entity.
- **GAP** `MOTION` records `onGround` and `vy`, but no wall/ceiling contact flags.
- **GAP** `maxSubstep` guards against tunnelling, but there is no sweep test — a future very fast
  mover (a projectile) would need one.
- **GAP** Nothing in the GAME is a second entity. `spawnMovable()` exists and is what `spawnPlayer`
  builds on, but no NPC/prop uses it yet, so the multi-entity paths (independent sweep origins,
  two bodies in one query, per-entity reach and cooldowns) are exercised only by the throwaway
  Node assertion suite. Trigger: the first NPC or dropped item.

## 3.5 Interaction
- **GAP** Reach is per-entity data now (REACH, spawn default `DEFAULT_REACH = 6`), but nothing can
  change it at runtime and `REPEAT_SECONDS = 0.18` in `interaction.ts` is still a module constant.
- **GAP** The outline is a plain unit cube; no per-block selection shape.
- **GAP** No entity interaction (no targeting mobs), no "use item" action, no sneak-to-place-against.

## 3.6 Rendering
- **DECISION** No `scene.fog`. Consequence: the rim of the streamed window
  (`RENDER_RADIUS_CHUNKS = 8` → ~288 blocks) is visible as the edge of the world. Fix by raising
  that radius, or by adding an atmosphere — not by silently re-adding fog.
- **GAP** All chunk meshes live in a **flat** window around the player: no LOD, no frustum-aware
  prioritisation (the build budget is spent near-first, which is a proxy for it).
- **GAP** `logarithmicDepthBuffer` is not enabled. Camera `near = 0.1, far = 5000`; planet scale
  needs reversed-Z or logarithmic depth.
- **GAP** Meshing runs on the **main thread**, budgeted to `MESH_BUDGET_PER_FRAME = 24` chunk
  rebuilds per frame. A Worker would violate iron rule 3 as written — see §4.

## 3.7 UI
- **GAP** The inventory's block selection has no observable effect in the world (§3.2). The stacks
  and the selection ARE component data now (INVENTORY, written only by `SelectSlot`/`SwapSlots`), so
  the ECS side is finished; only the world side is missing.
- **GAP** No crafting, no containers, no item stacks beyond a display count. Nothing moves items
  between slots except the backpack click, and nothing can pick an item up.
- **DONE — the widget layer covers EVERY surface.** `ui/hud.ts` (crosshair, F3 panel, toast),
  `ecs/ui/picker.ts` (the F3+F4 picker — it stopped being a view when it became a system),
  `ecs/ui/toast.ts`, `ui/menu.ts` (pause menu + the shared settings panel, the
  visual keyboard and the key bind gesture included), `ui/mainmenu.ts` and `ui/inventory.ts` all write
  component data now. Measured before → after, per file: `menu.ts` 45 → 0 colour literals, 60 → 0
  inline style writes, 60 → 2 `appendChild` (both the drag rubber band's SVG); `mainmenu.ts` 21 → 0 and
  47 → 0; `inventory.ts` 13 → 0 and 17 → 0. The invariants that replaced the hand-written ones are
  asserted by `npm run check:ecs` for every migrated surface: no colour literal, no element built by
  hand, no inline style string, no `display` as state.
  The two prefabs the migration needed are the ones that were missing: a CLICKABLE widget
  (`UI_ACTION` + the `UI_ACTIONS` dispatch table in `ecs/ui/actions.ts`) and a fixed-capacity list
  (`spawnList`). It also needed four primitives that no earlier surface did: a range slider
  (`UI_INPUT`), a per-widget layout string for the 104-key keyboard (`UI_LAYOUT`), an image slot with
  a data tint (`UI_IMAGE`) and a native tooltip (`UI_TIP`).
  What it deliberately did NOT absorb: the drag rubber band (an SVG pointer overlay whose geometry
  changes per mousemove), and `i18n`/`fonts`/`uiscale`/`background`, which are configuration rather
  than game state.
  ONE LESSON THE MIGRATION TAUGHT, because it will bite the next view too: a view writes DATA and the
  reconciler paints once per frame, so an intermediate state a view writes is a painted frame. The
  hand-written inventory got away with "write the fallback colour, then write the icon" because it
  wrote the DOM twice inside one task and the browser never showed the middle. The migrated one showed
  a solid square for one frame on every stack move — and the engine's registry colours made it look
  like a real item (green, grey). Fixed by giving the bake cache a SYNCHRONOUS reader
  (`peekBlockIcon`) so the view draws the final icon in one write, and by making the only placeholder
  the magenta/black checker, which reads as "no icon yet" instead of as an item. A future startup
  warm-up (bake every registry block once) would make the placeholder essentially unreachable; it is
  deliberately NOT done yet.
- **GAP** The i18n DICTIONARY IS NOT SHIPPED. `ui/i18n.ts` says the build packs `src/assets/lang` into
  `default.zip`, and `packs/*` carries 77 keys in three languages — but `src/assets` does not exist and
  `rearrange.mjs` produces no `default.zip`, so with no resource pack installed `t()` falls back to the
  KEY and the UI renders `menu.resume`. The mechanism (layered merge, en fallback, 0 used-but-undefined
  keys) is sound; only the deployment is missing. Trigger: any build that is expected to show text.
- **DONE** No surface reads its own visibility back out of `style.display` any more, and none keeps a
  visibility field of its own: a panel is a widget's `hidden` flag, "which modal surface is up" is
  `UI_MODAL.mainMenu/menu/inventory` and "which sub-panel is up" is `UI_MODAL.settings`/`gen`.
  `ecs/ui/navigation.ts` is the ONE painter of those flags, and the ESC ladder asks the DATA
  (`stepBackSettings`) instead of parsing CSS or calling a view method — that read is what made
  "first ESC after resuming from settings does nothing" possible in the first place.
  LESSON, because the first rewrite of this repeated the same class of bug: the ladder existed TWICE
  (the inlined ESC branch and the Back buttons), the copies disagreed, and the inlined one lost the
  middle rung — so ESC on the settings LIST was a no-op and ESC on a sub-page skipped a level. One
  mapping, called from ESC, both `goBack()`s and every Back button, is the fix; `check:ecs` asserts
  both halves of it.

## 3.8 Streaming architecture
- **GAP** No *budgeted background* lane. There are three stages now — fixed (120 Hz), render (per rAF)
  and ui (per frame, and per rAF pump while the game loop is stopped) — but streaming and meshing
  still ride the render stage, so a chunk budget competes with the draw in the same frame. Real
  terrain will want a lane that spreads meshing across frames with an explicit budget.
- **DONE (was the cause of a real regression)** The ui lane exists because MENU mode stops the
  fixed AND render stages, and the MAIN MENU is the one state where the loop is stopped and the user
  still clicks things. Keeping the DOM reconcilers in the render stage meant a toast raised from the
  main menu wrote component data nothing ever reconciled. `world.renderUi()` (barrier + ui stage) is
  pumped by `main.ts` while the loop mode is "menu". Any future DOM writer belongs in that lane —
  the assertion suite enforces it for every system declaring a `dom.*` target.
- **DONE — the loop state is one MODE, and the loop is ONE CHAIN.** `main.ts` used to have
  `stopLoop()`/`startLoop()`, where stopping had the SIDE EFFECT of starting the ui pump and starting
  then had to undo it two lines later, plus a `started` boolean and a `timerId` that nothing ever
  assigned. It became `loopMode: "load" | "game" | "menu"` (renamed from `"boot"` once a world entry
  used the mode too) with ONE idempotent transition
  (`setLoopMode`); "are we playing" is derived (`inWorld()`), and every call site names the state it
  wants (boot / entering a world / back to the main menu). The THREE rAF chains (game loop, ui pump,
  panorama) are now ONE `frame()` that dispatches on the mode — `renderFrame()` for "game",
  `renderMenuBackground()` + `world.renderUi()` for "menu" — started once by calling `frame()` at the
  end of the file and re-armed by itself, so there is nothing to start, stop or cancel and a mode
  transition cannot half-stop a loop. `check:ecs` asserts exactly one `requestAnimationFrame`, no
  `cancelAnimationFrame`, one writer of `loopMode`, and a frame body that dispatches on it.
- **DONE — the frame cap has a home.** It was `let fpsCap = 0` inside `main.ts`: read by the frame
  gate EVERY frame (so world state) and written by the settings panel, yet never persisted — and
  because the slider initialises from `getFpsCap() || CAP_MAX`, a relaunch silently showed
  "unlimited" as if the value had never been set. It is now the `FPS_CAP` RESOURCE
  (`ecs/resources.ts`), with a sanitising factory (a hand-edited settings.json cannot produce a NaN
  or negative budget); `main.ts` loads it at boot, the gate and `diagnostics` read it from the World,
  and `onFpsCap` writes it back through `saveSettings()` — now through the `SetFpsCap` COMMAND, since
  assigning a resource from a UI callback was the last world value changed outside a system run. That
  deferral has one trap, hit and fixed: the settings panel's cap LABEL is a push refreshed on the drag
  event, so re-reading the resource inside the handler printed the PREVIOUS drag step and stayed wrong
  until the panel was reopened (the reported symptom: "the FPS number is not accurate while sliding"). The handler now hands the value to
  `renderCap(cap)`, and `check:ecs` asserts the hand-off. Two lessons: the F3 line and the loop gate
  disagreed with the *setting* the moment they read different sources, and "a setting that gates the
  loop" belongs with the world, not with the config singletons
  (`i18n`/`fonts`/`uiscale`/`background` are read on CHANGE, this one is read per frame).
  THIRD, found right after: **the value's DOMAIN belongs to the sanitiser, not to the panel.** A
  hand-edited `fpsCap: 1` loaded as 1 while the slider sat at 30 (it snapped the value into its own
  range) and the label said "1 FPS", and the first drag replaced the 1 silently. A stored value the
  widget cannot express is not a legal value: `CAP_MIN/CAP_MAX/CAP_STEP` now live in
  `ecs/resources.ts` (the panel imports them instead of restating them) and `sanitizeFrameCap` clamps
  AND snaps into them — `1 -> 30`, `300 -> 0` (the slider's TOP means unlimited), `59 -> 60` — so the
  invariant "the label and the slider always show the same thing" holds by construction. `check:ecs`
  sweeps inputs through `snapToRange` with that domain and asserts it is a no-op.
- **DONE — a widget's value can be BOUND, not owned.** Making the cap a resource fixed "who owns the
  number" but not "who owns the COPY": each settings panel had built its own slider and pushed its own
  value into it, so the two could show different numbers (and the one you touched won). `UI_BIND
  { source }` + `UI_SOURCES` (a table of getters) + `UiBindingSystem` (ui lane, before the reconciler)
  make the shared state the only owner: the widget declares WHERE its value comes from, the resolver
  snaps it to the widget's own range and writes the component, the reconciler draws it. It is the same
  shape the F3 panel already had (a system writes the widget data, the reconciler renders), promoted
  from a hand-written call to a declaration. Also fixed alongside it, and it was MY regression: the
  reconciler never wrote a slider's `min`/`max`/`step`, so every slider was a browser-default
  0..100 step-1 input (the FPS cap's right end read 100, it moved in ones, and the label's
  "unlimited" case — value >= the surface's max — was unreachable). Both are asserted now: the
  element's range must come from the component, and a bound value must land on the widget's grid.
  REUSE NOTE: bind any future widget that mirrors state another surface also shows (volume, view
  distance). Do NOT bind a FORMATTED string — the label around a bound slider stays a push, refreshed
  when its panel opens.
- **DONE** The backpack no longer stops the loop, and no longer stops PHYSICS either. It releases the
  mouse and takes the local player's INPUT away (`canControl()` false → `controller`/`interaction`
  skip it; `movement` ignores its keys but keeps integrating gravity and its carried velocity, so an
  airborne player falls and lands instead of hanging in mid-air) while the world keeps streaming,
  simulating and drawing behind the panel; NPCs keep moving, F3 keeps updating. Its own commands were
  the other symptom of the stopped-loop bug and now ride the ordinary frame barrier.
  The rule this settled: **a modal UI removes INTENT, not PHYSICS.**
- **DONE — the STARTUP has a face, and it is the only reason `"load"` has a frame body.** The manifest
  creates the window hidden and the OLD boot order revealed it only AFTER `await renderer.init()` —
  so the GPU handshake, the spawn window's generation and the first ~100 frames of chunk meshing all
  ran behind a hidden window and the startup was a black rectangle for as long as it took. The window
  is now revealed by the boot driver as soon as the startup screen is PAINTED, and the slow work runs
  behind it: `loading.settings` → `loading.gpu` → `loading.ready`, each stage announced through
  `SetLoadingStage` before its own work (the world's generation and meshing moved out of the startup
  later — see the entry below, and their stages are `world.*`). Two things made that possible and are
  now load-bearing: (a) the `load` mode pumps the ui LANE (`loadFrame()` = `world.renderUi()`), because
  the loading screen is widget data and the render lane cannot run before `renderer.init()`; and (b)
  the per-stage yield is a `setTimeout` MACROTASK, not a second `requestAnimationFrame` chain — the
  process still owns exactly one, which `check:ecs` asserts. The screen is `LOADING_STATE` (a resource)
  + `ui/loading.ts` (the tree) + `ecs/ui/loading.ts` (`ui.loading`, the painter, first in the ui lane):
  main.ts builds no element, which is why the hand-built "loading overlay" that had been left in the
  file as a remnant is finally gone. `chunkStream.warmUp` rides the same stages and meshes the WHOLE
  spawn window before the menu appears, so the world no longer streams in over the first seconds and
  entering a world needs no screen of its own.
- **TRAP, found by the user the same day:** the screen is only painted while `LOADING_STATE.active` is
  true (the tree is spawned hidden), and the first build of the driver never SENT `active: true` —
  it only sent `active: false` at the end, which was a no-op. The startup was therefore a black page
  with the CROSSHAIR and the HOTBAR on it (the HUD widgets are visible by default and the opaque
  screen that should have covered them never appeared) until the main menu painted. `check:ecs` now
  asserts that the driver activates the screen before it reveals the window; the system-level group
  had passed all along because it drives `ui.loading` with its own `active: true`, i.e. it tested the
  painter and not the driver. Lesson: for a screen that is data, assert the WRITER of the data, not
  just the reader — the two halves can be individually green and jointly dead.
- **DONE — the world is BUILT ON ENTRY, behind the same loading screen.** The startup used to do it
  (the entry above): it paid ~1.6 s of the measured 2.0 s boot for a world the user might never enter,
  and it left "entering a world" with nothing to wait for — so the screen it had just gained had nothing
  real to show there. Now `boot()` stops at the main menu (settings → GPU → ready, ~0.45 s) and
  `enterWorld()` runs `world.spawn` → `world.terrain` (`chunkStream.prime`) → `world.chunks`
  (`chunkStream.warmUp`) → `world.ready` behind the screen, then hands the mode to `game`. Two
  details that are load-bearing: the Teleport goes through the barrier BEFORE the warm-up (the system
  reads POSITION to pick the window), and a RE-entry into a window that is still built skips the screen
  entirely (`chunkStream.needsWarmUp`) rather than flashing it for one frame. The gate asserts both
  halves — `boot()` contains no `chunkStream` call at all, and the entry driver does the building.
- **DONE, and it closed a latent bug:** `ui.navigation` refuses the two IN-WORLD actions (ESC opens the
  pause menu, the inventory key opens the backpack) unless `inWorld()` — injected, so the system stays
  DOM-free. Those branches had no notion of "a world is running": with a loading screen up for seconds
  (the startup, then every world entry) ESC opened the pause menu OVER the screen and E opened the
  backpack behind it.
- **DONE — the vocabulary is `load`/`loading` everywhere.** The mode was renamed first (`"boot"` →
  `"load"`, because it serves world entry too); the SCREEN's own names followed: `BOOT_STATE` →
  `LOADING_STATE`, `SetBootStage` → `SetLoadingStage`, `ui.boot` → `ui.loading`,
  `ui/boot.ts`/`ecs/ui/boot.ts` → `.../loading.ts`, the `boot.*` theme recipes → `loading.*`, and
  the seven i18n KEYS → `loading.*`. **The key rename is the one PACK-VISIBLE part**: a resource pack
  that overrode `boot.*` in its `lang/*.json` no longer matches and silently falls back to the engine's
  text (dictionaries merge across the pack chain by key, and `t()` falls back English → key), so a pack
  author has to move those keys. Nothing else about the rename is visible outside the engine.
- **DONE — GAMEPLAY UI is gated to a running world.** The crosshair and the hotbar were spawned VISIBLE
  during wiring and no system ever wrote their flag, so they were on screen in every mode: at the main
  menu (through its translucent backdrop), behind the loading screen, and OVER the pause menu — the
  hotbar's z-index (31) is above that menu's whole root (30), so it drew on top of the panel, with its
  slots still clickable (a menu click could change the selected slot). `ui.picker` was worse in kind: it
  had been DESIGNED to work at the main menu ("F3/F4 work at the main menu too", which this file used to
  state as a feature), so F3 opened the F3 panel there — with STALE text, because its numbers come from
  the render lane, which does not run in menu mode — and F3+F4 applied a `SetMode` COMMAND, i.e. wrote
  the player's mode component from a menu. There was no gate for "may this UI be up at all"; the only one
  in the engine, `canControl()`, answers what the MOUSE does. Fix: one new system, `ui.hud` (first in
  the ui lane, `writes: [UI_STATE]`), owns the crosshair's and the hotbar's visibility from
  `inWorld()`; `ui.picker` takes `inWorld` as a dep, consumes the edges and does nothing outside a
  world, and takes its own panels down (clearing the chord state) so a game session's UI cannot outlive
  it. The TOAST stays ungated on purpose — a main-menu message is the case that made the ui lane
  necessary. `check:ecs` drives both gates on a real World, in and out of a world.
- **DONE — the settings FILE is validated at boot, repaired and written back.** Each config module
  already ignored a value it could not use and fell back (`loadLang` outside zh/en/ja,
  `sanitizeFrameCap` for `fpsCap: 1`, `loadBinds` for an unknown code) — right at LOAD time, but it
  left the FILE disagreeing with the value in force, unreported, forever (the previous entry's
  `fpsCap` bug was one instance of it). `platform/shell.ts` now has `readSettingsChecked()` (which
  tells "no file yet" from "unusable file"), `diffSettings(raw, inForce)` — a PURE comparison that
  repairs each unusable value with the one in force, per ACTION for a keybind, KEEPING keys the engine
  does not know — and `backupSettingsFile()`. A file that cannot be parsed is copied to
  `config/settings.bad.json` and rebuilt from the values in force. The outcome is logged AND shown on
  the loading screen (`loading.fixed` / `loading.unknown` / `loading.rebuilt` + the setting names), which is
  what makes it testable by hand. `inForce` doubles as the schema; `check:ecs` asserts the repair
  rules and the wiring.

## 3.9 ECS core (`src/ecs/core/`)
Everything here is a **deliberate omission with a trigger**, not an oversight — each one is
unused machinery today, and unused machinery is what makes a codebase unreadable.
- **GAP** No **change detection** (`Changed<T>`). The store tracks `structuralVersion` only, so a
  system cannot ask "what was written since tick N". Trigger: incremental sync (network
  replication) or a render-extract pass. Note the constraint: SOA writes go straight into typed
  arrays, which the store cannot observe, so this needs either explicit `markChanged` calls or
  wrapper accessors — a real API decision, not a flag.
- **GAP** Queries are **`all` only** — no `without` / `any` filter. `world.query(A, B)` is the whole
  API. Trigger: the first "everything except X" rule (e.g. an NPC system that must skip the local
  player).
- **GAP** No **events**, but the shape that works is now proven twice. The one cross-system signal the
  game actually had (view deltas) became a component (`VIEW`), the shared device state became a
  resource (`INPUT_STATE`), and the first real EVENT arrived with the F3+F4 picker: key EDGES are
  published into the `KEY_EVENTS` resource by the device layer (a held-key `Set` cannot say "F3 went
  down just now"). The second consumer — `ui.navigation`, for ESC and the inventory key — turned it
  from a queue into a READ-ONCE-PER-CONSUMER channel: every reader holds its own `KeyEdgeReader`
  cursor and sees every edge exactly once, in order, and the producer bounds growth at
  `KEY_EDGE_CAP = 64` so a world with no consumer cannot leak (a burst older than the cap is dropped
  whole, never half-applied). What is still missing is a general API: this log is hand-rolled, has ONE
  writer (the device layer) and a fixed cap, and a consumer that stops draining just misses edges.
  Trigger: a signal with many writers, or one that must be queryable rather than consumed.
- **DONE — a pure ORDERING edge is honoured in EITHER registration order.** It used to work only when
  the declaration happened to be registered in topological order: `Schedule.build()` built its adjacency
  in REGISTRATION order, and the conflict verification and the batcher then indexed that same array by
  RESOLVED position. As soon as Kahn's sort MOVED one of the two systems, the edge pointed at the wrong
  pair, the batcher's self-check fired (`"a" must run before "b" but was batched no earlier` — a message
  that also read backwards for an `after` declaration), and the only workaround was "register a system
  before anything that points at it". The adjacency is remapped into the resolved space once, right after
  the sort, so the DECLARATION alone decides the order — and a conflict-free edge splits the batch by
  itself. `check:ecs` pins both orders, `after` and `before`, with and without a data conflict. The
  earlier diagnosis ("the batcher cannot express a pure ordering constraint; make it split on edges too")
  was imprecise: it already split on them, it was reading the wrong graph.
- **GAP** No **archetype storage**. Columns are global typed arrays indexed by entity INDEX
  (sparse-set / EnTT model), so attaching a component never moves another entity's rows, and
  queries iterate only matching entities. Trigger: hundreds of simultaneously-updated entities
  AND a profile that blames iteration locality. Revisit with a benchmark, not by intuition.
- **GAP** No multi-core **EXECUTOR**. The *scheduling* half ships: systems declare access (components
  and external targets), `world.batchesOf(stage)` returns the groups whose members may run in any
  order, a dependency that is not declared throws at boot, and the grouping is logged as
  `SCHEDULE ...`. What is missing is something that actually runs a batch's members at the same time.
  Prerequisites, easiest first:
  1. **Non-ECS state must not be shared inside a batch.** The render stage's 3-member batch
     (`cameraView.render ~ chunk.stream ~ diagnostics`) is safe because their targets are distinct —
     which the declaration records. Two writers of the same one would now throw at boot instead of
     racing. The ui stage's 2-member batch (`ui.inventory ~ ui.bindings`) leans on the same property:
     disjoint components, and neither writes the DOM (the reconciler is a later batch).
  2. **RECORD components are JS objects** (MOTION/CONTROL/INVENTORY). A Worker gets a structured
     *clone*, so component identity — which systems cache for their whole lifetime (iron rule 2) —
     would silently break. This is the real blocker: a record-free system, or records reduced to SOA,
     is the change that unlocks everything else.
  3. **The voxel Map** (`VoxelWorld.chunks`) is read by collision and interaction in the fixed stage.
     A worker needs a flat shareable snapshot of the chunk bytes.
  4. **Cost check before building it.** `motion.snapshot` and `player.controller` are the only pure
     numeric kernels and they are a few float operations over ONE entity: a message round-trip costs
     more than the work. Trigger: hundreds of simultaneously-updated entities, or a system whose
     per-tick cost actually shows up in a profile.
- **GAP** The schedule has no **run conditions** or "every N ticks" systems: the fixed stage is
  120 Hz for everything in it.
- **GAP** Entity handles are **23-bit index + 8-bit generation** (`core/entity.ts`): 8,388,608 slots
  over the process lifetime, and a slot needs 256 recycles before an ancient handle could collide
  with it again. Trigger: raising either, or a long-lived session that recycles one slot thousands
  of times.
- **GAP** `Store.bind` assumes **one World per process**: component DATA lives on the process-global
  definitions, so a second World would see the first one's rows and a freshly spawned entity would
  report "already carries position". `claimComponent()` turns that into a startup error instead of
  silent corruption — which is also why a multi-World test has to define its own components.
  Trigger: a second world (a test fixture, a preview scene) needs the columns moved into the store.

## 3.10 What is still NOT ECS (the honest inventory, measured)

Written down because "is everything ECS now?" is a question that deserves a list rather than a
feeling. Method: summed `(Get-Content <file>).Count` over `src/**/*.ts` (every line, blank ones
included; `Get-ChildItem -Recurse -File -Include *.ts -Path src`). `main.ts` holds **0
`addEventListener`, 1 `requestAnimationFrame`, 0 `setInterval`** — the window guards
(`platform/window-guards.ts`, 6 listeners), the ONE resize listener (`platform/viewport.ts`) and the bind
gesture's five (`platform/bind-gesture.ts`) are device-layer modules now (they used to be the composition
root's), and the RECONCILER owns six listeners on the UI MOUNT ROOT rather than six per widget (delegated,
§5.2 P1.11). The process has **0 `setInterval`**: the last one was the 8 ms raw-mouse poll, removed in
P1.11; what is left is four `setTimeout`s (the boot macrotask yield, the log flush, the drag's click-shield
fallback, a short cursor re-assert).

**GROUP A IS DONE** (the five rows that used to be here, each moved into `AGENTS.md`):
the loop is ONE rAF chain whose body the mode picks; the frame cap goes through the `SetFpsCap`
command; `INPUT_STATE.clickLockAllowed` is gone (the input system derives it from UI_MODAL);
the surfaces' callbacks write config + commands, never widget or world state directly; and the
mutable config (language, font, UI scale, bind table) lives in the LOCALE/FONT/UI_SCALE/KEYMAP
resources with declared readers. `check:ecs` asserts every one of those (its LOOP STATE, FRAME CAP
and CONFIGURATION RESOURCES groups), and now also the STARTUP SCREEN and SETTINGS CHECK groups added
with the boot screen (§3.8).

What is left is the two smaller buckets below.

**B. Deliberate non-ECS (a DECISION, do not "fix"):** the pointer-lock and raw-input LOGIC stays in the
event-time listeners (its STATE is the INPUT_TIMING resource — §5.2 P1.8), and so does the BIND GESTURE's
event-time half: the click shield's two arm paths, the drag's mousedown/mouseup, the wheel block and the
key-capture handler (§5.2 P1.9) — every one of them a decision that can only be taken inside the event that
must be cancelled; what a system BUILDS for itself — the block outline, a baked icon canvas — is its own
object rather than a resource; the
config modules own the FILES while their VALUES live in resources — and
the global style applies itself nowhere any more (`fonts`/`uiscale` publish the font pair and the root
font size, and the RECONCILER writes them, diffed per frame); `windowMode`/`vsyncDisabled` stay
plain config because nothing reads them on the tick (the DIAGNOSTIC-LOG switch is another one: it is read by
the log sink, not by a system). The UI EVENT LAYER is delegated rather than per-widget (§5.2 P1.11), and the
raw-mouse look is accumulated at event time and applied ONCE PER FRAME — both are "one owner, one place"
choices, not leftovers.
The rows that used to sit here are gone: the three.js/GPU/DOM objects, `VoxelWorld` and the chunk mesh
cache are RESOURCES (§5.2 P1.7), the input race guards' state is too (P1.8), and the window listener, the
menu background, the diagnostics dependencies and the view's DOM listeners went the same way (P1.9).

**C. Inert leftovers** (dead code and stale comments, NOT bugs — §4): the main menu's world-type
panel, and the unused `centerCursor` export in `platform/shell.ts` (the live one is in `platform/rawinput.ts`;
`wasMaximizedBeforeFullscreen` left this list when the fullscreen path stopped needing it).
(The hand-built loading overlay used to be on this list; the startup screen replaced it, §3.8.)

---

# 4. DECISIONS — deliberately not done (do not "fix" without asking)

| Decision | Why it is intentional |
|---|---|
| No fog | asked for explicitly; the visible world rim is the accepted cost |
| One block type | content work was explicitly out of scope; the palette is already per-voxel |
| Chunk data never evicted | the torus period bounds it; uniform chunks cost nothing |
| `eval("require")` in `shell.ts` / `rawinput.ts` / `textures.ts` | a plain `require`/import is externalised to `{}` by vite and `fs` becomes undefined at runtime. Load-bearing. The bundler warns; the warning is expected. |
| `const top = NaN` in `input.ts`'s SPACE log | display-only, inside the race-sensitive file. The real surface height is `VoxelWorld.topSolidY()` |
| Dead remnants left in place (main-menu world-type panel, comments naming `BlockWorld` / the removed chunk system) | inert; removing them is churn without behaviour change. Superseded by §3 if the UI is ever reworked |
| No test runner, no CI | the verification loop is `tsc` + a manual flythrough (`docs/TESTING.md`, §6) |
| Single-threaded state (iron rule 4) | the only sanctioned extra thread is the raw-input plugin's collector |
| `hasMissingTexture` unread | the field is a placeholder; the mesher culls by geometry, not by this flag |
| No `Changed<T>` change detection in the ECS | nothing reads it; SOA writes bypass the store, so it is an API decision (see §3.9), not a missing flag |
| No general event channel in the ECS | the signals that existed became a component (`VIEW`) and a resource (`INPUT_STATE`), and the one real EVENT stream (key/button edges) is the bounded `KEY_EVENTS` log with ONE writer and per-consumer cursors — enough for the two readers it has (`ui.picker`, `ui.navigation`), and a general channel stays unbuilt until something needs more than "every reader sees every edge once" (see §3.9) |
| Global sparse-set columns, not archetypes | structural changes must never move another entity's data; archetype locality is unmeasurable at 1 entity and is a benchmark-first change |
| No multi-core executor — only COMPUTED batches | iron rule 4, and the blockers are the data model (record components are JS objects a Worker can only clone; the voxel Map is not shareable), not the schedule. The declared access sets, the boot-time dependency check and `scheduleReport()` ship; see §3.9 for the prerequisites |
| ECS column memory is never shrunk | `grow()` doubles and `despawn` keeps the allocation, so a burst of entities permanently raises the floor. Bounded (a few 100 KB) and simpler than reference counting |
| Camera, HUD, renderer and perf samplers stay constructor dependencies, never components | they are GPU/DOM objects with methods, and component data must be plain; a component would be a copy that has to be re-synced every frame |
| `VoxelWorld` stays a RESOURCE, never a component | it is ONE world, not per-entity state. It is also written from both lanes (fixed: interaction, render: chunkstream), and "one owner, nameable" is exactly what a resource buys |
| Pointer-lock / raw-input timing stays system fields (plus the INPUT_STATE resource) | a keyboard and a lock are DEVICE state, not entity state. Moving those fields is a rule-3 job (replaying the races), not a purity job |
| `chunkstream`'s mesh cache stays system state | GPU resources and meshes are not entity data |
| `PLAYER` is a zero-size marker (`defineComponent("player", {})`) | it asserts membership; giving it a field would invent data nothing reads |
| No generic `Bundle`/`Prefab` type | `attachMovable`/`spawnMovable`/`spawnPlayer` ARE the composition point, and the per-system queries stay exact instead of being widened to a shared bundle. A bundle abstraction earns its place when a second kind of prefab appears (a dropped item with physics but no control frame, say) |
| An entity missing `PREV_POSITION` is skipped by collision, not swept | the sweep needs an origin it can trust. Skipping makes the failure loud (the entity falls through the world) instead of subtle (it jitters and lags behind a stale origin). `attachMovable` attaches it, so the only way to hit this is to hand-roll an entity |

---

# 5. LLM-facing debt (make the code harder to misread)

## 5.1 Naming that still misleads
Already unified and **must not drift back**: `logDebug` / `appendDebugLog` (they write
`logs\debug.log`; the names now say so), `isGpuVsyncDisabled` / `setGpuVsyncDisabled` (`true` means
vsync is OFF), `DebugInfo.chunks` + the `f3.chunks` i18n key (the value is a **chunk** count),
`BlockDef.hasMissingTexture`, `ChunkGeometry.rebuild()` (vs `Chunk.fill(value)`), and `fps` → `input`
where it meant the input system.

Still outstanding:

| Name | Problem | Risk |
|---|---|---|
| ~~`applyCursor()` (`platform/pointerlock.ts`)~~ | ~~also writes `input.clickLockAllowed` — a hidden second effect~~ **RESOLVED**: it only sets the cursor now | — |
| ~~`clickLockAllowed`~~ | ~~really means "no UI is open", not "clicking may grab the lock"~~ **RESOLVED**: the field is gone; the readers ask `isModalUi(UI_MODAL)` | — |
| `freeMouseActive` | the cursor is HIDDEN in that mode; it means "Chromium cancelled the lock and the window is partly offscreen" | ⚠️ rule 3 |
| `rawTakeoverActive` (`input.ts`) | a **log de-duplication flag**, not the takeover state; the state is computed on demand | low |
| `MODE_NAMES` (`components/Player.ts`) | `walk → "Survival Mode"`; used by exactly one log line, while the UI uses i18n `mode.*` | low |
| `mode` | three unrelated meanings: `MoveMode`, `WindowMode`, `MenuBgMode` | low |
| `World` vs `VoxelWorld` | the ECS and the block world; the ECS holds it as the `VOXEL` resource, while `voxel/world.ts` keeps its own name | low |
| `WORLD_MAX_Y` | the **writable limit** (256), not the visible top (128) | low |
| `SKIN` (`collision.ts`) | the contact epsilon — "skin" also means mesh skinning | low |
| `empty` (`chunkstream.ts`) | chunks that produced **no geometry**, which includes fully enclosed solid ones | low |
| `enterWithLoading()` / `genPanel` / `WorldGenMode` | name promises loading / world generation that do not exist | low, but see §4 |
| `BUILTIN_NAME = "default.zip"` (`textures.ts`) | a **live code path** looking for a pack the build no longer produces; same fiction in `blockregistry.ts` and `i18n.ts` comments | medium |

## 5.2 Make the implicit explicit (ranked; `AGENTS.md` iron rules still hold)
- **P0 — guard rails first.** `PARTLY DONE`: `scripts/check-ecs.mjs` (`npm run check:ecs`) is now the
  automated gate for the ECS itself — it compiles the ECS plus the fixed lane and asserts the
  invariants that only existed in comments and doc prose (entity-handle staleness, recycled rows,
  record identity, query-cache invalidation, the one-World rule, command deferral, the batch
  grouping, the undeclared-dependency error, and the commutativity of a batch). Still outstanding:
  `tsconfig` `noUnusedLocals` + `noUnusedParameters` (it would immediately expose `refreshIcons()`
  and `wasMaximizedBeforeFullscreen`), and the remaining TEXT assertions for things outside the ECS —
  `KB_ACTIONS` must cover every `BindAction`, `PHYS_DT × 12 === delta cap`, `panelCss` must still
  contain `display:none;`.
- **P1 — order assertions.** `DONE`. Systems carry a `name` and declare `after`/`before`;
  `world.start()` sorts each stage, verifies the result, and throws on a cycle, an unknown label or
  a violated constraint. The scheduler also throws if a system changes component structure
  (the barrier invariant, iron rule 1).
- **P1.5 — UI modality.** `DONE`, and the last view-local copy of it is gone too. "Does a UI own the
  mouse" used to be six container booleans OR'd at five sites in `main.ts`, folded through
  `pointerlock.applyCursor()` into `INPUT_STATE.clickLockAllowed`, which denied control only
  indirectly. It is now one `UI_MODAL` resource that each surface publishes into
  (`Menu.show/hide`, `MainMenu.show/hide`, the inventory toggle/key/mouse-binding via
  `ui.navigation`) and one gate, `canControl(devices, ui)`. That also closed a one-frame window in
  which the player stayed controllable between `prepareUnlock()` and the asynchronous
  pointerlockchange with the menu already up. What was "still view-local, on purpose" in the first
  version of this entry — the sub-panel `style.display` flags, `hud.debugVisible`, `gamemode.sel`,
  `Inventory.open` — is now DATA: `UI_MODAL.settings`/`gen` for the sub-pages, the F3 panel's own
  `UI_STATE` for the debug panel, `PICKER_STATE` for the picker, `UI_MODAL.inventory` for the bag,
  and `ui.navigation` is the ONE painter of the modal trees (a surface's `show()` is a data write).
  The one thing this entry still claims as deliberately non-ECS is the four CONFIG singletons
  (`i18n`/`fonts`/`uiscale`/`background`) — configuration is not game state, and turning it into
  resources would drag a World handle into pure helper functions.
- **P1.6 — the UI is DATA.** `DONE`. A widget is an entity (tree/text/recipe/state/action), prefabs are
  the reuse unit, ONE system reconciles the DOM, and every colour is a `UI_THEME` token — so the answer
  to "make the UI reusable" stopped being "copy the button's style string a third time". Three side
  effects worth naming: a language switch needs no `onLangChange` subscription for anything a KEY can
  express (the reconciler re-derives it every frame — only labels composed from a value, "60 FPS",
  "1.25x", are still pushed); moving the F3 panel's text into a component first made `diagnostics` and
  `ui.widgets` conflict; and migrating the INVENTORY turned an accidental independence into a real one
  — it writes widget data the reconciler reads, so the schedule now demands `ui.widgets` after every
  widget-data writer.
  The ui lane has since grown to SEVEN systems, so the numbers in the first version of this entry are
  stale: today it reports `7 systems, 6 batches, 1 parallel pair(s)`. The pair is `ui.inventory ~
  ui.bindings` (disjoint components); `ui.picker | ui.toast | ui.keybind | ui.navigation | ui.widgets`
  follow in that order. The chain is a deliberate PESSIMISATION — the conflict model is per COMPONENT,
  so systems writing different widgets' `UI_STATE`/`UI_TEXT` must still be ordered — and it is cheap
  (a handful of record writes each). `ui.navigation` runs LAST of the writers because it is the only one
  that turns `UI_MODAL` into widget visibility, and it is REGISTERED before `ui.widgets` because a
  forward ordering constraint breaks the batcher (§3.9).
  The migration's one real regression is worth recording, because the shape of it will recur: a
  reconciler in the render lane stops when the game loop stops, so migrating a surface that the user
  touches in a STOPPED state (main menu, backpack) silently removes its behaviour. That is what the ui
  lane and the `dom.*`-writer assertion exist to prevent.
  What is left is not a surface: §3.7 lists the drag rubber band and the four config modules.
- **P1.7 — the presentation objects became RESOURCES.** `SCENE3D`, `CAMERA3D`, `RENDERER3D`,
  `PERF_SAMPLER`, `CANVAS_HOST` (`index.html`'s `#app`), `UI_MOUNT` (the widget mount root) and
  `CHUNK_MESHES` (the chunk-mesh cache: parent group, meshes and the "no geometry" set, built by
  `createChunkMeshCache(group)`) used to arrive as CONSTRUCTOR ARGUMENTS — the only shared state in the
  process with no owner, and the reason a system could not be constructed by a test. They are world state,
  so the composition root INSERTS them (`ecs/presentation.ts`) and each system resolves what it uses in its
  constructor body. The access declarations still name the objects as external targets (`camera3d`,
  `chunkMeshes`, `framebuffer`) — the schedule models those NAMES, not the resource handles — so no
  ordering changed. What it bought: the chunk stream keeps no private mesh cache, `diagnostics` takes NO
  constructor arguments (its sampler, renderer, voxel world, log sink and F3 panel are all resources), the
  device layer takes its canvas from `RENDERER3D.domElement` (the element the pointer is locked to IS the
  element the GPU draws into), and `check:ecs` asserts both halves: the root inserts every one of them and
  no system is handed one any more. `Type-only` three.js imports keep `ecs/presentation.ts` loadable in
  Node.
- **P1.8 — the input race guards' STATE became a resource.** `INPUT_TIMING` (ecs/resources.ts) holds which
  mousemove is the synthetic lock-instant one, whether the unlock was ours, the grace deadline, the
  offscreen cache and the F3 SPACE/MOUSE counters — the fields, NOT the logic. That split is the whole
  point: iron rule 3's decisions stay in the DOM listeners at event time (`skipFirstMove`,
  `lockGraceUntil`, the raw-input takeover arbitration, the spike guards), the listeners still only QUEUE,
  and `step()` (fixed lane, first) applies. Moving the fields made the races INSPECTABLE (a test can arm a
  grace window and read it back) and let the gate assert that `pointerlock` publishes nothing into the
  resource and that `input.ts` no longer owns a second copy of any of it.
- **P1.9 — the last non-ECS edges: window, menu background, diagnostics, the view's listeners.** `DONE` in
  five parts. (1) `platform/viewport.ts` owns the ONE `window` resize listener and only PUBLISHES the
  `VIEWPORT` resource; `cameraView.render` reconciles the projection from it and the FRAME (main.ts's
  `applyViewportSize`, its first act, before the mode body) reconciles `renderer.setSize` — the composition
  root's listener (which reached into a camera and the GPU device) and
  ui/uiscale.ts's second one (which only fed the settings label) are both gone.
  THE FRAME, NOT THE DRAW, and that is a fixed bug rather than a preference: the first version applied the
  size inside `renderer.draw`, which a MENU frame and a LOAD frame never run (they pump the ui lane alone),
  so resizing at the main menu left the panorama's canvas at its old pixel size and the background stopped
  scaling until a world was entered. The canvas follows the window in EVERY mode, applied only when the
  size changed and only once `renderer.init()` has run. (2) The main-menu panorama
  is `rendering/menu-background.ts`: a system object whose state is the `MENU_BACKGROUND` resource, instead
  of four module-level `let`s and a free function in main.ts. It is deliberately NOT registered in a lane —
  the schedule has no run conditions and a MENU frame never runs the render lane — so what it buys is an
  OWNER for the state and one entry point, not a batch. (3) `diagnostics` takes NO constructor arguments:
  its sampler, renderer, voxel world, the input SPACE/MOUSE log, the log sink and the F3 panel's widget
  handles are all resources, and the F3 text moved here from the HUD view. (4) The hotbar digit keys moved
  from a `document` keydown listener inside the inventory VIEW to `ui.navigation`'s edge handling — which
  also fixed a real bug: with no gate at all, 1..9 selected slots at the main menu, on the loading screen
  and behind the pause menu. (5) The key bind drag's rubber band is a WIDGET (`kb.line`) whose UI_LAYOUT
  string `ui.keybind` rewrites per frame; the pointer position is the `POINTER` resource, published by the
  device layer that already handles mousemove, so `ui/menu.ts` creates no element and the drag's two mouseup
  listeners became one. The gesture's event-time half stays exactly where it was — see §3.10 B.
- **P1.10 — a window GEOMETRY change is a device signal, and the capture is foreground-gated.** Two
  reported bugs, one shape. (a) Dragging the window's border while a world was LOADING let the entry lock
  the mouse on top of the drag: both the drag and the view then worked, with the cursor roaming. Windows
  emits a burst of Resized/Moved events for the drag, so the signal is the same shape as losing the window
  (`onWinGeometry` → hand the mouse back, pause if the player was playing), with an 800 ms suppression
  window around OUR OWN programmatic mode switch (fullscreen must not open the pause menu), and it does
  nothing at all outside a world (that early return is a fixed bug too: a window drag at the main menu used
  to write hundreds of `WINGEOM` lines). Rust re-clips the capture rectangle on the way through. (b) The
  native capture is `ClipCursor`, which does NOT look at the foreground (unlike the browser's
  `requestPointerLock`), so the NW.js version could drop its focus gate — this port cannot. The gate now
  exists in three layers: the NORMAL path (`PointerLockDeps.focused`, shipped from `winFocused`, so `relock`
  refuses to capture out of the foreground — and the focus-regained relock still works because `win-focus`
  sets the flag first), the AUTOMATIC path (`enterWorld` captures only when focused; otherwise it shows the
  pause menu, so "not foreground ⇒ paused" stays closed), and the SYSTEM-level net
  (`win::capture_foreground_check`, two consecutive ticks with a foreign foreground → release + restore the
  cursor + emit `capture-lost`, which the frontend handles exactly like a blur).
- **P1.11 — the last of the UI/device edges, plus the input-cadence bug.** `DONE` in six parts.
  (1) THE RECONCILER'S EVENTS ARE DELEGATED: `ecs/ui/system.ts` used to attach SIX listeners to every
  widget at mount time (six closures each, none of them enumerable from outside); it now attaches one per
  event type to the UI MOUNT ROOT and finds the widget by walking up from `ev.target` — the same walk
  `hitTest` already did. `click`/`input`/`mousedown`/`mouseup` bubble, so they delegate as they are; hover
  is an ancestor-chain DIFF over `mouseover`/`mouseout` because `mouseenter`/`mouseleave` do NOT bubble
  (the diff preserves "a parent and a child can both be hovered"), and `contains()` is what clears the
  chain when the pointer leaves the tree. Two behaviour refinements fell out: a `mouseup` ANYWHERE inside
  the tree ends a press (the per-widget listener only heard releases on the widget, so a press that ended
  elsewhere stayed pressed), and the nearest widget with an action wins (a slider stops the walk — it
  reports through `input`).
  (2) THE DELAYED INTENTS ARE DATA: four `setTimeout`s owned "do this in a moment" — closing the backpack
  relocking the mouse (`relockSoon`), the lock manager's 1300 ms retry after a rejection, and the cursor
  re-asserts at 0/120 ms (focus regained) and 0/32/80 ms (the menu/Apps key). They are the
  `DELAYED_INTENTS` resource now (a list of `{at, kind, arg}` wall-clock deadlines, the TOAST's shape,
  capped at 64) and `ui.delays` — a ui-lane system AFTER `ui.navigation` (it writes the same two external
  targets, so the conflict rule FORCES that edge) and BEFORE `ui.widgets` — applies what is due through
  injected effects. The lane is 10 systems / 9 batches.
  (3) TAB IS CANCELLED, NOT SWALLOWED. The first version of the focus-traversal fix did
  `preventDefault(); return;`, which silently made TAB UNBINDABLE in a world (the panel accepts Tab, the
  key never reached `queueKey`). `preventDefault()` alone is the whole fix for the traversal -> the window
  blur -> the pause menu; the rest of the handler runs for TAB like for every other key.
  (4) KEYBOARD ACTIVATION OF WIDGETS IS OFF: a widget element is focusable, so TAB+ENTER/SPACE (and a
  programmatic `.click()`) produced a `click` and drove the UI. The delegated click handler drops
  `ev.detail === 0` — a real press/release carries the click COUNT — so the mouse is unaffected.
  (5) THE LOOK IS APPLIED ONCE PER FRAME (this is the one that fixed a real, user-visible bug). The
  raw-mouse deltas came in through `setInterval(..., 8)`, so "how many look samples a frame gets" depended
  on the phase between that timer (0.125 kHz) and the frame (60 Hz): nominally 1.67/frame, in practice
  2/2/1 — and **Chromium runs input tasks (keydown/keyup) BEFORE timer tasks**, so holding a key
  (autorepeat ~30/s) stretched the timer to 9-12 ms and the per-frame sample count spread over 0/1/2/3.
  Measured with the `FRAME ... pf=[...]` probe: key NOT held -> 122-127 samples/s and 90% of frames at
  exactly 2; key HELD -> 84-110 samples/s and only ~40% of frames at 2. Per-frame rotation therefore
  differed by up to 3x — the reported "holding a key makes the view less smooth". Fix: every guard stays at
  EVENT time (`rawDelta`: takeover, lock grace, spike — same order, same thresholds, `INPUT_TIMING`
  unchanged) and only what passes is ACCUMULATED; `frame()` calls `input.frameLook()` before any fixed step
  and pushes the whole frame's displacement as ONE `look` intent. Result measured on the same machine:
  `pf=[1:60]`, i.e. exactly one application per frame even while holding a key at 100+ px/frame. The spike
  guard stays PER DELTA on purpose (a fast flick may exceed 1000 px in one frame and must not be thrown
  away). `frameLook` clears the accumulator when no world is running, so the capture that is already on
  during an entry cannot dump a backlog into the first game frame.
  (6) THE PROBES, AND THEIR SWITCH. The investigation above needed numbers, so the FRAME/LOOK/RAWLAG/
  RAWMON/STALL probes were added (the last two come from Rust: the emitter's per-second line reports
  `emits`/`wmIn`/`cursorFix`/`hookSeen` plus the cursor and capture state, and `MouseDelta` carries its send
  time so the frontend can measure queue backlog). They are kept — they answer "is it the frame loop, the
  IPC transport, the cursor sentinel or the keyboard hook?" in one run — behind the settings panel's
  "Diagnostic log" toggle (`settings.json`'s `diagLog`, default ON, repaired by type like every other setting),
  which filters the probe prefixes in `logDebug`; `appendDebugLog` (errors/console) always writes.
  Two findings from that instrumentation are worth keeping in mind: the LL keyboard hook has NEVER fired
  (`HOOKPROBE seen=0`, so the device-layer listeners are the only protection against the menu-key gesture),
  and the cursor sentinel needs no correction in a steady game (`cursorFix=0`).
- **P2 — write ownership.** `PARTLY DONE`. Every write from outside a system is a named command
  (`SetMode`, `Teleport`, `SelectSlot`, `SwapSlots` in `ecs/commands.ts`) instead of a direct write
  in `main.ts`, `ui/gamemode.ts` or `ui/inventory.ts`. The per-entity capabilities that used to be
  constants or system fields are components now too (BODY, REACH, INTERACTION), so "only one entity
  can edit blocks" is no longer baked into the code. `input.ts` was the last module writing a gameplay
  component from outside a system run: its DOM listeners now take the same decisions at the same
  moment and merely QUEUE them (`InputIntent`), and its `step()` — the fixed lane's first system —
  writes CONTROL/VIEW/MOTION with a declared access set. What it still writes at event time is the
  DEVICE state (`INPUT_STATE` — the pointer-lock state machine has to react synchronously to a
  `pointerlockchange`), and it is now the ONLY writer of that resource (`platform/pointerlock.ts` no
  longer publishes a cached permission into it). Still outstanding:
  `MOTION.vy` has three
  writers inside the systems (movement's gravity, input's jump impulse, collision's contact zeroing)
  — that is legitimate physics, but a read-only view would make "who may write" checkable.
  TypeScript has no borrow checker, so a read-only interface type is the strongest available form.
- **P3 — remove import-time side effects.** `ui/i18n.ts` reads the filesystem at import;
  `ui/uiscale.ts` mounts DOM at import; `ui/menu.ts` registers six document listeners at import
  (and their relative order is load-bearing). Convert to explicit `init*()` calls from `main.ts`.
  Also converge `gameRoot` (currently derived twice: `platform/shell.ts` and `rendering/textures.ts`).
- **P4 — high risk, needs in-game testing.** `ui/menu.ts`'s panel state machine and the key bind
  gesture's ARM PATHS (the click shield + capture-free drag + physical capture, which are
  click-synthesis timing, not data). The gesture's STATE and the panels' rendering are ECS now
  (`KEYBIND_GESTURE` + `ui.keybind`), so what remains there is the event-time half plus the rubber
  band's SVG. (The other half of this entry — `input.ts` write intents — is `DONE`: the intents are
  named, they carry values decided at event time, and `check:ecs` replays a keydown/mousemove/jump
  through the queue and asserts that nothing is written until `step()` runs. The pointer-lock/raw-input
  races themselves still need a real playthrough after ANY change there — iron rule 3.)

## 5.3 Documentation that still contradicts the code
Verified still present; each is a trap for the next reader:

| Where | Says | Reality |
|---|---|---|
| `rendering/textures.ts:1-2,13`, `blockregistry.ts:32`, `ui/i18n.ts:2-4` | a built-in `default.zip` / `defaultmod.zip` | `scripts/rearrange.mjs` produces neither, and none exists in the tree |
| `main.ts` (the `navTrees` comment) | an `after` naming a system registered later "would silently drop the edge" | nothing is silent: the schedule resolves names at `start()`, and `Schedule.batch()` THROWS (`"X" must run before "Y" but was batched no earlier`, a message that also misnames an `after` as "before"). The rule it is trying to state is "register a system before anything that points at it" — see §3.9 for the minimal reproduction |
| `packs/*/lang/*.json` `bind.hint` | "select a button, then click a key" | while capturing, a keycap mousedown is consumed and the click swallowed — the only exit is Esc |
| Dead code | `platform/shell.ts`'s `centerCursor` export is never imported (the live one is in `platform/rawinput.ts`) | — |

(Four rows left this table across P1.7-P1.11: the raw-input header no longer claims the takeover rule is
"discarded when locked", `platform/pointerlock.ts` no longer claims every `relock()` comes from direct user
interaction (the focus-regained and world-entry paths are documented), the `winctl.exe`/`unTopmost` story is
gone with the kiosk path, `ui/inventory.ts`'s never-called `refreshIcons()` went with the view rewrite, and
`wasMaximizedBeforeFullscreen` is no longer even declared.)

---

# 6. The verification loop (there are no tests)

1. `node ./node_modules/typescript/bin/tsc --noEmit` — the type gate.
2. `npm run check:ecs` — the ECS invariant gate (`scripts/check-ecs.mjs`, 54 assertion groups,
   `RESULT: OK|FAILED`). Run it after touching the ECS, a component, a command, a resource, a recipe,
   a stage or a system's access declaration. It compiles into git-ignored `node_modules/.cache/`, so it
   writes nothing tracked. Two of its groups read SOURCE TEXT (with comments stripped), and its batch
   group is rebuilt from `main.ts`'s own registrations — so a new system whose access declaration is
   wrong turns the gate red before anything runs.
3. `npm run build-all` (or `node scripts/build-all.mjs`) — supports `--check-only`. **Read the last
   line**: `RESULT: OK` / `INCOMPLETE` / `FAILED`. A failed `vite` step leaves the *previous* release
   in place, so the artifacts in the report can look fine while the build failed.
4. Launch `release\VoxelEngineNWWeb\launcher.exe` and walk the flythrough in `docs/TESTING.md`
   (it starts with the startup screen and the settings check, and says what a failure at each step
   means).
   `grep SCHEDULE game\logs\debug.log` also prints the batch grouping the schedule derived (a changed
   grouping means a system's access moved — read it, do not shrug at it). After ANY touch of
   `ecs/systems/input.ts`, the part no assertion can cover is the feel: mouse look must not stutter or
   snap after a click/Esc (the lock grace + skipFirstMove races), Space must still jump and double-tap
   must still toggle fly, and closing the backpack must not launch the player.
5. **For pure logic, write a throwaway assertion script** — this works well and is how the voxel
   layer and the ECS core were originally verified:
   ```powershell
   node .\node_modules\typescript\bin\tsc src\voxel\chunk.ts src\voxel\world.ts src\voxel\raycast.ts `
     --ignoreConfig --outDir .tmp --module commonjs --target es2022 --skipLibCheck `
     --types node --lib es2022,dom,dom.iterable
   # then a .cjs file that requires the output and asserts; delete .tmp afterwards
   ```
   For `src/ecs/core/` add `src\ecs\World.ts` to the file list, point `--outDir` at its own folder,
   and drop a `{"type":"commonjs"}` package.json in that folder — the repo root is
   `"type":"module"`, so without it Node refuses `require()` on the emitted `.js`. The full command
   is in `AGENTS.md` §Testing.
   `--ignoreConfig` is required (TypeScript 7 errors without it when files are named on the command
   line), and `src/voxel/*` deliberately has **no three.js and no ECS imports**, which is what makes
   this possible. `src/rendering/chunkmesh.ts` can be tested the same way because Node resolves the
   real `three`; `src/ecs/core/*` imports no three.js at all, on purpose.
6. Reminder: `rearrange.mjs` **clears** `game\mods` and `game\resourcepacks` on every build. Re-copy
   `packs\*` before testing anything that involves blocks, language or the menu background.
