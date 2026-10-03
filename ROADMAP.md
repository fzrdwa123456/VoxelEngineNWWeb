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
| 32³ chunks, generated on demand, meshed face-culled, streamed around the player | `src/data/world/`, `src/host/browser/chunkmesh.ts`, `src/plugins/render/systems/chunk-stream.ts` |
| X/Z is a **torus** (period 32 chunks = 1024 blocks), seamless via nearest-representation drawing | `src/data/world/world.ts` (`nearestWrap`) |
| Y is **split**: `[0,128)` ground, `[128,256)` writable build space, bedrock below 0 | `src/data/world/world.ts` |
| AABB collision, sub-stepped per axis; player lands, walks, jumps | `src/plugins/player/systems/collision.ts` |
| Break (LMB) / place (RMB) through a 6-block voxel raycast, with a white target outline | `src/plugins/player/systems/interaction.ts`, `src/shared/math/raycast.ts` |
| Three movement modes (walk / creative fly / spectator), fixed 120 Hz step + render interpolation | `src/plugins/player/systems/movement.ts`, `src/plugins/render/systems/camera.ts` |
| Pointer lock, raw mouse input fallback, keybinds, inventory UI, 3 languages, settings | `src/logic/host/window/`, `src/logic/host/dom/` |
| **Input is a scheduled system** (fixed lane, first): the DOM listeners decide every guard at EVENT time and queue a named INTENT (`key`/`look`/`motion`); `step()` writes CONTROL/VIEW/MOTION, so no gameplay component is written outside a system run and the schedule orders input against the controller/movement/collision that read it. It also OWNS the mouse-button listeners (a button bound to "inventory" publishes an edge and nothing else). The raw-input deltas arrive per event and are applied ONCE PER FRAME (`frameLook`, no timer at all — §5.2 P1.11), and their transport/LOOK counters live in the `INPUT_DIAGNOSTICS` resource, which this system also prints from (§5.2 P1.12) | `src/plugins/player/systems/input.ts` (`INPUT_ACCESS`), `src/host/browser/rawinput.ts` |
| A **pure ECS**: generation-checked entity handles, SOA typed-array columns, cached sparse-set queries, resources, deferred commands, a three-stage schedule whose declared order is verified at boot | `src/core/data/`, `src/core/flow/`, `src/core/world.ts` |
| The schedule also **derives parallelism**: systems declare access (components + external targets), `world.batchesOf(stage)` returns the groups that may run in any order, a stage whose systems touch the same thing without a declared edge throws at boot, and the grouping is logged as `SCHEDULE ...` | `src/core/flow/schedule.ts`, `world.scheduleReport()` |
| The player's ENTIRE state is components — position, previous position, orientation, buffered view deltas, motion, control, body box, reach, interaction cooldowns, inventory (stacks + selection) and a zero-size PLAYER marker; its DOM view reconciles from that data once per frame | `src/plugins/player/components.ts`, `src/plugins/ui/views/inventory.ts` |
| **UI modality is EXPLICIT**: every modal surface publishes its visibility into the `UI_MODAL` resource, and one gate (`canControl(devices, ui)`) takes the input away from the local player (its body keeps being simulated) — instead of six container booleans OR'd at five call sites. Which settings sub-page is up is the same resource (`UI_MODAL.settings`/`gen`), so no view keeps a visibility field of its own | `data/globals/resources.ts`, `plugins/ui/views/menu.ts`, `ui/mainmenu.ts`, `plugins/ui/views/inventory.ts` |
| **UI NAVIGATION is a system, not a branch**: `ui.navigation` reads the same key/button EDGES (ESC, the inventory key, a mouse button bound to "inventory") and turns `UI_MODAL` into widget visibility — the ONE painter of the modal trees. ESC walks the sub-page ladder one rung at a time through a single shared mapping (`stepBackSettings`, which the Back buttons and both `goBack()`s also call), and the pointer-lock effects (unlock on open, relock on close) are edge-triggered from the state | `src/plugins/ui/systems/navigation.ts` |
| A **UI WIDGET layer**: widgets are entities (`UI_TREE`/`UI_TEXT`/`UI_LOOK`/`UI_STATE`), prefabs (`spawnPanel`/`spawnLabel`) are the reuse unit, one system reconciles their DOM, and every colour/space/size is a `UI_THEME` token | `src/logic/ui/`, `ui/hud.ts`, `plugins/ui/views/menu.ts` |
| The UI's **behaviour** is scheduled too, not just its data: the F3+F4 picker (`ui.picker`, driven by key EDGES the device layer publishes), the HUD toast (`ui.toast`, a wall-clock deadline in a resource, armed by the `ShowToast` command), the key bind panels + drag gesture (`ui.keybind`, panels derived every frame, gesture state in `KEYBIND_GESTURE`) and the modal navigation (`ui.navigation`) — the old `ui/gamemode.ts` class is gone, and the ESC if-chain that lived in `main.ts` is gone with it | `src/plugins/ui/systems/picker.ts`, `toast.ts`, `keybind.ts`, `navigation.ts` |
| One-command build with a greppable verdict | `scripts/build-all.mjs` (`RESULT: OK / INCOMPLETE / FAILED`) |

**What it is NOT:** the terrain is a NOISE HEIGHT FIELD and nothing more (no biomes, ores, caves, water,
trees or structures — see §3.1), there is no saving, there are no entities besides the player, and there is
no planet/sphere/space anything. (There IS more than one block type since P1.46/P1.47: a voxel value is a
palette index derived from the block registry, so a pack's blocks place and draw.)

---

# 2. ROADMAP — the planet voxel game

Ordered so that every stage is playable on its own. Do not skip: each stage fixes the coordinate or
orientation assumptions the next one depends on.

| Stage | Status | What | Entry point / note |
|---|---|---|---|
| **P0 ground** | `DONE` | flat world, chunks, collision, edit | `generateChunk()` in `src/data/world/world.ts` |
| **P1 terrain** | `DONE (P1.92)` | height field in `data/world/terrain.ts` (value noise, 4 octaves, torus-periodic) + the layered fill in `generateChunk()`; biomes/ores/caves/trees/water are still TODO — see §3.1 | **`generateChunk()` is the ONLY place that knows what a block is, and `terrainHeight()` the only place that knows how high the ground is.** |
| **P2 floating origin** | `TODO` | split coordinates into `int cell + float local`, render camera-relative, update by **delta only** | Must land **before** anything writes absolute world coordinates. The absolute-position writes are now funneled into ONE place — the `Teleport` command (`src/plugins/player/commands.ts`) — which is exactly where the cell/local split goes. Reference technique: [big_space](https://docs.rs/big_space/0.6.0/i686-unknown-linux-gnu/big_space/) |
| **P3 radial gravity** | `TODO` | `ORIENTATION.up` = local surface normal instead of the constant `(0,1,0)` | ⚠️ **Known blocker**: `src/plugins/player/systems/controller.ts` sums view deltas and applies them once per tick **because** `up` is constant. With a changing `up`, "sum then apply" ≠ "apply each". That optimisation must change in the same commit. |
| **P4 sphere + LOD** | `TODO` | cube-sphere quadtree; near = real voxels, far = heightmap | Do the sphere **after** P3; do LOD after the sphere looks right without it. **The flat-world half of the far tier landed in P1.93** (`data/world/lod.ts`: a fine ring + a 2× conservative far ring sampled from the height field) — that is the mechanism the sphere's quadtree will reuse, on a curved grid. |
| **P5 space layer** | `TODO` | several bodies, orbits, nested reference frames | Only possible once P2 exists. |
| **P6 seamless** | `TODO` | atmosphere, LOD hand-off, ships | Last. |

**Explicitly warned against** (this is the classic way these projects die): starting at P4/P5/P6,
or building a sphere before there is any terrain to put on it.

---

# 3. GAPS in what already exists

## 3.1 Terrain and content
- **DONE (P1.92)** The heightmap exists: `data/world/terrain.ts` is a value-noise height field (4 octaves,
  one seed, exactly periodic on the 1024-block torus lap) and `generateChunk()` fills every column with
  grass over a 3-layer dirt band over stone. Measured: 2312-chunk spawn window generated in ~172 ms, 465
  chunks materialised (14.5 MB), heights 107..145 around a base of 128.
- **GAP** Everything a height field does not give you: no BIOMES (one grass/dirt/stone column everywhere), no
  ORES, no CAVES, no WATER (there is no water block), no TREES/structures, and no second noise layer — the
  field is one fBm, not a set of region parameters. A new landform is a term in `terrainHeight`; a new layer
  is a branch in `generateChunk`.
- **GAP** There is no decoration/population pass (trees, structures) and no place to hook one. The natural
  shape (Minecraft's and Luanti's): generate the height/terrain, then run a per-chunk decoration pass that
  may write into a NEIGHBOUR's blocks — which needs a write path that can reach across a chunk boundary
  cleanly (today `setBlock` marks the owner and its border neighbours dirty, which is the right hook).

## 3.2 Blocks
- **GAP** Exactly one block type (`SOLID = 1` in `src/data/world/chunk.ts`). Placement always writes
  `SOLID`, so **which hotbar slot is selected does not matter yet** — `interaction.ts` reads the
  selected stack's type straight from the INVENTORY component (no UI callback, no mirrored copy),
  but there is nowhere to write it. Making selection meaningful = palette values in the voxel data
  + per-value material/UV selection in `chunkmesh.ts` + `isSolid()` accepting any non-AIR value.
- **GAP** The mesher draws the engine's built-in checker texture (`CHECKER_TEXTURE_URL`) and **never
  consults `src/data/assets/blockregistry.ts`**. So mod blocks appear in the inventory and not in the world.
- **GAP** `BlockDef.hasMissingTexture` is written but **read by nobody** (`src/data/assets/blockregistry.ts`).
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
- **DECISION** No `scene.fog`. Consequence: the rim of the streamed window is visible as the edge of the
  world — now at ~512 blocks instead of ~288 (the far ring, P1.93). Fix by raising
  `DEFAULT_LOD.farRadius` (data/world/lod.ts; the torus lap is 1024 blocks, so coarse ±8 is the ceiling
  before the world's own far side comes into view) or by adding an atmosphere — not by silently re-adding fog.
- **PARTLY DONE (P1.93)** There IS a distance LOD: the window is a fine ring (~448 blocks, real 32³ chunks)
  plus a far ring drawn from the same height field at 2×2 blocks per super voxel (~512 blocks). What is
  still missing is the rest of the ladder: ONE far level only (no 4×/8× tier), no frustum-aware
  prioritisation, no downsampling of Y, and the ring boundary is a visible ledge (the coarse surface is
  conservatively the MAX height, so it can bulge a block or two where it meets the fine ring — no cracks,
  but a step). Skirts/stitching and a second tier are the next steps.
- **GAP** `logarithmicDepthBuffer` is not enabled. Camera `near = 0.1, far = 5000`; planet scale
  needs reversed-Z or logarithmic depth.
- **GAP** Chunk GENERATION runs on the **main thread** (the fill is cheap — a uniform chunk allocates
  nothing — but it owns the world's `Map`). MESHING left this list in P1.18h (workers, `hardwareConcurrency
  - 1`) and a pack reload no longer re-meshes at all (P1.18i) — see §4 for the route and what is left of it.
  The FAR RING's build is main-thread too (P1.93), but it is procedural — it samples the height field and
  reads no world chunk — which is what makes it ~0.33–3 ms per chunk instead of a 4× gather.

## 3.7 UI
- **GAP** The inventory's block selection has no observable effect in the world (§3.2). The stacks
  and the selection ARE component data now (INVENTORY, written only by `SelectSlot`/`SwapSlots`), so
  the ECS side is finished; only the world side is missing.
- **GAP** No crafting, no containers, no item stacks beyond a display count. Nothing moves items
  between slots except the backpack click, and nothing can pick an item up.
- **DONE — the widget layer covers EVERY surface.** `ui/hud.ts` (crosshair, F3 panel, toast),
  `plugins/ui/systems/picker.ts` (the F3+F4 picker — it stopped being a view when it became a system),
  `plugins/ui/systems/toast.ts`, `plugins/ui/views/menu.ts` (pause menu + the shared settings panel, the
  visual keyboard and the key bind gesture included), `ui/mainmenu.ts` and `plugins/ui/views/inventory.ts` all write
  component data now. Measured before → after, per file: `menu.ts` 45 → 0 colour literals, 60 → 0
  inline style writes, 60 → 2 `appendChild` (both the drag rubber band's SVG); `mainmenu.ts` 21 → 0 and
  47 → 0; `inventory.ts` 13 → 0 and 17 → 0. The invariants that replaced the hand-written ones are
  asserted by `npm run check:ecs` for every migrated surface: no colour literal, no element built by
  hand, no inline style string, no `display` as state.
  The two prefabs the migration needed are the ones that were missing: a CLICKABLE widget
  (`UI_ACTION` + the `UI_ACTIONS` dispatch table in `logic/ui/actions.ts`) and a fixed-capacity list
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
- **GAP** The i18n DICTIONARY IS NOT SHIPPED. `data/assets/i18n.ts` says the build packs `src/assets/lang` into
  `default.zip`, and `packs/*` carries 77 keys in three languages — but `src/assets` does not exist and
  `rearrange.mjs` produces no `default.zip`, so with no resource pack installed `t()` falls back to the
  KEY and the UI renders `menu.resume`. The mechanism (layered merge, en fallback, 0 used-but-undefined
  keys) is sound; only the deployment is missing. Trigger: any build that is expected to show text.
- **DONE** No surface reads its own visibility back out of `style.display` any more, and none keeps a
  visibility field of its own: a panel is a widget's `hidden` flag, "which modal surface is up" is
  `UI_MODAL.mainMenu/menu/inventory` and "which sub-panel is up" is `UI_MODAL.settings`/`gen`.
  `plugins/ui/systems/navigation.ts` is the ONE painter of those flags, and the ESC ladder asks the DATA
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
  (`data/globals/resources.ts`), with a sanitising factory (a hand-edited settings.json cannot produce a NaN
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
  `data/globals/resources.ts` (the panel imports them instead of restating them) and `sanitizeFrameCap` clamps
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
  + `ui/loading.ts` (the tree) + `plugins/ui/systems/loading.ts` (`ui.loading`, the painter, first in the ui lane):
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
  `ui/boot.ts`/`logic/ui/boot.ts` → `.../loading.ts`, the `boot.*` theme recipes → `loading.*`, and
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
  `fpsCap` bug was one instance of it). `host/desktop/shell.ts` now has `readSettingsChecked()` (which
  tells "no file yet" from "unusable file"), `diffSettings(raw, inForce)` — a PURE comparison that
  repairs each unusable value with the one in force, per ACTION for a keybind, KEEPING keys the engine
  does not know — and `backupSettingsFile()`. A file that cannot be parsed is copied to
  `config/settings.bad.json` and rebuilt from the values in force. The outcome is logged AND shown on
  the loading screen (`loading.fixed` / `loading.unknown` / `loading.rebuilt` + the setting names), which is
  what makes it testable by hand. `inForce` doubles as the schema; `check:ecs` asserts the repair
  rules and the wiring.

## 3.9 ECS core (`src/core/data/` + `src/core/flow/`)
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
(`host/browser/window-guards.ts`, 6 listeners), the ONE resize listener (`host/browser/viewport.ts`) and the bind
gesture's five (`plugins/input/bind-gesture.ts`) are device-layer modules now (they used to be the composition
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
event-time listeners (its STATE is the INPUT_TIMING resource — §5.2 P1.8) — and since §5.2 P1.14 those
listeners hold NO state at all: they publish facts (the intent queue, the rebind queue, the edge log, the
gesture resource) and every policy is applied in a lane. The same goes for the BIND GESTURE's
event-time half: the click shield's two arm paths, the drag's mousedown/mouseup, the wheel block and the
key-capture handler (§5.2 P1.9) — every one of them a decision that can only be taken inside the event that
must be cancelled, and each one now records DATA (the gesture resource, a queued rebind) rather than calling
into a table; per-CALL scratch an operation builds and
throws away (a bake's canvas, its render
target and its temporary scene); the
config modules own the FILES while their VALUES live in resources — and
the global style applies itself nowhere any more (`fonts`/`uiscale` publish the font pair and the root
font size, and the RECONCILER writes them, diffed per frame); `windowMode`/`vsyncDisabled` stay
plain config because nothing reads them on the tick (the DIAGNOSTIC-LOG switch is another one: it is read by
the log sink, not by a system — its VALUE is `SHELL_STATE.diagLogEnabled`). The UI EVENT LAYER is delegated
rather than per-widget (§5.2 P1.11), and the
raw-mouse look is accumulated at event time and applied ONCE PER FRAME — both are "one owner, one place"
choices, not leftovers.
The rows that used to sit here are gone: the three.js/GPU/DOM objects, `VoxelWorld` and the chunk mesh
cache are RESOURCES (§5.2 P1.7), the input race guards' state is too (P1.8), and the window listener, the
menu background, the diagnostics dependencies and the view's DOM listeners went the same way (P1.9).
The LAST rows — the view paint caches, the host state, the asset caches, the rebind capture, the frame
loop's own state and the two boot/entry drivers' sequences — went in §5.2 P1.14. What remains outside the
data model is the irreducible ADAPTER layer, and it is worth naming precisely because it will never move:
a DOM listener must exist to receive the event and call `preventDefault` inside it; a rAF callback must
exist to drive the three lanes; exactly one system writes the DOM; and the file/pack I/O has to happen
somewhere. Every one of those is now stateless — it either publishes data or walks a data-declared flow.

**C. Inert leftovers** (dead code and stale comments, NOT bugs — §4): the main menu's world-type
panel, and the unused `centerCursor` export in `host/desktop/shell.ts` (the live one is in `host/browser/rawinput.ts`;
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
| Camera, HUD, renderer and perf samplers are RESOURCES, never components | they are GPU/DOM objects with methods, and component data must be plain; a component would be a copy that has to be re-synced every frame. Same for the UI mount root, the chunk-mesh cache, the chunk material, the icon baker and the target wireframe (§5.2 P1.7/P1.12) |
| `VoxelWorld` stays a RESOURCE, never a component | it is ONE world, not per-entity state. It is also written from both lanes (fixed: interaction, render: chunkstream), and "one owner, nameable" is exactly what a resource buys |
| The pointer-lock / raw-input LOGIC stays in the event-time listeners | a keyboard and a lock are DEVICE state, not entity state, and the decisions are only correct inside the event that must be cancelled (iron rule 3). Its STATE is the INPUT_TIMING resource (§5.2 P1.8), and the counters are INPUT_DIAGNOSTICS (P1.12) |
| `chunkstream` keeps its window bookkeeping as system state | the wanted set and the last column are derived per frame; the MESH CACHE is the CHUNK_MESHES resource (§5.2 P1.7) and the material the CHUNK_MATERIAL one (P1.12) |
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
| ~~`applyCursor()` (`host/browser/pointerlock.ts`)~~ | ~~also writes `input.clickLockAllowed` — a hidden second effect~~ **RESOLVED**: it only sets the cursor now | — |
| ~~`clickLockAllowed`~~ | ~~really means "no UI is open", not "clicking may grab the lock"~~ **RESOLVED**: the field is gone; the readers ask `isModalUi(UI_MODAL)` | — |
| `freeMouseActive` | the cursor is HIDDEN in that mode; it means "Chromium cancelled the lock and the window is partly offscreen" | ⚠️ rule 3 |
| `rawTakeoverActive` (`input.ts`) | a **log de-duplication flag**, not the takeover state; the state is computed on demand | low |
| `MODE_NAMES` (`components/Player.ts`) | `walk → "Survival Mode"`; used by exactly one log line, while the UI uses i18n `mode.*` | low |
| `mode` | three unrelated meanings: `MoveMode`, `WindowMode`, `MenuBgMode` | low |
| `World` vs `VoxelWorld` | the ECS and the block world; the ECS holds it as the `VOXEL` resource, while `data/world/world.ts` keeps its own name | low |
| `WORLD_MAX_Y` | the **writable limit** (256), not the visible top (128) | low |
| `SKIN` (`collision.ts`) | the contact epsilon — "skin" also means mesh skinning | low |
| `empty` (`chunkstream.ts`) | chunks that produced **no geometry**, which includes fully enclosed solid ones | low |
| `enterWithLoading()` / `genPanel` / `WorldGenMode` | name promises loading / world generation that do not exist | low, but see §4 |
| `BUILTIN_NAME = "default.zip"` (`textures.ts`) | a **live code path** looking for a pack the build no longer produces; same fiction in `data/assets/blockregistry.ts` and `i18n.ts` comments | medium |

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
  so the composition root INSERTS them (`host/browser/presentation.ts`) and each system resolves what it uses in its
  constructor body. The access declarations still name the objects as external targets (`camera3d`,
  `chunkMeshes`, `framebuffer`) — the schedule models those NAMES, not the resource handles — so no
  ordering changed. What it bought: the chunk stream keeps no private mesh cache, `diagnostics` takes NO
  constructor arguments (its sampler, renderer, voxel world, log sink and F3 panel are all resources), the
  device layer takes its canvas from `RENDERER3D.domElement` (the element the pointer is locked to IS the
  element the GPU draws into), and `check:ecs` asserts both halves: the root inserts every one of them and
  no system is handed one any more. `Type-only` three.js imports keep `host/browser/presentation.ts` loadable in
  Node.
- **P1.8 — the input race guards' STATE became a resource.** `INPUT_TIMING` (data/globals/resources.ts) holds which
  mousemove is the synthetic lock-instant one, whether the unlock was ours, the grace deadline, the
  offscreen cache and the F3 SPACE/MOUSE counters — the fields, NOT the logic. That split is the whole
  point: iron rule 3's decisions stay in the DOM listeners at event time (`skipFirstMove`,
  `lockGraceUntil`, the raw-input takeover arbitration, the spike guards), the listeners still only QUEUE,
  and `step()` (fixed lane, first) applies. Moving the fields made the races INSPECTABLE (a test can arm a
  grace window and read it back) and let the gate assert that `pointerlock` publishes nothing into the
  resource and that `input.ts` no longer owns a second copy of any of it.
- **P1.9 — the last non-ECS edges: window, menu background, diagnostics, the view's listeners.** `DONE` in
  five parts. (1) `host/browser/viewport.ts` owns the ONE `window` resize listener and only PUBLISHES the
  `VIEWPORT` resource; `cameraView.render` reconciles the projection from it and the FRAME (main.ts's
  `applyViewportSize`, its first act, before the mode body) reconciles `renderer.setSize` — the composition
  root's listener (which reached into a camera and the GPU device) and
  data/globals/uiscale.ts's second one (which only fed the settings label) are both gone.
  THE FRAME, NOT THE DRAW, and that is a fixed bug rather than a preference: the first version applied the
  size inside `renderer.draw`, which a MENU frame and a LOAD frame never run (they pump the ui lane alone),
  so resizing at the main menu left the panorama's canvas at its old pixel size and the background stopped
  scaling until a world was entered. The canvas follows the window in EVERY mode, applied only when the
  size changed and only once `renderer.init()` has run. (2) The main-menu panorama
  is `plugins/render/systems/menu-background.ts`: a system object whose state is the `MENU_BACKGROUND` resource, instead
  of four module-level `let`s and a free function in main.ts. It is deliberately NOT registered in a lane —
  the schedule has no run conditions and a MENU frame never runs the render lane — so what it buys is an
  OWNER for the state and one entry point, not a batch. (3) `diagnostics` takes NO constructor arguments:
  its sampler, renderer, voxel world, the input SPACE/MOUSE log, the log sink and the F3 panel's widget
  handles are all resources, and the F3 text moved here from the HUD view. (4) The hotbar digit keys moved
  from a `document` keydown listener inside the inventory VIEW to `ui.navigation`'s edge handling — which
  also fixed a real bug: with no gate at all, 1..9 selected slots at the main menu, on the loading screen
  and behind the pause menu. (5) The key bind drag's rubber band is a WIDGET (`kb.line`) whose UI_LAYOUT
  string `ui.keybind` rewrites per frame; the pointer position is the `POINTER` resource, published by the
  device layer that already handles mousemove, so `plugins/ui/views/menu.ts` creates no element and the drag's two mouseup
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
  refuses to capture out of the foreground; the focus-regained relock this sentence used to justify is GONE
  in P1.58 - capture is explicit-only now, so no automatic path wants the mouse out of the foreground at
  all), the AUTOMATIC path (`enterWorld` captures only when focused; otherwise it shows the
  pause menu, so "not foreground ⇒ paused" stays closed), and the SYSTEM-level net
  (`win::capture_foreground_check`, two consecutive ticks with a foreign foreground → release + restore the
  cursor + emit `capture-lost`, which the frontend handles exactly like a blur).
- **P1.11 — the last of the UI/device edges, plus the input-cadence bug.** `DONE` in six parts.
  (1) THE RECONCILER'S EVENTS ARE DELEGATED: `plugins/ui/systems/reconcile.ts` used to attach SIX listeners to every
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
- **P1.12 — the tail of the presentation state, and the last lane crossing the wrong way.** `DONE` in
  seven parts, all of them the same shape: state that belonged to ONE world was module-level or a
  system's private field, and one of them had a lane boundary crossed by an OBJECT instead of by data.
  (1) THE ITEM-ICON BAKE is the `ICON_BAKE` resource (presentation.ts): the second, offscreen
  `WebGPURenderer`, its in-flight init and the cache/pending Maps were four module-level `let`s in
  `host/browser/blockicons.ts`. The functions take that state, so the baker is a pure operation on world
  data — and the promise-shaped `getBlockIcon()` is GONE, because its `.then` continuation wrote the
  slot's `UI_IMAGE` component from OUTSIDE any lane (a view updated between frames, deciding on its own
  when the frame's data changed). `peekBlockIcon(bake, …)` stays the synchronous reader the inventory
  draws from; `requestBlockIcon(bake, …)` starts a bake and returns at once; the inventory remembers
  WHICH slots are waiting and re-paints a slot the frame the bake lands
  (`collectFinishedBakes`), and stops waiting when a bake FAILED — otherwise the checker would either
  stay forever or be re-requested every frame.
  (2) THE SHARED CHUNK MATERIAL is `CHUNK_MATERIAL`: `host/browser/chunkmesh.ts` had a module-level
  `let sharedMaterial`, i.e. one GPU object per PROCESS shared by every world, created lazily because the
  pack chain must be installed before the checker texture resolves. `getChunkMaterial(state)` takes the
  resource.
  (3) THE RAW-INPUT TRANSPORT COUNTERS are `InputDiagnostics.raw` (`evCount`/`gapMax`/`lastArrive`/
  `minOffset`/`backlogSum`/`backlogMax`): they were module state in `host/browser/rawinput.ts`, which is why
  the module ALSO had to own the formatting of the `RAWLAG` line. `startRawInput(onDelta, raw)` is
  handed the resource and the input system prints both `LOOK` and `RAWLAG` from one window — the device
  layer now keeps no state and writes no log.
  (4) THE LOOK COUNTERS are `InputDiagnostics.look` (the eleven per-second counters plus `logAt`), so
  `player.input` keeps no private diagnostics; `takeLookFrameMeter()` reads AND clears the resource, and
  the fields are readable by a test, a probe and the gate.
  (5) THE WIDGET TREE'S CREATION COUNTER is `UI_ORDER`: `nextOrder` was a module-level `let` in
  `plugins/ui/components.ts`, i.e. shared by EVERY World — a second world (the gate's own) continued the first
  one's numbering and two trees built in different worlds could not be compared. `spawnUiNode` draws
  `UI_TREE.order` from the resource, which the composition root inserts before the first spawn.
  (6) THE UI MOUNT ROOT is created by `createUiMount()` and inserted as `UI_MOUNT`, like the canvas host.
  `data/globals/uiscale.ts` used to create the stage div and append it to `document.body` at IMPORT time — a DOM
  side effect of a CONFIG module, on the element the whole widget layer hangs off (the P3 entry below
  had this on its list; this is the half of it that is done).
  (7) THE BLOCK TARGET OUTLINE crosses the lane boundary as DATA. `BlockInteractionSystem` owned a
  `THREE.LineSegments` and set its transform in `step()`, so the FIXED lane wrote a three.js object
  (`writesExternal: ["voxelBlocks", "outline"]` on a sim-lane system) — the last such crossing in the
  engine. The hit is the `TARGET_HIT` component now (active + x/y/z, on the local player only) and
  `block.outline` (`plugins/render/systems/outline.ts`, RENDER lane) positions the `BLOCK_OUTLINE` mesh. The mesh is
  built by the composition root because a three.js object is wiring. The schedule gained one render-lane
  system and is unchanged otherwise: `block.outline` shares the producers' batch — it reads a component
  none of them touch and writes a target of its own — while `renderer.draw` still follows the two that
  feed the scene. Render lane: **5 systems, 2 batches, 6 parallel pairs**.
  (Eight rows in `AGENTS.md` moved with this pass: the presentation-resource list, the
  `interaction.ts` bullet, the `rendering/` bullet, the render-lane diagram, the SCHEDULE report, the
  player's component list, the "a GPU/DOM object is a RESOURCE" convention and the gate's own group
  count; the "interaction writes the outline from the fixed lane" KNOWN GAP is deleted, not reworded.)
- **P1.13 — a rebind capture owns ESC again (a regression the P1.9 relocation introduced).** `FIXED`.
  Reported: click an action row in the key bind panel (that arms a rebind capture), then press ESC — the
  action is unbound (correct) AND the settings panel walks one level back (wrong). The NW.js build did
  only the first: its capture handler was a MODULE-LEVEL `document` keydown in `plugins/ui/views/menu.ts`, so it was
  registered during main.ts's import phase — BEFORE `new PlayerInputSystem(...)` — and its
  `stopImmediatePropagation()` therefore kept the ESC out of `KEY_EVENTS` entirely, so `ui.navigation`
  never saw it. P1.9 moved those five listeners into `plugins/input/bind-gesture.ts`, mounted by
  `bindKeybindDrag()` from main.ts's BODY — i.e. AFTER the input system's constructor — which inverted the
  order and made the suppression a no-op (the edge is already in the log; a lane consumer cannot be
  stopped). P1.11 hit the same trap for the DRAG case and fixed it in the lane (`dragging()` +
  `cancelDrag`, with a comment in bind-gesture.ts saying exactly why), but the CAPTURE case kept relying on
  the lost suppression. That shape does not transplant: the capture handler calls `endCapture()`
  SYNCHRONOUSLY, so by the time the ui lane drains the log `capturing()` reads false — the only moment the
  answer is still true is the event itself. Fix (one line, in `plugins/player/systems/input.ts::onKeyDown`):
  `if (ev.code === "Escape" && isCapturing()) return;` — ESC is not published and not queued while a
  capture is armed, so the capture handler unbinds and nothing else reacts. Only ESC is gated: every other
  key must keep reaching the log (ui.navigation's inventory/digit branches gate on `capturing()`
  themselves, and TAB must stay BINDABLE). `check:ecs`'s "the device handlers only QUEUE" group now asserts
  both halves: ESC IS published with no capture armed, and publishes NOTHING while one is.
- **P1.14 — the data/behaviour split finished: view paint state, host state, assets, the loop and the boot
  flow.** `DONE`. The rule this pass applied is not "ECS-ify everything" but "state in the world, logic in a
  system or a walker, adapters hold neither":
  (1) `UI_PAINT` (new, `logic/ui/paint.ts`) is the UI layer's "what did I paint last" data: the reconciler's
  ELEMENT TABLES and per-widget drawn cache, the hover/press sets, the applied global style, and the diff
  caches of `ui.loading` / `ui.toast` / `ui.hud` / `ui.keybind` / `ui.inventory` / `ui.navigation` /
  `ui.bindings`. They were private fields of eight classes — state inside behaviour, resettable nowhere.
  The classes keep thin accessors onto the resource, so the use sites did not move.
  (2) The same treatment for the non-UI caches: `INPUT_INTENTS.frameDx/Dy` (the frame's accumulated look),
  `CHUNK_MESHES.wantedKeys/lastPcx/lastPcz` (the streaming window's bookkeeping), `DELAYED_INTENTS.applied`,
  `PICKER_STATE.outsideWorld`, `VIEWPORT.appliedAspect/listenerInstalled/publishScheduled` and
  `INPUT_STATE.appliedCursor` (which emptied `PointerLock`'s last private field).
  (3) The HOST state is a resource: `SHELL_STATE` (settings snapshot, log-flush deadline, diagnostic switch,
  foreground flag) — created by `host/desktop/shell.ts` at import time, because a log line can be written before
  the World exists, and inserted by the composition root. The ASSET caches went the same way: `I18N_STRINGS`
  (the built dictionaries), `BLOCK_REGISTRY` and `MENU_BG_KIND` (the pack chain's background memo).
  (4) The REBIND CAPTURE is data + a queue: `KEYBIND_GESTURE.capturing` replaces the module-level
  `let capturing` in `plugins/input/keybinds.ts` (which now only holds a pointer to the resource), and the device
  listeners no longer write the bind table — they publish a `RebindIntent` (`bindCapture` / `bindDrag`) that
  `ui.keybind` applies in the lane, with the `KBCAP bind done` line moving with it.
  (5) The frame LOOP's state is `LOOP_STATE` (mode, both accumulators, the canvas size last applied, the
  geometry-suppression deadline) and the FRAME probe's dozen counters are `FRAME_PROBE` — the loop BODY stays
  the composition root's (a rAF callback is not a lane), but it now reads world data.
  (6) The BOOT / WORLD-ENTRY flows are `BOOT_FLOW` + a stage list (`core/flow/boot.ts`): the stages (progress, i18n
  key, the work) are declared by the composition root as DATA, the settings check's outcome is a field of the
  flow, and the only logic left is `runBootFlow` — announce a stage, yield one macrotask so the browser paints
  it, then run its work. `check:ecs` pins all of it (its own group) and now counts **69** assertion groups.
  What is still outside is exactly the irreducible adapter layer: listeners that must `preventDefault` in the
  event, the rAF callback that drives the lanes, the ONE DOM writer, and file/pack I/O.
- **P1.15 — the source tree is now three folders that say what they are: `components/`, `data/`,
  `logic/`.** `DONE`. Nothing but paths changed — every file was moved with `git mv` (history intact) and
  every import was rewritten mechanically, so the behaviour is exactly what P1.14 left. The point is that
  a reader (human or model) can answer "is this data or behaviour?" from the PATH: `components/` = what an
  entity or a widget can CARRY (schemas + spawn helpers), `data/` = state (`globals/` the one-per-world
  resources, `assets/` what the pack chain produced, `world/` the voxel data), `logic/` = behaviour
  (`engine/` the DOD engine, `fixed|render|ui/` the three lanes, `host/` the only place with side effects:
  window / input / gpu / dom). It replaced a layout where DATA lived in eleven files across six
  directories (`ecs/resources.ts`, `ecs/presentation.ts`, `ecs/boot.ts`, `ecs/components/`,
  `ecs/ui/{widgets,theme,paint,actions,bindings,keybind}.ts`, `platform/shell.ts`, `ui/{i18n,background}.ts`,
  `blockregistry.ts`) and BEHAVIOUR in four places (`ecs/systems/`, `ecs/ui/`,
  `rendering/{camera-view,outline,menu-background}.ts`, and `renderer.draw` inlined in `main.ts`), with
  `src/ui/` and `src/ecs/ui/` meaning different things under one name. Three files were SPLIT rather than
  moved, because they genuinely held both halves: `bindings.ts` -> `data/globals/sources.ts` (the source
  table) + `plugins/ui/systems/bindings.ts` (the resolver), `keybind.ts` -> `data/globals/keybind-gesture.ts` (the
  gesture resource, the queued rebind intents, the panel registry) + `plugins/ui/systems/keybind.ts` (the system),
  and the boot flow -> `core/flow/boot.ts` (whose stage lists are declared by the composition root).
  What deliberately did NOT change: the engine, the lanes, the access declarations, the schedule. Known
  overlaps left in place (both documented in AGENTS.md): `host/browser/presentation.ts` holds the GPU/DOM
  resource TOKENS next to the factories that build those objects, `core/flow/boot.ts` holds the flow
  token next to the walker, and `data/assets/{i18n,background,textures,blockregistry}.ts` hold their
  read-once cache next to the accessor that reads it. `check:ecs` keeps all 56 groups green (its `SOURCES`
  list and ~230 path references were repointed) and the docs' prose paths were repointed with them.
- **P1.16 — the last DATA inside `logic/` moved to `data/`, and the last BEHAVIOUR inside `data/` moved to
  `logic/`.** `DONE`. P1.15 got the folders right but left two kinds of stragglers, both found by reading
  every file in `logic/host/` and every module-level `let`/`Set` under `data/`:
  (a) **seven constant tables that lived in behaviour files** — the bind action ids + `DEFS` + the bind
  panel's rows and the ~50-entry keycap display-name map (`plugins/input/keybinds.ts`), the visual
  keyboard's four grid tables (`plugins/ui/views/menu.ts`) and the cube's six faces (`host/browser/chunkmesh.ts`)
  — are now `data/globals/binds.ts`, `data/globals/keylayout.ts` and `data/globals/faces.ts`. The display
  names were also a per-CALL literal (`codeDisplayName` rebuilt a 50-entry object on every keycap every
  frame); as a table it is built once. The modules that ACT on them did not move: validation, the conflict
  policy, the settings file, the mesher and the view stay in `logic/`.
  (b) **the configuration change notification was behaviour living in data modules** —
  `uiscale.ts`/`fonts.ts`/`i18n.ts` each kept a `Set<() => void>` plus an `on*Change()` and fired it from
  their setter, and `keybinds.ts` kept a fourth copy. The registry is now ONE bus,
  `core/services/bus.ts` (`onConfigChange(kind, cb)` / `notifyConfigChange(kind)` for
  `lang|font|uiScale|binds`), subscribed by the composition root (persistence) and by the settings panel
  (the few labels composed from a VALUE, which no i18n key can re-derive). The data modules now own the
  VALUE and nothing else — which is what their own headers always claimed.
  (b2) **the last seven "data in a behaviour file" stragglers** followed: the diagnostic-probe prefix
  table (`host/desktop/shell.ts` -> `data/globals/probes.ts`), the face corner UVs and the two chunk
  geometry capacities, the icon bake's view size and size clamp (`chunkmesh.ts`/`blockicons.ts` ->
  `data/globals/faces.ts` + `gfx.ts`), the log batch thresholds (-> `data/globals/shell.ts`), the four
  UI action/source IDS (-> `data/globals/actions.ts` + `sources.ts`), the pack-list capacity (->
  `data/globals/paint.ts`) and the mouse-button mapping, which was an if-chain, plus the bind-code
  pattern (-> `data/globals/binds.ts`, as `MOUSE_BUTTONS` + `BIND_CODE_PATTERN`). After this `logic/host/`
  holds module-level state in exactly 13 places and every one of them is deliberate: 6 event-subscriber
  registries (behaviour, correctly in logic), 3 POINTERS to a resource and 4 one-shot wiring flags. There
  is no constant TABLE left in it, and the probe switch's assertion in `check:ecs` now reads the table's
  new file while still pinning the filter point to `shell.ts`.
  (c) `SHELL_STATE` also took the LOG QUEUE (`pending`), the other half of the batching whose deadline
  (`flushTimer`) was already there.
  What deliberately did NOT move, and why: `viewport.ts`'s `state` and `keybinds.ts`'s `table` are POINTERS
  to a resource (moving them to `data/` would make data a mutable cache of logic — the pattern AGENTS.md
  bans); the one-shot wiring flags (`menu.ts`'s `dragDeps`/`keybindActionsReady`/`fpsSourceReady`,
  `rawinput.ts`'s `available`), the engine's component-id counter and the encapsulated sampler/forwarder
  counters (`perf.ts`, `debuglog.ts`) are mechanism state inside a behaviour object, not domain data; and
  the pure functions over data (`raycast.ts`, the `VoxelWorld` methods, `recipeStyle`, `t()`) are the data
  model's own accessors, not lane behaviour. `check:ecs` stays at **56** groups (its `SOURCES` list gained
  the four new modules) because nothing it pins changed meaning.
- **P1.17 — the tree is a microkernel + plugins + DOD layout: `core/`, `plugins/`, `host/`, `data/`,
  `shared/`, `boot/`.** `DONE`. P1.15/P1.16 had got data and behaviour into separate FOLDERS; what was
  still missing was the layer that says WHO MAY SEE WHOM. The tree is now: `core/` = the mechanism with no
  game vocabulary (`data/` = the DOD substrate: entity handles, `defineComponent` SOA columns,
  `defineRecord` cold records, the cached query, the column store with `structuralVersion`, `Resource<T>`
  tokens; `flow/` = the three stages, after/before resolution, declared access, the derived batches;
  `effect/` = the command queue that applies at a barrier; `services/` = the platform-free helpers — the
  config bus, the perf sampler, the settings repair; `world.ts` = the façade) — `plugins/` = every FEATURE,
  and each one now OWNS its data (`player/` = the components + the fixed lane's six systems, `render/` =
  camera/chunk-stream/outline/menu-background/diagnostics, `ui/` = the widget components + the ten ui-lane
  systems + `views/` = the wiring that spawns the trees, `input/` = the bind table and the rebind gesture's
  event-time half) — `host/` = the only place with side effects (`desktop/` = Tauri/window/log/packs,
  `browser/` = viewport, raw input, pointer lock, mouse capture, window guards, the GPU factories, the
  mesher, the icon baker) — `data/` = values (the resource shapes + every shared table, the pack-chain
  assets, the voxel data) — `shared/` = types and pure helpers (the voxel DDA moved here) — `boot/` =
  `main.ts`, the composition root and the ONE loop.
  What the layer decides from now on is where a NEW file goes (and `components/` is gone as a top-level
  folder — **data follows the feature that owns it**, which is what makes a plugin installable AND
  removable). What it does NOT decide yet: **21 imports still cross a layer** (16 between plugins and 5
  straight into `host/` — the exact list is in AGENTS.md), and nothing forbids them. The move itself was
  mechanical: 56 files, 256 import
  specifiers recomputed in ONE pass over a snapshot. (The first attempt did almost nothing — `path.posix.relative`
  cannot resolve Windows paths, so every specifier round-tripped to itself and was skipped, and the three it
  did rewrite had to be repaired by hand; the fix was `path.relative`.) `check:ecs` keeps all **56** groups
  green after ~230 of its own path references and four `path.join` source reads were repointed. What this
  round did NOT do: the systems are still registered BY HAND in `boot/main.ts` (21 `addSystem` + 40
  `insertResource`), so the plugin layer is a LAYOUT, not yet a registry. The extension points, the
  descriptors, the plugin manifest AND the dependency declarations that close those 21 imports are the next
  round (P1.18) — they are what make "add a feature = add a plugin folder + one manifest line" true.
- **P1.18 — the plugin system is REAL: extension points, the registry, the install, the manifest.**
  `DONE` (the second half is P1.18b). The tree in `plugins/` stopped being decoration:
  `core/extension/{point,slots,registry}.ts` (four slots — systems/components/resources/commands; a typed
  `defineExtensionPoint<T>`; an `ExtensionRegistry` that files each contribution under its plugin id and
  THROWS on a duplicate), `core/plugin/{descriptor,api,lifecycle,errors}.ts` (`definePlugin({ id, deps,
  setup })`, the narrow `PluginApi` a plugin is handed, `installPlugins` = dependency topological sort +
  the manifest's veto + failure isolation, and one log line per thrown plugin), `boot/manifest.ts` (+
  `manifest-types.ts`) reading `plugins.json` OUT OF THE PACK CHAIN like any other content file, and SIX
  plugins with an `index.ts` that declares what each one owns (`world`, `player`, `render`, `diagnostics`,
  `ui`, `input`). `boot/main.ts` now registers every one of its 21 systems through
  `contributeSystem("<plugin id>", {...})` and the schedule is fed from `registry.list(SLOT_SYSTEMS)`, so
  **a plugin the manifest disables contributes no systems at all** — the cheapest honest form of
  pluggable: a subsystem nobody wants costs nothing and cannot break the boot. It also makes the
  registration loud where it used to be silent: two plugins claiming one system/resource name is a boot
  error naming both owners, and `REGISTRY …` / `PLUGIN installed n/m` lines in debug.log say who brought
  what. `check:ecs` grew its seventh-from-last group to drive all of it — the registry's duplicate rule,
  the install's ordering/veto/isolation, the manifest's parse/override/fallback, every plugin's declared
  counts, AND all six plugins into ONE registry (a duplicate token there would disable a plugin and take
  its systems with it, so it is asserted rather than assumed) — **57 groups** green. NOT done, and
  deliberately not pretended: the systems are still CONSTRUCTED in `boot/main.ts` (their closures capture
  the wiring: the views, the injected hooks), so a plugin owns its declarations and its registrations but
  not yet its own file; and the 21 cross-layer imports are pinned by a RATCHET (≤16 plugin→plugin, ≤5
  plugin→host) rather than forbidden. **P1.18b** finishes both: move each system's construction next to
  its plugin, declare the real deps, and turn the ratchet into a direction rule.
- **P1.18b — the layer rules are enforced, and the shared pieces moved out of the plugins.** `PARTLY DONE`.
  `check:ecs` no longer counts debt: it now asserts that **a plugin may import a sibling only if it declared
  it in `deps`** and that the declared graph is ACYCLIC (an import the install order cannot honour would be
  a boot-time lie), with the five remaining reads into `host/` pinned so they can shrink but never grow.
  Making that true required moving two things that genuinely crossed a boundary and declaring the rest
  truthfully: the view direction became `shared/math/view.ts` (its callers are the render camera and the
  player's block raycast — a plugin-to-plugin import for one pure function is exactly the coupling the
  rules exist to prevent) and the UI hit-test shape became `shared/types/ui.ts` (the key bind drag in
  `plugins/input` asks the question the UI plugin answers, and a TYPE must not drag a runtime dependency
  with it). The six descriptors' `deps` now mirror reality (`input` and `world` first, then `player`, then
  `ui`, then `render`, then `diagnostics`) instead of the incidental order they had. STILL OPEN: the five
  `host/` reads should become injected services, and each system's CONSTRUCTION should move out of
  `boot/main.ts` (it closes over the wiring: the views and the injected hooks) into the plugin that owns it.
- **P1.19 — the plugin LIFECYCLE: install, start, stop.** `PARTLY DONE` (the mechanism; the first real user
  arrives with the content plugin). `core/plugin` grew the two optional hooks a plugin may declare:
  `start` runs in install order AFTER `world.start()` — the moment `setup` may not assume, because
  `setup` runs while the schedule and the resource table are still being assembled, while `start` may
  inspect the finished world — and `stop` runs in REVERSE install order (a plugin may depend on one
  installed before it, so it must be torn down first), which is what the quit path and a future uninstall
  will call. `installPlugins` now also hands back the installed plugins and their apis, so `start`/`stop`
  see the same door `setup` did. Failure isolation covers the new phases: a throwing `start` disables that
  plugin and is reported, and a plugin that never started is never stopped. `check:ecs` drives all of it in
  Node (start order, reverse stop order, the throwing start, and that `start`/`stop` really are optional —
  none of the six plugins uses them yet, and the gate says so out loud). STILL OPEN: making the plugins
  resident (so a plugin could be re-started), and the barrier-safe `reconfigure()` that a hot add/remove of
  systems needs (a structural change may only happen at a barrier). The five construction sites that remain
  in `boot/main.ts` are the ten ui systems (they are built around the view entities the root creates).
- **P1.20 — content is a plugin: `plugins/content-default/`.** `PARTLY DONE`. The engine's built-in content
  is no longer a literal in the code: the LANGUAGE set (`zh`, `en`, `ja`) is declared by the content plugin
  through the new `SLOT_LANGUAGES` extension point, and `plugins.json` can turn the whole plugin off — the
  engine still boots, it simply has no declared language set of its own. It is also the first plugin to use
  the `start` phase for its real purpose (reporting what the pack chain actually delivered), which is what
  that phase was added for. `ExtensionRegistry` learned the other id spelling while this landed (a system
  carries a `name`, a content declaration carries an `id`), and the gate asserts the contributed set
  instead of the contributed counts.
  WHAT BLOCKS THE REST, measured rather than guessed: the locale is LOADED (`loadLang`) and the block
  registry is BUILT long before the plugins install, because the loading screen's own text and the
  starting hotbar need them. So a contributed language set cannot yet DRIVE `loadLang`, and blocks cannot
  move the same way. Closing that means moving the install above the config/content phase — a boot-sequence
  change (the `World` has to exist earlier, and the plugin contributions become an input to the config
  loaders instead of a consumer of them). That is the next slice; hot reload of the pack chain comes after
  it, because a reload is "re-run the content phase", which needs the same shape.
- **P1.18b, continued — the declarations follow the constructions.** `DONE` (`player` 6 + `render` 4 here;
  the ui eleven and the three remaining core plugins in the entry below). Two lessons this stretch produced,
  both worth keeping:
  (1) the boot-order invariant — a plugin factory CONSTRUCTS its systems and a system resolves its resources
  in the constructor, so the install block must sit AFTER the whole resource table and BEFORE the first
  registration; that was violated for two commits and no gate could see it, so `check:ecs` now asserts the
  order (insert < install < first registration);
  (2) the retarget hazard — moving a declaration by rewriting `instance.` to `s.instance.` also hits the
  system NAMES inside string literals (`name: "cameraView.render"`) and the EDGES that name a system; the
  schedule parser caught both immediately, which is the argument for a gate that re-resolves the real
  schedule instead of counting assertions.
- **P1.18b, finished — every plugin is DISCOVERED, and `core/` imports no plugin.** `DONE`. The
  composition root's plugin array is now exactly `[...discoveredPlugins.map((p) => p.plugin)]`: `world`,
  `input`, `content-default`, `player` and `ui` each gained a `plugin.ts`, and `ui` CONSTRUCTS its seven
  lane systems itself (the root used to build them and hand them over). Three reusable shapes came out of
  it:
  (1) **publish-back resources.** `PluginHost.instances` only goes root -> plugin, so anything the ROOT
  drives comes back as a resource the plugin inserts while the catalogue builds it: `RENDER_HANDLES`
  (P1.45), `PLAYER_HANDLES` (the input system the raw-input thread, the frame loop and the pointer lock
  drive) and `UI_HANDLES` (the reconciler, which owns the widget elements the bind drag hit-tests).
  (2) **the kernel stopped knowing a game word.** `SetMode` / `Teleport` / `SelectSlot` / `SwapSlots` moved
  to `plugins/player/commands.ts` (`core/` no longer imports `plugins/`), and the ENTITY-FREE commands — the
  toast, the frame cap, the loading screen, the hot-plug toggle — followed in P1.18d to
  `data/globals/commands.ts`, next to the resources they write. `core/effect/` now holds the mechanism only
  (`defineCommand` + the deferred queue), and `core/ -> data/` is 0 at RUNTIME (6 type-only imports, pinned).
  (3) **what the root still owns, and why.** The VIEWS and panels it spawns (spawning is a structural
  change, so WHEN belongs to wiring) and the four hot-pluggable surfaces' system instances, which wrap
  those panels — that is exactly what makes them installable at runtime. Moving those too is P1.18c.
  Verified: `tsc` 0 errors, `check:ecs` 69/69, the boot logs `PLUGIN installed 12/12` and
  `REGISTRY systems: 26 from [8 owners]` (22 systems + the 4 slot gaps), and the three `SCHEDULE` lines are
  byte-identical to the run before the migration — the strongest evidence that no order changed.
- **P1.49ab — the resource pack RELOAD (the MC mechanism, adapted).** `DONE`. The chain used to be read once
  at boot and every asset derived from it, so a pack change needed a restart (the settings panel said so on
  screen). It is MC-shaped now, and every piece of it already existed for the boot:
  * TWO STEPS, not one: `rescanPacks()` re-walks `mods/` + `resourcepacks/` (Rust is stateless —
    `preload_packs` is `packs::snapshot(&root)`, so a second call really re-reads the disk) and `installPacks`
    puts the new snapshot in force. That is MC's `PackRepository.reload()` vs `createReload`, in two calls.
  * THE REQUEST IS A FLAG CHECKED ONCE PER FRAME (`PACK_RELOAD.requested` + `maybeReloadPacks()`), the shape
    of MC's `pendingReload` + `runTick`; the raiser is a system (`ui.navigation`, on the F7 edge), because a
    lane may not call into the composition root.
  * THE CONTENT PHASE IS RE-RUN in dependency order: the declared language set (with the dictionaries
    INVALIDATED first, so a pack that only edited `lang/zh.json` takes effect), then the block table, then
    the palette.
  * THE PALETTE IS MERGED, NEVER REPLACED (`VoxelWorld.mergePalette`). This is the MC lesson that makes a
    reload SAFE: a voxel stores a NUMBER, so the number -> block mapping belongs to the ENGINE and only ever
    grows. `setPalette` re-pointed every existing voxel the moment a pack reordered its blocks; a merge
    cannot, and a block an install no longer names keeps its number (it just draws as the missing block).
  * THE WORLD IS NOT REBUILT: success only marks every loaded chunk STALE (`markAllStale`), and the chunk
    stream re-resolves their LOOKS at `RESTYLE_BUDGET_PER_FRAME` — MC's `allChanged()` -> "invalidate compiled
    geometry" -> rebuild over the following frames, minus the rebuild, because a chain change moves no vertex
    (P1.18i). Block edits keep their UNBUDGETED path (that IS one chunk the player is waiting for), which is
    why the two queues are separate sets on the voxel world.
  * THE PLAYER SEES THE LOADING SCREEN, not a frozen frame: four stages (`loading.packs.scan/build/apply/
    mesh`) through the SAME `SetLoadingStage` command the startup and the world entry use, one
    announce-paint-yield per stage, then the outcome as a raw toast.
  * A FAILURE KEEPS THE OLD CHAIN: the previous snapshot is re-installed and re-derived before the error is
    reported (MC's `rollbackResourcePacks`), so a bad pack can never leave the engine half-swapped.
  THE MAIN-MENU BACKDROP WAS THE ONE THING THE FIRST VERSION MISSED, and it is worth writing down because it
  is a CLASS of bug, not a slip: the backdrop's "which kind, which image" was decided in the `MainMenu`
  CONSTRUCTOR and baked into widget data (the root's recipe and its `UI_IMAGE` URL). The reload only cleared
  the three.js panorama scene, so after a reload the old picture stayed — the recipe still said
  `menu.backdropImage` (which paints opaque black) with the previous chain's URL, so it also HID the panorama
  behind it — while the new one never appeared. The panorama -> panorama case "worked" only because that
  scene is built LAZILY, so it does re-resolve on its own.
  FIX: `MainMenu.refreshBackdrop()` re-derives the whole answer (recipe + `UI_IMAGE`, and the panorama case
  CLEARS the image so the canvas shows through) and the reload driver calls it. The rule it generalises:
  **anything derived from the pack chain must be RE-DERIVABLE, not baked at wiring time** — the reconciler
  reads widget data every frame, so writing it again IS the mechanism. The scene teardown also disposes the
  old geometry/material/texture now, which it did not (that was a GPU leak per reload).
  VERIFIED BY HAND (debug build): with the game running, changing the pack's `background.json` from
  `panorama` to `static` and reloading logged `PACKS menu backdrop re-derived: kind=static` — the menu
  followed the new chain with no restart.
  Triggers: **F7** anywhere (including the main menu), and toggling a pack in the settings panel — MC applies
  a new selection at once, and the note on screen says that now instead of "after a restart".
  VERIFIED BY HAND (debug build): with the game RUNNING, creating `resourcepacks/.../lang/de.json` and
  reloading turned the boot line `files=12 ... zh/en/ja/fr` into `files=13 ... zh/en/ja/de=1/fr=2` — the
  rescan really re-read the disk, the new language was discovered and the dictionaries were rebuilt with no
  restart (no `frame error`, no reload failure). The in-world half (chunks re-meshed with the new textures)
  is a manual step in `docs/TESTING.md`.
  NOT COPIED (deliberately): MC's prepare/apply split across a worker pool (this engine is single-threaded by
  design, iron rule 4) and MC's shared-state dependency graph between reload listeners (there is ONE producer
  here — the chain — so the order is written out in the driver).
- **P1.49ac — a reload must invalidate what the CONSUMERS remember, not only the data.** `DONE`. The first
  reload added the missing half of "reload": it dropped the caches that held pack-derived RESULTS (chunk
  materials, baked icons, the menu backdrop). Two reports proved that is only half of it — the inventory icons
  kept the old look, and adding/removing a file in a pack looked like it did nothing — and the reason is the
  same in both cases: **a consumer that decides "nothing changed here" never comes back to read the new data.**
  * `ui.inventory` draws a slot only when its signature changes, and the signature was `type|count` — no icon.
    So a cleared icon cache was never read again, and the REQUEST for a new bake (it lives at the end of the
    draw path) never happened either. The reload now fills the paint array with the same `"\u0000"` sentinel
    `collectFinishedBakes` already used to force exactly one redraw.
  * THE ICON CACHE KEY was `type@size`, i.e. blind to the chain. A bake that was still IN FLIGHT when the chain
    changed landed afterwards and overwrote the new icon with the previous chain's pixels (same key). The key
    is now `<chain generation>|type@size`: the generation is a counter `installPacks` bumps, so a stale hit is
    impossible by construction and an in-flight stale result lands under a key nobody reads.
  * THE SETTINGS PANEL'S PACK ROWS (names + file counts) are written when the page is SHOWN, so a reload while
    that page is open showed the previous chain's rows. The reload announces itself on the config bus (a new
    `packs` kind) and the panel re-renders — the same mechanism the value-composed labels already use.
  THE RULE, generalized: for every cache that holds a RESULT derived from the pack chain, ask TWO questions —
  "is the KEY still valid?" and "will the CONSUMER ever ask again?". The first is now answered by the chain
  generation, the second by invalidating the reconcile memory (and, where the data is baked at wiring time, by
  re-deriving it: see the backdrop fix above).
  STILL OPEN (a design decision, not a bug): adding a BLOCK to a pack makes it placeable and drawable, but the
  hotbar holds the stack set that `spawnPlayer` seeded at spawn, so a newly declared block has no slot. MC has
  the same behaviour and solves it with a creative inventory built from the registry.
  VERIFIED BY HAND (debug build): a reload now logs `chain gen 2` and `inventory memory cleared (36 slot
  signature(s))`; `tsc` 0, `check:ecs` 69/69 (with new assertions pinning the generation in the key and the
  two invalidations in the driver).
- **P1.49ad — the pack page follows the FOLDER (and only the LISTING follows it).** `DONE`. The screen listed
  the chain the last INSTALL produced, so a pack dropped into `resourcepacks/` never appeared and a deleted one
  never went — and nothing in the project watched the folders (no watcher, front end or Rust; the rescan ran at
  the startup and on a reload only). It is the other half of MC's split now: `PackRepository.reload()` — LIST
  what is available, load nothing — next to `createReload`, which this project already had.
  * RUST: a new `list_packs` command walks the folders and counts files, **opening none** (`packs::listing`; a
    zip's count is -1 because counting it means unpacking it, and the screen shows that as blank, exactly what
    it already did for a switched-off pack). `preload_packs` would have meant reading and base64-ing every file
    of every pack once a second.
  * FRONT END: `textures.ts::updatePackListing(listing, disabled)` replaces the LISTING and nothing else — it
    never calls `installPacks`, which is the property the gate now pins: merely looking at the list (or adding a
    file to a pack) must not reload the world. Applying stays a decision: F7, entering a world, or toggling a
    pack (a selection change) — MC's shape too.
  * WHEN: the per-frame check (`maybePollPackListing`, the same `pendingReload`-style shape as the reload) does
    nothing unless THAT settings section is selected, and polls once a second while it is; closing the page
    resets the deadline so reopening lists at once. MC puts the identical poll in its pack screen's `tick()`,
    with the same one-second debounce.
  * THE COUNT OF AN INSTALLED PACK IS KEPT (the decoded layer size): overwriting it with the raw on-disk count
    would make the same row flip 7/6/7 every time the page polled. A pack the listing knows and the chain does
    not — one just dropped in — shows its disk count instead, which is the honest number for it. The change
    detector is what the SCREEN shows, so a big folder being unpacked cannot write a log line a second.
  * NO PROTECTION, on purpose: an enabled pack is a piece of ACCOUNTING, not a lock. Deleting a pack's folder
    while the game runs changes nothing (the chain is an in-memory snapshot of bytes), and the next APPLY simply
    rebuilds without it: missing textures fall back to the checker, a missing language falls back and the
    settings file is repaired, a missing block draws as the missing block. MC behaves the same way, and the OS
    would not let the game stop a delete anyway. The list says what the folder holds; the log says when a pack
    leaves the chain.
  VERIFIED BY HAND (debug build, page open via a harness hook): the listing appeared the moment the page
  opened (`VoxelEngineNWWebmod, VoxelEngineNWWebrp:7`), a `TestPack42` folder created WHILE RUNNING showed up
  one second later (`TestPack42:1, …`) and disappeared one second after it was deleted — with NO reload line at
  all in that run, which is the proof that the listing never applies. `tsc` 0, `check:ecs` 70/70.
- **P1.49ae — the pack selection is an ENABLED list, so a dropped pack starts OFF.** `DONE`. P1.49aa stored
  the NEGATIVE list — `disabledPacks`, "the folder is the truth minus these" — which made a pack copied into
  `resourcepacks/` enabled BY DEFINITION: it took effect at the next apply without being asked, and the folder
  was silently the only thing that decided membership. The selection is a POSITIVE list now (`enabledPacks`),
  which is what MC persists (`options.txt`'s `resourcePacks` is the selection; a new zip lands in its
  "available" column and does nothing until it is moved across). Consequences, all of them intended:
  * a pack on disk that is not in the list contributes NO bytes, and the pack page shows it in the left column
    with no file count (-1, the same thing a switched-off pack always showed);
  * enabling one is a selection change, so it applies at once (the existing reload driver);
  * priority is still the folder's name order — the list decides MEMBERSHIP, not order, and the screen has no
    reordering to express anything else;
  * MIGRATION, and it has to WRITE THE FILE: an absent key means "the folder is the selection", so the boot
    seeds the list from what is on disk (minus the old negative list, which is then dropped) and writes it back
    immediately — a migration kept in memory would run again next launch and re-enable whatever was dropped in
    between. An EMPTY array is a real answer ("nothing enabled") and is respected.
  * the settings REPAIR needed no code: `diffSettings` compares any list-valued setting element-wise, so the key
    rename only changed its comment and the examples the gate drives.
  VERIFIED BY HAND (debug build): `game/config/settings.json` had neither key, the boot logged `SETTINGS
  enabledPacks seeded from the folder (no list in the file: first run or upgrade): [VoxelEngineNWWebrp]` and the
  file came back with `enabledPacks` and NO `disabledPacks`. A `TestPack42` folder created WHILE RUNNING showed
  up in the live listing as `TestPack42:-1` (available, off), and the next reload logged
  `PACKS installed: … resourcepacks=1 disabled=1 files=11` — the new pack was on disk and NOT in the chain.
  `tsc` 0, `check:ecs` 70/70 (the new assertions drive two packs and one selection through the real
  `installPacks`/`listPacks`/`updatePackListing`, plus the migration's source shape).
- **P1.49ag — the language PICKER's rows follow the chain too, at runtime.** `DONE`. P1.36 made the language set
  CONTENT (the loader reads `declaredLanguages()`) and P1.49ac gave the pack page a way to follow the folder,
  but the picker was left behind by both: `buildSettingsPanel` spawned ONE ROW PER DECLARED LANGUAGE while the
  layout was built, so a pack enabled while the game ran delivered a `lang/<id>.json` the loader built a
  dictionary from and the picker could not show. The language was loadable and savable but not SELECTABLE
  until the next launch — the same "publishable but unselectable" drift P1.36 removed from the loader,
  standing in the one surface that offers the choice. It is a fixed-capacity POOL now (`LANG_LIST_CAPACITY`,
  in `data/globals/paint.ts` next to `PACK_LIST_CAPACITY`), i.e. the shape the pack columns already use, and
  the two events that can change the declared set re-fill it: the pack-APPLY notification on the config bus
  (the same `onConfigChange("packs")` the pack rows hear, guarded per section) and the moment the section
  OPENS (`show("lang")`), which is what covers a chain change that landed while another settings page was up.
  No barrier is involved, and that is what the pool buys: a row that already exists can be re-filled by a view
  at any time, while SPAWNING one is a structural change and may not happen outside a barrier — the same
  reason the pack list chose this shape. The rows' SELECTION is painted by `renderLangs` together with their
  text and visibility (a language that moved to another row must not leave the highlight behind), so the
  action carries the row INDEX and maps it back through the view's list, exactly as the pack rows' action does.
  STILL OPEN, and a DESIGN decision rather than a bug: a BLOCK added to a pack still has no hotbar slot until
  the next launch, because the hotbar holds the stack set `spawnPlayer` seeded (MC behaves the same way and
  solves it with a creative inventory built from the registry — see the P1.49ac note). The block TABLE and the
  voxel palette DO follow the chain already: `rebuildDerivedFromChain` re-runs both on every apply.
  VERIFIED: `tsc` 0, `check:ecs` 71/71 (a group of its own, plus the P1.36 picker assertion repointed from
  `declaredLanguages().map` to the pool).
  FIXED IN THE SAME ROUND, both reported by hand after the first build of it:
  * **the rows had NO TEXT.** `spawnButton` attaches `UI_TEXT` only when it is GIVEN a text, and `setUiText`
    on a widget without that component is a SILENT no-op — so the pool, spawned with `undefined`, rendered
    twelve empty buttons and `renderLangs` could not fill one of them. Nothing about it is loud: the rows
    were visible, clickable, correctly placed and correctly hidden when unused. An EMPTY key is enough to
    own the component; the gate now pins the trap on a real widget World (spawn without a text -> no
    `UI_TEXT` -> `setUiText` does nothing) AND the pool line that must pass one.
  * **the fourth row read `lang.fr`.** The row's label went through `t()`, i.e. the language IN FORCE, which
    has no reason to hold a name for a language it does not know — and the one dictionary that does hold it
    belongs to the language the user cannot read yet. A row that OFFERS a language is read in THAT language
    now (`i18n.tIn`, written as raw text because the string does not depend on the language in force), which
    is MC's rule and what `docs/TESTING.md` always claimed: the demo's row reads
    `Francais (FROM THE PACK)`.
  VERIFIED BY HAND, VISUALLY (packaged build, screenshots): three rows with their text, a pack's new
  language appearing as a fourth row labelled in its own language, and — after the pack's `lang/fr.json` was
  deleted while the game ran and the chain re-applied by toggling the pack — the rows back to three, with the
  reload's own summary (`files=11`, `zh=104 en=104 ja=104`) proving the rescan re-read the folder.
- **P1.18c — the tail is CLOSED: the root constructs no system at all.** `DONE`. The four optional surfaces
  used to hand their instances in as host instances (`uiPicker`, `uiToast`, `uiKeybind`, `uiInventory`) around
  panels the ROOT had spawned. Each builds its own now, panel included, in its own `plugin.ts` — which runs at
  WIRING time (the catalogue build), the only place a spawn is legal before a barrier (a `setup` may not change
  the entity structure — iron rule 1, an install is not a barrier). So **22 of 22 systems are constructed by the
  plugin that declares them**, and the tail the plugin work was chasing is closed. What came out of it:
  * the icon baker is a host INSTANCE (`iconSource`, the same three functions the root used to hand the
    inventory system) — a plugin may not import `host/`, and the baker is three.js + a render target;
  * the F3 PANEL stays a root-spawned VIEW widget (`diagnostics` reads its handles BEFORE the plugins are
    built, so the root must spawn it early), so `ui-debug` receives that one entity as an instance;
  * the key bind ENTRY array stays the root's: the menus (root-built views) spawn those buttons and push them
    in; the plugin reads it by reference — the same shape as `uiTrees`;
  * `ui-inventory` PUBLISHES its bag panel (`INVENTORY_HANDLES`), because `ui.navigation` — another plugin —
    paints the modal trees. A disabled plugin publishes nothing and the tree points at `NULL_ENTITY`, which
    paints as nothing at all (every setter no-ops on an entity without the components);
  * `ui-debug` declares `player` as a dep now: it reads CONTROL and sends SetMode itself instead of the root
    wiring those on its behalf.
  VERIFIED with this tree: `tsc` 0, `check:ecs` 70/70 (four new assertions: the root calls none of the four
  `create*System` factories, does not `new` a system, does not spawn those panels, and takes the bag panel from
  the published handle), `npm run app:windows` packages 25 files / 13.8 MB. On a real debug run the boot log is
  unchanged where it matters: `PLUGIN installed 12/12`, `REGISTRY systems: 26 from [8 owners]`, and the three
  `SCHEDULE` lines BYTE-IDENTICAL to before the move, plus `PAGE mounted keybind` / `HUD element mounted` and
  `BOOT ready in 410ms`.
  STILL ROOT-OWNED, on purpose: the VIEWS it spawns (the HUD and loading screen, the two menus, the frost
  layer, the F3 panel widget) — spawning is a structural change, so WHEN belongs to the wiring — and the
  handles the plugins publish BACK (`RENDER_HANDLES`, `PLAYER_HANDLES`, `UI_HANDLES`, `INVENTORY_HANDLES`).
- **P1.18c — the plan this executed (kept for the reasoning).** `DONE`. `ui-debug`, `ui-toast`,
  `ui-inventory` and `ui-keybind` still receive a system instance the ROOT built around a panel it spawned
  (`spawnPickerPanel`, `spawnToastPanel`, `createInventoryView`, `spawnKeybindLine`). Finishing means moving
  the PANEL spawn into each plugin too — legal (spawning is allowed during wiring, and the catalogue runs
  after the resource table) but it changes WHEN those widget entities exist, so the resource-table order has
  to be re-checked: the F3 panel's entities must be in the world before the `diagnostics` plugin is
  constructed, which is the boot-order trap `check:ecs` already guards for the install block.
- **P1.18d — the kernel names no `data/` VALUE any more, and the directions are COUNTED.** `DONE`. Two core
  files still imported the data layer at RUNTIME, which is the one thing the layer table forbids: a `core/`
  file naming a `data/` module is the mechanism depending on the program, and it is how the kernel ends up
  knowing game words. Both are gone, each by the shape that fits it:
  * **the entity-free COMMANDS moved to their data** (`data/globals/commands.ts`): `ShowToast`, `SetFpsCap`,
    `SetLoadingStage`, `ReloadPacks` and `HotPlugPlugin` write the toast, the frame cap, the loading screen,
    the reload request and the hot-plug toggle, so they now sit next to those resources — the shape
    `data/globals/ui-pages.ts` already had with `UiLayoutOp` (a data module owning a resource AND the command
    that writes it). `core/effect/` keeps the MECHANISM only (`defineCommand` + the deferred queue), and the
    four importers (`boot/main.ts`, `plugins/ui/index.ts`, `plugins/ui/systems/navigation.ts`) follow the new
    path. The commands could NOT move into a plugin: `ShowToast` reads `TOAST` whatever plugin is installed
    (P1.28), and a dep on the hot-pluggable `ui-toast` would dangle the moment it is unplugged.
  * **the UI-tables installer became an INJECTED hook.** `core/plugin/ui-tables.ts` used to import
    `UI_ACTIONS`/`UI_SOURCES` and write them; it now declares a TYPE (`UiTablesHook`: install/remove,
    nothing else) and the implementation lives in `boot/ui-tables.ts` — the one layer that may import both —
    handed to `installPlugins` (an optional `InstallOptions` field, absent = no UI lane, exactly what the old
    in-place installer treated as its no-op) and to the hot-plug host (beside its log sink). The kernel stays
    deaf to whether a UI has tables at all.
  WHAT THE GATE DOES NOW: it stops DESCRIBING the layer rules and COUNTS them — every `import` in `src/core/`
  and `src/data/` is resolved to its file and classified. `core/ -> plugins/` 0, `plugins/ -> host/` 0,
  `core/ -> data/` **0 at runtime** (6 type-only: the slot payload shapes and the boot stage keys),
  `data/ -> plugins|host` **0 at runtime** (1 type-only: `ChunkGeometry`). The two type-only counts are PINNED,
  so a new one is a deliberate act, and the rule was shown to BITE rather than assumed: a probe that adds one
  runtime data import to a core file turned the gate red with `now 1, plus 6 type-only`.
  VERIFIED: `tsc` 0, `check:ecs` 71/71 (the UI-tables group drives the injected hook — install 2, no-op
  without a UI lane, remove 2, re-install 1 — and asserts the kernel file carries no data module at all),
  `npm run app:windows` 25 files / 13.8 MB. On a real boot the log is unchanged where it matters:
  `PLUGIN installed 12/12`, the same `REGISTRY` counts, the three `SCHEDULE` lines BYTE-IDENTICAL,
  `PAGE mounted keybind` ×2, `HUD element mounted` ×2, `BOOT ready in 416ms`; a pack toggle reloaded the chain
  twice (`files=5` then `files=11`, the loading screen and the toast going through the moved
  `SetLoadingStage`/`ShowToast`) and entering a world reached `mode=game locked=1` with ZERO error lines.
  DOC FIX IN THE SAME ROUND: `AGENTS.md`'s fence for the directory map closed ~15 lines too late, so the
  "READING THE TREE" and "THE LAYER RULES" paragraphs rendered as code (and the schedule report it quotes was
  a version old); both are fixed, and the AGENTS paragraph claiming FIVE pinned `host/` reads now says what is
  true — zero, enforced.
- **P1.18e — the root's DRIVERS are files, and the root is wiring + the ONE loop.** `DONE`. `boot/main.ts`
  had grown to 1885 lines because three SEQUENCES lived inside it as sections: the startup, entering a world
  and the pack reload (with the pack page's listing poll). They are `boot/drivers/*.ts` now — and the split is
  what makes the root's remaining job nameable: create the world, insert the resources, wire the views, plug
  the plugins, own the ONE rAF chain, and hand each driver the pieces it drives.
  * `boot/drivers/stage.ts` — the SHARED half all three need: `announce` (through the `SetLoadingStage`
    command, then `world.renderUi()`), `paint` (one macrotask, deliberately not a second rAF chain) and
    `run(flow, stages)` = the walker (`core/flow/boot.ts`), so a driver owns only its own stage LIST.
  * `boot/drivers/startup.ts` — the settings check (`checkSettingsAtBoot`, which needs the FPS cap from the
    world), the window reveal, the GPU handshake and the menu hand-over, plus `BOOT_STAGES` as DATA. It ends
    by calling `deps.frame()` — still the single place a frame is kicked off.
  * `boot/drivers/world-entry.ts` — the Teleport, `prime` + `warmUp` behind the screen, the hand-over to
    `game` and the capture decision (foreground + no hand on the window + no fiddling during the load).
  * `boot/drivers/pack-reload.ts` — the F7 reload (rescan → install → re-derive → drop caches → mark stale,
    with the rollback) AND the listing poll; its own state (the poll deadline, the in-flight flag, the last
    signature) is a CLOSURE now instead of five `let`s beside the loop.
  WHAT THE ROOT KEEPS, deliberately: the rollback SEED (`lastGoodSnapshot`) — the startup installs the first
  chain before any driver exists, so the driver reaches it through a getter/setter — and the mode writers the
  menus own. Each driver takes ONE deps object of root-built values (the loop state, the two menus, the
  pointer lock, the renderer, the window queries, the spawn point), with arrows for the two menus so the
  factories may run before them.
  RESULT: `boot/main.ts` 1885 → 1460 lines, and no driver text is matched against the root any more — the
  gate reads `boot/drivers/*` for driver facts (16 assertions repointed), while the loop, the resource table
  and the wiring checks stay on the root. VERIFIED: `tsc` 0, `check:ecs` 71/71, the package 25 files /
  13.8 MB, and on a real run the boot log is unchanged where it matters (`PACKS installed … files=11`,
  `PLUGIN installed 12/12`, the same `REGISTRY` counts, the three `SCHEDULE` lines byte-identical,
  `PAGE mounted keybind` ×2, `SETTINGS ok`, `BOOT graphics ready at 363ms`, `BOOT ready in 402ms`); two pack
  toggles reloaded the chain (`files=5` then `files=11`), and entering a world logged
  `MAINMENU entering singleplayer (world type: superflat)` → `WORLD ready at 2301ms` → `LOCK request
  [world entered]` with `mode=game locked=1` and ZERO error lines.
- **P1.18f — the pack chain travels as BYTES, and its read is off the main thread.** `DONE`. The first step of
  the multithreading route, and it needed no threads of ours:
  * `preload_packs` and `list_packs` are `#[tauri::command(async)]` now. Tauri runs a command WITHOUT that
    attribute on the **main thread**, so reading the whole chain (2.8 MB of textures in the sample pack) was
    blocking the event loop.
  * **No base64.** `packs::snapshot` used to base64 EVERY file into a JSON string: +33% on the wire, and the
    front end paid `atob` + a per-byte loop **on its main thread** for a chain a reload re-reads in full. One
    binary body now (`[u32 LE header length][header JSON][blob]`), parsed by `decodePackSnapshot`, whose file
    values are **views into that buffer** — no copy, no decode. The `base64` crate is gone from `Cargo.toml`.
  * **A folder pack's own `assets.zip` is SKIPPED**: that key is dead (it normalises to itself and nothing ever
    resolves it), and the sample resource pack's zip is 2.8 MB — a byte-for-byte copy of the loose tree beside
    it — so it was read, encoded, shipped and parsed for nothing.
  VERIFIED: `tsc` 0, `check:ecs` 72/72 (a group drives the decoder on a synthetic body and asserts the views
  share the buffer), boot `PACKS installed` **248 ms → 171 ms** with the chain intact
  (`files=11 → 10`, `zh=104 en=104 ja=104`, `BLOCKREG 7 blocks`, the same `REGISTRY`/`SCHEDULE` lines).
- **P1.18g — the menu backdrop is rebuilt only when the BACKDROP changed.** `DONE`. Step 1 removed the pack
  transport from the main thread and the reload hitch did not move (90.5/98.4 ms before, 93.1 ms after) —
  which is what isolating it proved: it only happens when the resource pack is in the chain, and it is
  transport-independent. The cost was the **menu background**: `backgrounds/panorama.png` is 2.2 MB,
  `resolveTexture()` turned it into a base64 `data:` URL (a 2.2M-character `String.fromCharCode` spread plus
  `btoa`, tens of milliseconds of main-thread work) and the reload dropped the scene unconditionally, so the
  PNG was re-decoded and re-uploaded on EVERY reload — including F7 and including toggling a pack that ships
  no background at all.
  * `MenuBgState` carries a **`signature`** (the kind + an FNV-1a hash of the image that kind resolves), and
    `refreshMenuBackground()` re-derives from the chain in force and answers **whether the backdrop itself
    changed**. The reload driver disposes and re-derives only when that answer is true, and logs
    `PACKS menu backdrop kept (unchanged)` or `re-derived` so the decision is visible. A hash rather than a
    length, because a same-size edit would fool a length; ~2-4 ms against ~90 ms is the trade.
  * The PANORAMA is loaded from its bytes through a **Blob object URL** (revoked when the texture is in), not
    from a `data:` URL: the browser reads the file itself instead of the main thread base64-ing it first.
  VERIFIED BY HAND (packaged build, real clicks): `tsc` 0, `check:ecs` 73/73 (a group drives the real module
  against synthetic chains: the same bytes twice → `false`, a swapped image → `true`, panorama → checker →
  `true`, then settled), the reload that does NOT touch the backdrop costs no frame over 25 ms, and the reload
  that really rebuilds it went **93 ms → 47 ms** (`stalls=0`, where it used to count one) — with the menu
  still showing the pack's panorama and ZERO error lines in the log.
  STILL ON THE ROUTE (deliberately not done): the panorama's PNG DECODE + GPU UPLOAD (~35 ms of what is left)
  cannot be skipped when the picture really changes; Worker-pool chunk generation/meshing is step 2, and it
  waits for real terrain to be worth measuring.
- **P1.18h — the FIRST real multi-core path: chunk meshing runs on WORKERS.** `DONE`. Step 2 of the route, and
  the reason it does not touch the schedule at all: meshing is one INDEPENDENT JOB per chunk, so it needs no
  batch model, no archetypes and no shared world — it needs a pure function and a transport.
  * `data/world/mesh.ts` is that function (`meshChunk`): voxel BYTES in, positions/normals/uvs/indices plus the
    look slots out. No three.js, no GPU, no block table, no `VoxelWorld` — and it is ALSO the main thread's own
    path (`ChunkGeometry.rebuild` = gather → `meshChunk` → `apply`), so a worker path that computed something
    slightly different is impossible: there is one mesher, used twice.
  * the INPUT is deliberately small: the chunk's own voxels are left out entirely while the chunk is UNIFORM
    (the value says everything and the scan only visits the boundary shell — which is the case the whole flat
    world is in), and the only outside information is six 32×32 neighbour SOLIDITY planes. Both are built fresh
    per job and TRANSFERRED, never copied.
  * the looks come back as KEYS (`(voxel value << 2) | kind`): the palette, the block table and the pack chain
    behind them are main-thread state, so `ChunkGeometry.apply` resolves each key with the SAME `specFor` the
    old in-place scan used. A chunk's material list is identical whichever thread meshed it.
  * `host/browser/mesh-pool.ts` owns `hardwareConcurrency - 1` workers and only produces a QUEUE; the render
    lane's `chunk.stream` step drains it and applies the results INSIDE the lane, so nothing touches the scene
    from a worker callback and the order stays deterministic. `CHUNK_MESHES.inFlight` is the validity token — a
    key that left it was rebuilt on this thread (a block edit) or left the window, so a late result is dropped
    instead of overwriting fresher geometry.
  * BLOCK EDITS STAY ON THE MAIN THREAD on purpose (the player is watching one block; a round trip would put
    the mesh a frame or two behind the click) and so does a world with no workers: the pool is an INJECTED
    capability (a `host/` object the plugin may not import), and absent = exactly the behaviour before this
    round. A worker that dies answers `null` for its job and that chunk is meshed on the main thread, so a
    failure costs a frame and never a hole.
  VERIFIED: `tsc` 0; `check:ecs` **75/75** with a group of its own — the pure mesher's faces/slots/fast paths
  driven directly, the queue→drain→apply orchestration with the REAL mesher behind a fake transport, one job
  per chunk in flight, the failure fallback, and the two thread rules (an edit stays local, a pack reload's
  stale chunks are handled without a worker job); the package builds a `dist/assets/mesh-worker-*.js` chunk of
  its own; and on a real run the boot logs `RENDER meshing: 11 worker(s)` while entering a world went from
  **`WORLD ready at 2301ms` to 97ms** (same click path, same spawn window), with `mode=game locked=1`, 60 fps
  and `stalls=0` afterwards. STILL OPEN: chunk GENERATION is still on the main thread (it is cheap now — a
  uniform fill per chunk — and it owns the world's `Map`, so it is the next thing to move once terrain is real),
  and nothing else has been parallelized: the schedule's batches remain computed-not-executed.
- **P1.18i — the pack reload RESTYLES instead of re-meshing, and a failing worker is loud.** `DONE`. The two
  things P1.18h left as warts, found by reading a real 154 s log (44 pack reloads, ~2856 chunks marked stale
  each time, worst frames 33–54 ms).
  * **WHY A RELOAD NEVER NEEDED A RE-MESH**: a mesh's vertex data depends on the VOXELS alone — every uv is a
    per-face constant — so a new resource chain cannot invalidate a single position, normal or uv. What the
    chain changes is what a block LOOKS like, and the LOOK is stored on the geometry as one resolved
    `ChunkFaceSpec` per group. `ChunkGeometry` now keeps each slot's KEY (`(value << 2) | kind`) beside its
    specs, and `restyle(voxel)` re-resolves that list IN PLACE. The palette is append-only (`mergePalette`), so
    an already-stored value still names its block; `geometry.groups` needs no update either (a slot index is
    still the same material index). This is the difference between a reload costing a few thousand chunk meshes
    and costing a few thousand LOOKUPS: the mesh, its GPU buffers and its groups never move, and the pool is
    not asked for anything.
  * the stale queue keeps its own budget (`RESTYLE_BUDGET_PER_FRAME = 128`, vs 24 for meshing) because the work
    is not comparable — one lookup per material group vs a 32³ neighbourhood scan and a full vertex rewrite. It
    stays budgeted so a frame cannot grow with the size of the streamed window.
  * **THE QUEUE IS DRAINED BEHIND THE LOADING SCREEN**, which is the second half of the round and the reason
    the game frames are untouched: `chunkStream.restyleStale(yieldTo, onProgress)` runs the same
    `restyleNext(128)` batch the render lane uses, yielding between batches, and the reload driver drives it
    from `restyleBehindScreen()` — the SAME shape as `enterWorld` driving `warmUp` into that screen, reached
    through the published `RENDER_HANDLES` (a plugin type a driver may not import). The loop is BOUNDED
    (`RESTYLE_DRAIN_BATCHES` = 256 batches), so a world larger than this one cannot wedge a reload's screen:
    whatever is left is drained by ordinary game frames. WHY: left to the game frames, the first frame after
    the screen came down carried the material rebuild (measured 32 ms) and the window showed the PREVIOUS
    chain's looks for ~24 more frames. The driver also drains on the ROLLBACK path, so a failed reload puts
    the old chain's looks back behind the same screen.
  * **A FAILING WORKER IS PER-WORKER AND LOUD** (`host/browser/mesh-pool.ts`): a slot tracks its OWN pending
    job ids (the old handler failed every job in the pool), a failure reports ONE line through an injected log
    (`MESH worker failed (i/N): <why>; J job(s) re-mesh on the main thread; K worker(s) left`), the DEAD WORKER
    IS TERMINATED AND DROPPED so the others keep the throughput, and a pool that loses every worker reports
    `workers = 0`. That last one was a real hazard: the chunk stream read "no free slot" as "saturated" and
    would have stopped meshing the world entirely, so `ChunkStreamSystem.hasPool` treats a pool with no worker
    as ABSENT (main-thread meshing), and the render plugin hands the stream `null` for a pool that never
    started one (`main thread only (no worker started)`) — before this, a machine that blocks module workers
    got a pool object with zero slots and never meshed anything.
  VERIFIED: `tsc` 0; `check:ecs` **75/75** with the reload assertion FLIPPED (the gate drives a real
  `VoxelWorld`, marks every chunk stale, and asserts every loaded mesh is restyled EXACTLY once while not one
  chunk is re-meshed on this thread AND not one is handed to a worker), plus the sync batch the screen drain
  loops (empty queue, one restyle per mesh, no worker job) and source assertions for the pool's per-worker
  retirement, `hasPool`, the plugin's zero-worker guard, the geometry's slot keys, `restyleStale`'s guard and
  the driver's two `restyleBehindScreen()` calls. In the real app a pack toggle inside a LOADED world logged
  `3016 chunk(s) stale, 3016 restyled behind the screen (looks only, no re-mesh)` and the ground switched to
  the new pack's texture with NO game frame over ~35 ms, back to ~17 ms with `stalls=0` (the A/B was made
  unambiguous with a throwaway pack that overrides `block/grass_block_top.png`); the worker failure path was
  driven against the REAL compiled pool with a stubbed `Worker` (per-slot failure, drop, terminate, the
  pool-empty line, and the no-worker-start line).
- **P1.21 — the ui plugin is REMOVABLE (mechanically).** `DONE`. Disabling `ui` in the manifest used
  to crash the boot: the composition root did `installOutcome.apiOf("ui")!` and threw when it was missing.
  It now logs `PLUGIN ui is not installed - the ui lane is off …` and carries on, and `installPlugins`
  reports any installed plugin whose declared `deps` are missing (`PLUGIN x depends on "y", which is NOT
  installed`). What "removable" does NOT mean yet: with the ui lane off nothing paints, because the loading
  screen and the menus are ui surfaces — it boots, and shows nothing. Making it MEANINGFUL is the ui split
  below.
- **P1.22 — the launch white flash is fixed, and it is one config line.** `DONE`. The window carries
  `"backgroundColor": "#000000"`, which wry turns into
  `ICoreWebView2Controller2::SetDefaultBackgroundColor` — the documented cure for WebView2's white first
  frame. Verified by hand: the flash is gone. Why that line exists, and why "await rAF before
  `showWindow()`" must NOT be implemented naively (the rAF chain starts after the boot flow, and the window
  is hidden, where Chromium throttles rAF), are recorded in AGENTS.md. STILL OPEN: the ui split — a REQUIRED
  core (reconciler + loading + hud + navigation) versus OPTIONAL surfaces (F3/debug, the key bind page, the
  toast, the backpack) — so that turning a plugin off is something a player actually wants; and the test
  machine's C: drive (≈380 MB free, with the WebView2 profile on it) slows the first paint and widens that
  race, which needs no code to fix.
- **P1.23 — the ui SPLIT starts: the DEBUG surface is a plugin of its own (`plugins/ui-debug/`).**
  `PARTLY DONE` (1 of the 4 optional surfaces). The F3 debug panel and the F3+F4 game-mode chord moved out
  of `ui` into `ui-debug` (one system, `ui.picker`, plus the `PICKER_STATE` resource it owns and the
  `spawnPickerPanel`/`createPickerSystem` factories). Disabling it in `plugins.json` now removes exactly
  that surface — no F3 panel, no mode chord, every other ui surface untouched — which is what P1.21 only
  claimed. The rewriting rule the split produced (and the reason it is not just "move a file"): **an order
  edge may never name a system another plugin decides whether to install.** `ui.toast`/`ui.widgets` used to
  say `after: ["ui.picker"]`; a disabled `ui-debug` would have left those names dangling (and the boot now
  fails LOUDLY on an unknown name, which is the only reason this is safe to do at all), so both edges are
  declared on the picker instead (`before: ["ui.toast", "ui.widgets"]`) and `ui`'s own chain stays complete
  without them (`ui.toast` follows `ui.inventory`; the picker slips in between). A surface's STATE moves with
  the surface: `PICKER_STATE` is contributed by `ui-debug` now, asserted by the gate. STILL OPEN: the other
  three surfaces (the toast, the key bind page, the backpack) and the same treatment for the `ui` core
  itself (reconciler + loading + hud + navigation stay required, because without them the window is blank).
  Doc note for whoever does the next one: a `before:`/`after:` LITERAL inside a COMMENT is parsed by the
  gate's naive edge extractor (`registrations()` in `scripts/check-ecs.mjs` matches text, not syntax) and
  produced a phantom self-edge — write the prose without the bracket form.
- **P1.24 — HOT-PLUG: a plugin can be installed and uninstalled while the process runs.** `DONE` (the
  mechanism + its first real user: the `ui-debug` surface, toggled with **F8**). The boot is no longer the
  only moment a plugin can arrive: `core/plugin/hotplug.ts` is `installPlugins` without the restart —
  `hotInstall` runs the same three phases the boot does (`setup` contributes, the systems join the schedule,
  `start` may look at the assembled world) and `hotUninstall` stops the plugin, WITHDRAWS its contributions
  (`ExtensionRegistry.withdraw(owner)`, the mirror of `contribute`) and undoes what they stood for
  (`world.hotRemoveSystem` / `world.removeResource`). Both are barrier-only, and the door is a COMMAND
  (`HotPlugPlugin`, flushed at the top of every entry point) — installing a plugin re-resolves the schedule,
  which is exactly the kind of structural change that may not happen under a running system.
  What it refuses, with a reason instead of a half-install: an id outside the catalogue, `deps` that are not
  installed, a second install, and an uninstall that another INSTALLED plugin still depends on (the
  reverse-dependency guard, which reads the whole plugin list, not just the hot one). A `setup` that throws
  after filing a system leaves NO trace: the contributions are withdrawn and the systems removed again.
  The observation that made it possible, and the rule for the next surface: **a plugin is hot-pluggable
  exactly when its `setup` alone is enough to install it.** `plugins/ui-debug` therefore became
  `createUiDebugPlugin(instances)` — a FACTORY that declares its own system and inserts its own resource when
  the world has not (idempotent), so boot and runtime install the SAME value and cannot drift. A plugin whose
  systems the root declares for it (`declare*Systems(api, instances)`, which is still how `ui` works) can be
  installed at boot but not at runtime, because nothing re-runs the root's wiring. Its surface comes down
  through `stop` → `UiPickerSystem.close()`: an unplugged plugin must not leave a panel on screen with no
  system left to close it. The key and the label are DATA (`data/globals/hotplug.ts`), so the ui lane offers
  the chord without knowing a single plugin id, and the outcome arrives as a raw toast (a window with no
  console has no other way to report it). STILL OPEN: hot-plug for a plugin that needs a `stop` on the QUIT
  path (`stopPlugins` still walks the boot's install order), and setting a plugin's contributions up for
  REMOVAL when they are component schemas (a component cannot be withdrawn from a live entity yet, so the
  hot-pluggable surfaces are the ones that bring systems + resources).

- **P1.25 — the key bind PAGE is a plugin of its own (`plugins/ui-keybind/`), and hot-pluggable on F9.**
  `DONE` for the behaviour; the page's WIDGETS still live in `plugins/ui/views/menu.ts` (see below).
  `UiKeybindSystem` + `UI_KEYBIND_ACCESS` moved out of `ui` with its declaration (`ui.keybind`), its edges
  moved onto the plugin (it now says `after: ["ui.toast"]` / `before: ["ui.navigation", "ui.widgets"]`, and
  `ui.navigation`/`ui.widgets` no longer name it — the P1.23 rule, applied a second time), and the plugin is
  a factory (`createUiKeybindPlugin`) so the boot list and the runtime catalogue hold ONE value.
  THE INTERESTING PART: the way IN. The "key binds" entry button is spawned HIDDEN by the view and shown by
  `ui.keybind` every frame, so **"the plugin is off" means the tab is not reachable in either menu**, instead
  of opening a panel nothing fills — and a runtime install (F9) makes the tab appear, which no boot-time
  boolean could have done. Its `stop` → `UiKeybindSystem.close()` hides the entry and steps `UI_MODAL.settings`
  back to the settings list if the page was open. What made it cheap: the sub-page navigation was ALREADY
  data (`ui.navigation.paint()` iterates the panel maps and derives visibility from `UI_MODAL.settings`), so
  no navigation refactor was needed — only the entry handle, which `SettingsPanels.keybindEntry` +
  `Menu/MainMenu.keybindEntryEntity` now hand to the root. STILL OPEN: moving the panel CONSTRUCTION (the
  chips/keycaps/keycap-hit-test + the drag's arm paths in `views/menu.ts`) into the plugin's own view, which
  is what would let the ui plugin drop the widget prefabs it only serves that page; and the other two
  optional surfaces (the toast, the backpack).
- **P1.26 — the key bind page's WIDGETS moved too.** `DONE`. `plugins/ui-keybind/views/keybind.ts` now owns
  everything the page is made of: the action chips, the visual keyboard (chips, keycaps, legends, the
  OS-layout fetch), the ENTRY button, the two mouse-button arm paths with the click shield's arming, the
  keycap hit test the device layer asks for, and the rubber-band prefab. `plugins/ui/views/menu.ts` keeps
  the settings LAYOUT and ASKS for the tab: the mount shape lives in a data module
  (`data/globals/keybind-tab.ts`) so that neither plugin has to import the other, `plugins/ui-keybind`'s
  `setup` inserts its builder under the `KEYBIND_TAB` token (install time, i.e. before the views are wired),
  and `buildSettingsPanel` calls it only when the token is there. So a build without the plugin has no tab,
  no entry button and no rubber band — and `ui` no longer mentions a keycap at all (the gate asserts it, the
  same way it asserts the KBCAP probe now lives in the plugin). `ui-keybind` declares `["ui", "input"]`: the
  bind TABLE is `plugins/input/keybinds.ts` and this view reads it to draw the chips.
  STILL OPEN, and worth knowing before the next surface: a RUNTIME install (F9) cannot add the tab if the
  plugin was OFF at boot — the settings layout builds its tabs once during wiring, so there is no button to
  show. Uninstalling and re-installing a plugin that was ON at boot works (the button exists, hidden). The
  fix is a "tab host" the plugin fills on install (one per menu); until then the F9 demo needs the plugin
  enabled at boot.
  FIXED LATER IN THE SAME ROUND — the drag's RESIDUE: the rubber band's geometry and visibility are written by
  `step()` every frame (derived from the KEYBIND_GESTURE resource + POINTER), so a `stop` that only hid the
  entry buttons left the band frozen on screen when F9 landed mid-drag, with the gesture still live (a
  re-install resumed drawing it). `close()` now clears `drag`/`hover`/`shield`, ends the capture, clears the
  hovered keycap and hides the band itself — an uninstall has no "next frame" to rely on, which is exactly why
  ESC (which leaves the system running) never showed the bug. STILL DEBT:
  `installBindGestureHandlers` (plugins/input/bind-gesture.ts) registers its four document listeners once and
  returns NO disposer, so they outlive an uninstall — inert today (a hidden panel cannot be hit, `drag` is
  null, the capture is over) but wrong for a plugin that can be cycled repeatedly.
  The toast and the backpack are still in `ui`.
- **P1.27 (step 1) — the ui lane's optional surfaces are ordered by CORE SLOT ANCHORS.** `DONE`. The blocker
  the key bind split exposed: two widget WRITERS must be ordered (the conflict model is per COMPONENT, not per
  entity), but a surface that can be DISABLED may not appear in another surface's order list — the name
  dangles the moment that plugin is off, and the boot refuses an unknown name. The core therefore owns three
  no-op anchors (`ui.slot.debug` / `ui.slot.toast` / `ui.slot.keybind`), chained among themselves and to the
  core's own writers, and every optional surface declares "after the anchor before it, before its own anchor".
  Any SUBSET of surfaces is then totally ordered, and no surface ever names another. `reads: [UI_STATE]` on an
  anchor is deliberate: it conflicts with every writer, which keeps the anchor in a batch of its own instead
  of being batched with an unrelated system. The gate asserts the lane's batch sequence including the anchors
  and enforces the rule itself (no optional surface may order itself against `ui.picker` / `ui.toast` /
  `ui.keybind`). NEXT STEP, now mechanical: move the toast into `plugins/ui-toast` (its slot already exists),
  then decide the backpack/hotbar ownership and do the same.
- **P1.27 (step 2) — the HUD TOAST is a plugin (`plugins/ui-toast/`), and it hot-plugs BOTH ways.**
  `DONE`. `UiToastSystem` + `UI_TOAST_ACCESS` + the `ui.toast` declaration + the `TOAST` resource left `ui`,
  and so did the WIDGETS: `spawnToastPanel` (a panel + a label) moved out of `views/hud.ts`. The reason this
  surface is fully symmetric while the key bind page is not: **its panel is TOP-LEVEL (parented to the UI
  root), so it needs no mount inside a layout somebody else owns** — the "tab host" gap simply does not
  exist for it. It is therefore the first surface that can be installed FROM OFF at runtime: press F10 and the
  toast works, because the widgets exist and the system only writes their data. Its edges are the core's slot
  anchors (`after: ui.slot.debug`, `before: ui.slot.toast`), so turning off any other surface cannot dangle
  them. `close()` takes the panel down and clears the armed message, so an uninstall cannot leave a stale
  toast and a re-install cannot immediately show one (the same class of residue the rubber band had).
  REMEMBER: a surface that brings WIDGETS INTO ANOTHER VIEW'S LAYOUT still needs the tab host (below).
- **P1.27 (step 3, open) — the BACKPACK / hotbar.** The last optional surface inside `ui`. Before moving it,
  the ownership question has to be answered: the crosshair and the HOTBAR are the gameplay gate's widgets
  (`ui.hud` shows them only in a world) and the backpack shares `INVENTORY_WIDGETS` and the selected-slot data
  with the hotbar — so "turn the backpack off" must decide whether the hotbar leaves with it. The likely
  shape: keep the hotbar+crosshair in `ui.hud` (they are the gameplay HUD) and move the backpack panel +
  `ui.inventory`'s reconcile into `plugins/ui-inventory`, with `ui.inventory`'s icon writes splitting in two.
- **P1.28 — an uninstall must not remove the resources a plugin CLAIMED.** `DONE`. The F10 test log showed
  it as a real defect: after `PLUGIN ui-toast HOT-UNINSTALLED`, EVERY later toast command threw
  `frame error: World.resource: "toast" was never registered` (12 of them, one per multiplayer-button click),
  while the same click before the uninstall was clean. `hotUninstall` had treated a `SLOT_RESOURCES`
  contribution as ownership of the object and called `world.removeResource`. It is only a CLAIM: the root's
  resource table inserts those objects (or the plugin's own `setup` does, guarded by `hasResource`), and CORE
  code reads some of them unconditionally — `ShowToast` reads TOAST whatever plugin is installed — so removing
  one turned "this surface is off" into "the engine is broken". The uninstall path now takes only the SYSTEMS
  out of the schedule and withdraws the registry claims; the objects stay, which also keeps boot and hot-plug
  on one code path (`setup`'s guard finds the object and re-claims it). Pinned twice by the gate. NOT fixed,
  because it cannot be: the feedback toast for `ui-toast`'s OWN uninstall is never shown — its painter is what
  was just removed; the `HOT-UNINSTALLED` log line is the trace. Same reasoning applies to any future plugin
  whose resource a core command reads.
- **P1.34 — the HUD host owns its elements' LIFETIME.** `DONE`. The element table (P1.32) could only show
  and hide: the crosshair and the hotbar were spawned during wiring by their views and published as handles,
  so a plugin installed at runtime could not add a HUD element, and an uninstalled one left its widgets on
  screen with nobody to write them. `UiHudElement` now carries `build`/`dispose` next to `roots`, and
  `ui.hud` MOUNTS what the table lists and DESPAWNS what left it — the whole subtree, because a despawn does
  not cascade (`subtreeOf`, shared with the page host). Both are structural changes, so both travel through
  the ui lane's one deferral, `UiLayoutOp` (moved out of the page host into `data/globals/ui-pages.ts`: one
  barrier for "spawn this", not two). The two guards the page host taught us are here as well: a `mounting`
  set (the frames between the send and the barrier would otherwise build the element again) and a `broken`
  set (a `build` that threw is logged once, never retried, and forgotten when the element disappears so a
  re-install gets a clean attempt). The hotbar's cells are a HUD element now, so `INVENTORY_WIDGETS` is
  SPARSE (`Entity | undefined`) and `ui.inventory` skips a group that is not mounted; `buildHotbar` also
  marks its paint cache dirty, without which a re-installed strip came back blank. Pinned by the gate
  (deferral, subtree despawn, dispose once, re-install, failure isolation, the adopted `roots` path) and by
  `docs/TESTING.md`'s F11 leak test.
- **P1.35 — the HOTBAR became the inventory plugin's HUD element.** `DONE`. P1.34 gave the host the lifetime
  of a HUD element, but the hotbar was still one of the CORE's two rows in the table, gated on
  `inventoryOn()` — and a gate can only HIDE, so F11 left the strip's widgets alive-but-unwritable and the
  rebuild path was never exercised (a real F11 log showed 18 install/uninstall pairs with the two boot mount
  lines and NO unmount at all). The element is now contributed by `plugins/ui-inventory` itself
  (`SLOT_UI_HUD`, order 20, `build: (mount) => [inv.buildHotbar(mount.world)]`, `gate: () => inWorld()`), so
  uninstalling that layer removes it from the table and `ui.hud` DESPAWNS the whole strip, and installing it
  again builds a new one — `buildHotbar`'s paint-cache invalidation and the now-genuinely-sparse
  `INVENTORY_WIDGETS` are the live path instead of latent code. The core contributes exactly ONE element by
  name now (the crosshair), which is what makes `SLOT_UI_HUD` the only way a HUD element gets in. Pinned by
  the gate (the plugin contributes it; the core's table no longer declares `id: "hotbar"`).
- **P1.36 — the language set is PACK-CHAIN DATA, and it DRIVES the loaders.** `DONE` (the first slice of
  P1.20's "next"; blocks and menu layouts follow the same shape). "Which languages does this install support"
  was a literal in TWO places — the content plugin's `["zh","en","ja"]` and i18n's `Lang` union — so a pack's
  `lang/fr.json` was a file no code path knew the name of. Now `data/assets/languages.ts` DISCOVERS the set
  (`BUILTIN_LANGUAGES` plus every `lang/<id>.json` the chain delivers — a new `listPackPaths()` in
  textures.ts answers "which paths EXIST", the missing half of `resolveAllBytes`), the content plugin
  declares it into `SLOT_LANGUAGES` at INSTALL time, `loadLang` moved BELOW the plugin block and builds one
  dictionary per DECLARED id (the set is the cache key, so a different install rebuilds), and the settings
  panel's language PICKER is built from the same function — one source for contribution, loader and picker,
  which is exactly the drift that made a pack's language publishable-but-unselectable. `setLang` refuses an
  undeclared language. The gate proves it end to end (synthetic pack -> real plugin setup -> real `loadLang`
  -> real `t()`), and `tools\lang-demo.bat` writes a fourth-language pack for a hand test. STILL OPEN from
  P1.20: the same treatment for BLOCKS (the registry is built before the install, and the mesher still
  ignores it) and for the menu layouts.
- **P1.36a — an undeclared language falls back to the FALLBACK language, not to the default.** `DONE`. The
  report that found it, in the user's words: "I deleted `lang/fr.json` and it came back Chinese — shouldn't it
  be English?" The old rule (`... ? l : "zh"`, inherited from the original code, and still true after P1.36
  because the default is checked first) answered "which language is in force" with the first-run DEFAULT for a
  value it did not recognise, while the very next lookup for a missing WORD went to English (`en`, MC's en_us
  convention) — one rule, two answers, and the visible one was the surprising one. `langOf()` now tries the
  fallback language first and keeps `zh` for what it always meant: a fresh install with NO stored value
  (`createLocale`). The settings repair still rewrites the file with the value in force, so it now writes
  `en` where it used to write `zh`; the report that lists the fixed keys is unchanged, i.e. P1.36's option B
  (a per-install REASON in the log — "this install does not declare fr") is still open. Pinned by the gate.
- **P1.36b — the fallback is resolved in the LOADER, and the reader shares the rule.** `DONE`. P1.36a fixed
  the READER (`langOf` trying `en` before `zh`) and did NOT fix the game: `createLocale()` hands the loader an
  object that ALREADY holds the first-run default, so "do not write when the stored value is undeclared" left
  `zh` — a DECLARED language — in place, and the reader never saw the undeclared value at all. Reproduced
  read-only against the compiled modules before touching anything: `fr` and `xx` gave `locale.lang=zh
  getLang()=zh`, `en` gave `en`, a missing key gave `zh`. `loadLang` now RESOLVES the value in force (declared
  -> as it is; undeclared or wrong type -> the fallback; no value at all -> the default the object came with)
  through ONE `fallbackLang()` that the reader uses too, so the repair writes `en` where it used to write `zh`.
  The gate check was rewritten to drive the REAL shape (a `createLocale()` object plus the file value as an
  argument, one case per row of the table) — the old one constructed an input state the boot cannot produce,
  which is precisely why it passed while the game came up Chinese. Lesson for every future check: build the
  input PRODUCTION builds, not the input that makes the assertion easy.
- **P1.37 — the BLOCK TABLE is pack-chain data too, and the install declares it.** `DONE` (P1.36's shape, one
  level down, and the second half of P1.20's "next slice"). `blockregistry.ts` used to read the pack chain
  ITSELF, in `loadBlockRegistry()` at config time — before the plugins installed — so "which blocks does this
  install have" could not be a declaration and the content plugin had nothing to say about content. Now
  `data/assets/blocks.ts` is the DISCOVERY half (merge every `data/blocks.json` layer, keep the empty-chain
  `missing` fallback with it, report the layer count), the content plugin contributes the entries into the new
  `SLOT_BLOCKS` at install time, and `buildBlockRegistry(entries)` assembles the engine-side definitions
  (label / three face textures / the missing-texture flag) from THAT — first build wins, and the registry no
  longer mentions `resolveAllBytes` at all (the gate asserts that). The reader functions stopped
  self-loading: `getBlockDef`/`allBlockIds` are plain table lookups, and the build belongs to the install. The
  one thing that could not move is the STARTING INVENTORY: the player entity is spawned before the install
  (moving it means moving the whole resource table with it — the deep boot reorder P1.20 describes), so it is
  seeded from `discoveredBlockIds()`, the same discovery the plugin declares from, which is why the two cannot
  disagree. Pinned by the gate end to end (synthetic pack -> real plugin setup -> real build -> real
  `getBlockDef`) plus `tools\blocks-demo.bat` for a hand test. What is STILL not data: the table is not
  consulted by the MESHER (it draws the built-in checker block), and the menu layouts remain un-declared.
- **P1.38 — the re-install contract is written down AND enforced.** `DONE` (priority 2 of the plugin-system
  list). Hot-plugging means `setup` runs more than once, and nobody had written down what that implies. The
  gate now replays the REAL sequence for every hot-pluggable plugin against a real World and a real registry —
  `setup -> WITHDRAW -> setup` (the uninstall is what clears the owner's filings) — and asserts the system comes
  back, the resource claims come back, and the resource OBJECT the world holds is the same one (resources are
  not withdrawn with the plugin, P1.28). It also pins the trap this uncovered: filing an id that is STILL
  there THROWS, even for the same owner — the first version of the check ran `setup` twice with no withdraw and
  the registry rejected `pickerState`, so the rule is "the uninstall withdraws first", not "setup is
  idempotent". `Plugin.setup`'s doc now states the contract, `PluginApi` grew `insertResource`
  (once-semantics, so a re-install cannot throw on a resource that outlived its plugin), and the gate asserts
  every plugin's setup SPAWNS nothing (widgets are contributed as DATA and mounted by a host at a barrier).
- **P1.40 / P1.41 — the catalogue is DISCOVERED, and the UI tables belong to the framework.** `DONE` (plugin
  priorities: 1 step 1, and the extension-point half of 4). **P1.40**: the plugin list was three
  hand-maintained blocks in `boot/main.ts` (the boot array, the hot catalogue, and one factory call per
  optional surface), so a folder nobody wired was invisible and a surface nobody catalogued existed but had no
  F8-F11 key. `plugins/<id>/plugin.ts` is the opt-in now and `boot/plugin-catalog.ts` globs the tree at BUILD
  time (`import.meta.glob("../plugins/*/plugin.ts", { eager: true })` — no hand-written list, no runtime disk
  lookup, no dynamic-import failure mode); `core/plugin/host.ts` publishes host services BY NAME and each
  plugin's own adapter narrows the ones it needs, so the framework never models a plugin's types. The four
  optional surfaces opted in and the root no longer constructs them. STILL OPEN: `player`/`render`/`ui`/
  `diagnostics` cannot move yet — the root USES the handles they construct (their systems and views), which is
  the same reason the ui systems are declared by the root; the gate now names exactly which folders are still
  hand-wired, so the remaining migration cannot be forgotten. **P1.41**: `SLOT_UI_ACTIONS` / `SLOT_UI_SOURCES`
  let a plugin FILE an action or a bound-widget source, and the framework installs it at install time and
  REMOVES it with the plugin (`core/plugin/ui-tables.ts`). Before this, a plugin that registered an action by
  hand from `setup` kept the id claimed after an uninstall — a re-install threw `already registered`, and a
  stale handler stayed reachable from a widget that outlived its plugin.
- **P1.39 — uninstall teardown is a FRAMEWORK capability.** `DONE` (plugin priority 3). `api.onStop(fn)` files
  a teardown NEXT TO the surface it undoes; `runTeardowns` runs them at the barrier, in reverse registration
  order, exactly once, with per-task isolation — and BOTH leave paths run them (an uninstall, and quitting,
  which no longer skips a plugin that has no `stop` hook). `ui-inventory` migrated its bag closing onto it.
- **P1.42b — the four `ui.slot.*` anchors ARE gaps now.** `DONE`. `plugins/ui/index.ts` drops
  `reads: [UI_STATE]` + `run: () => {}` for `gap: true`, and the real schedule reports
  `ui: 11 systems + 4 gap(s), 13 batches` with the SAME grouping: the anchors were never doing work, and the
  EDGES to their neighbours are what keep the optional surfaces ordered — which is why nothing about the batch
  structure moved. The gate's source PARSER had to learn the flag too: without it the gate kept modelling the
  four anchors as no-op systems, i.e. it asserted a schedule the game does not run (the same blindness class as
  P1.33). The report marks a gap with `*` and stops counting it as a system.
- **P1.43 — the core plugins start moving onto the discovery path.** `DONE` for `diagnostics`
  (`plugins/diagnostics/plugin.ts`, `hot: false`: turning measurement off is a manifest decision). The root's
  hand-wired list is down to six names, and the gate asserts both that list and that EVERY folder is either
  discovered or named there. WHAT BLOCKS `player` / `render` / `ui`, measured rather than guessed: the root
  USES the handles their factories construct — `renderer` / `chunkStream` / `cameraView` in the boot and world
  drivers, `player.input.prepareUnlock` in the navigation deps, and the ui plugin's ten systems and view
  entities — and hands them to other factories. `PluginHost.instances` is one-way (root -> plugin), so what the
  move needs is the reverse direction: **a plugin PUBLISHES what the root must use as a RESOURCE**
  (`RENDER_HANDLES`, `UI_HANDLES`, ...), filled by its own `plugin.ts` at construction time and read by the
  drivers that need it. That is a refactor of three boot-driver call sites, so it is a slice of its own; until
  then the list stays explicit and the gate keeps it honest.
  TWO CONCRETE OBSTACLES FOUND WHILE ATTEMPTING THE `render` SLICE (written down so the next attempt does not
  rediscover them, and because the attempt was REVERTED rather than left half-done): (1) removing the five-line
  factory call in `boot/main.ts` needs a SPLICE, and **pwsh's `Get-Content`/`Set-Content` round-trip DAMAGED the
  file** — it prepended a BOM and turned every em dash into mojibake, because the file is UTF-8 and the
  round-trip did not preserve that. The SAME splice through **Node** (`fs.readFileSync`/`writeFileSync`,
  `'utf8'`) is byte-exact and produced the intended 4-insertion/5-deletion diff. Use Node, never
  `Set-Content`, for a whole-file rewrite of a UTF-8 source file. (2) After ANY external script writes a file,
  the editor tool REFUSES further edits until the file is read again (the fs-observation policy), so a splice
  plus N follow-up edits must be planned as: splice -> RE-READ -> edits. (3) The remaining edits are not
  optional: with the factory call gone, `renderPlugin` (the PLUGINS entry), `chunkStream` (three call sites)
  and the host instance (`chunkMeshFactory`) all have to change in the SAME round, and the tree is red until
  every one of them lands — which is why the slice was rolled back instead of being left in that state.
- **P1.45 — `render` is DISCOVERED, and the "publish the handles" shape exists and is USED.** `DONE`. The
  first of the three core plugins to move, and the one that proved the shape P1.43 asked for: the root DROVE
  the render systems by hand (the boot driver primes and WARMS the chunk stream, the menu frame steps the
  background) while `PluginHost.instances` only goes root -> plugin. Now the plugin's own `plugin.ts` builds
  its wiring from the host (the platform MESHER is a host instance: a plugin may not import `host/`),
  PUBLISHES what the root drives into `RENDER_HANDLES` (`data/globals/render-handles.ts` — typed structurally
  and deliberately narrow, and it had to match the REAL signatures: `warmUp` yields and takes an OPTIONAL
  progress callback), and the root reads that resource at its call sites. `boot/main.ts` no longer constructs
  the render plugin nor lists it in `PLUGINS`; the gate's core list is down to five names.
  TOOLING NOTE, because it cost the previous round: this checkout's `pwsh` is **Windows PowerShell 5.1** —
  `Get-Content`/`Set-Content` round-trips DESTROY UTF-8 sources (they prepend a BOM and turn every em dash into
  mojibake), and the editor tool refuses to touch a file an external script wrote until it is read again.
  Whole-file work therefore goes through **Node** (`fs.readFileSync`/`writeFileSync` with a per-step "did this
  replacement land" check so a missed anchor fails loudly), and a NEW file is written as an ASCII temporary
  copy rather than through `Set-Content`.
- **P1.48 - the CROSSHAIR is a plugin, and the core table is empty.** `DONE`. `plugins/ui-crosshair/` owns the
  reticle: ONE HUD element (`SLOT_UI_HUD`, `order: 10`, gate "a world is running"), mounted by `ui.hud` and
  despawned with its whole subtree on uninstall; F5 toggles it while the game runs. It needs nothing from the
  host but `inWorld`, owns no resource and declares no system - the smallest possible HUD plugin, and the proof
  that the element mechanism carries a surface end to end. `boot/main.ts` contributes NO element of its own any
  more: the table is entirely plugin-contributed, and the gate asserts that. `tools/plugins-no-ui-crosshair.bat`
  and F5 are the two ways to try it.
- **P1.58 - capture is EXPLICIT-only: the Win-key focus FLAP is cured at the root.** `DONE`. The boot.log
  pinned it exactly: the Windows key produces `focus LOST` -> `focus GAIN` several times in a row, and every
  `focus GAIN` ran `onWinFocus`'s `relock("window focus")` - which re-opens the native capture, and since
  P1.57 that same command HIDES the cursor, so the arrow blinked in and out while the pointer was over the
  Start menu. The requests were never the bug; the REQUESTING was: a capture re-issued on an event the
  operating system is free to repeat can never be stable. Two halves, both small:
  (1) **the front end never re-requests the capture on a focus event** (`main.ts::onWinFocus` calls
  `reassertCursor()` and nothing else). The mouse is captured when the PLAYER asks for it - a canvas click,
  Resume, ESC out of a menu, the backpack key, the world entry - and given back on every real loss (a modal
  UI opening, the window leaving the foreground, a geometry change). Coming back from Alt+Tab therefore does
  NOT steal the mouse back: the blur raised the pause menu and the player resumes it, or - with no UI up - a
  click on the canvas grabs it.
  (2) **the hidden INTENT does not outlive the foreground session** (`cursor_model.rs::forget_intent`, rule
  4, called by `win.rs::on_foreground_lost` from BOTH foreground-loss paths: the window event and the ~32 ms
  `capture_foreground_check`). Without it the 8 ms sentinel re-hid the cursor on every "focus gained" all by
  itself, with nobody asking - the flap had a second engine.
  The rules are pinned by four new pure table tests (21 total: `rustc --test src-tauri/src/cursor_model.rs`)
  and by the gate, which reads the focus handler's own body (no `relock(`, a `reassertCursor()`) and the two
  Rust functions. Two riders from the same log: `releaseCapture()` is IDEMPOTENT now (it invoked the native
  release per DEVICE event, so one title-bar drag wrote 30+ `[cursor] capture on=false` round-trips, each one
  a main-thread ClipCursor+SetCursor pass), and the lock manager's dead `scheduleCursor` dep (the 0/120 ms
  focus re-assert of P1.11) went with the mechanism it belonged to.
- **P1.59 - the cursor diagnostic channel: one file, both sides, in order.** `DONE`. P1.58 removed the
  automatic re-capture on a focus event, but "the cursor is still invisible after the Win key" has three
  causes that look identical from outside - the front end ordering a hidden cursor with no capture behind
  it, Chromium answering `WM_SETCURSOR` from its cached `cursor: none`, or the desktop simply not
  REPAINTING an otherwise correct state - and they are cured in three different places. So every cursor
  decision now writes ONE line into `logs\boot.log`, carrying BOTH sides of the truth:
  `[cursor] intent visible=… want->…`, `[cursor] apply clip=… shape=… forced=…` (only ticks that changed
  something, capped at 8 lines per 500 ms by `win::trace_budget_ok` - the repetition IS the symptom) and
  `[cursor] fgcheck tore down…` from Rust; `[cursor] JS applyCursor|reassert` and the throttled
  `wingain t0/t120/t500/t1500` timeline from the front end. The shared payload is `win::cursor_trace()`
  (want / relative / shape / clipped / focused / **showing** / hCursor / pos / **under** / enforced), read
  by the front end through the new READ-ONLY `cursor_trace` command, so a probe can never change what it
  measures; `lib.rs::boot_line` is the one helper that keeps the log paths in the command bus.
  `docs\TESTING.md` (P1.59) has the decoding table: `want=2 relative=false showing=false` = the intent,
  `want=1 relative=false showing=false` = Chromium's cache, `showing=true` + invisible = the repaint.
- **P1.60 - the invisible cursor after the Win key: the ARROW GUARD + Chromium's cached NULL.** `DONE`.
  P1.59's diagnostics settled it. The log showed the capture/release/focus handling was already correct
  (`want=1 relative=false`, no capture, the front end ordering nothing hidden) and that EVERY re-capture
  was the player's own `LOCK request [menu resume]` - but that after the release handed the arrow back
  ONCE, the system reported `showing=false hCursor=0` again ~0.2 s later with `enforced` unchanged, and
  then sat there: four consecutive `RAWMON … cursorFix=0 desired=1 showing=0` windows, ended only by a
  real mouse move. Two independent causes, two fixes:
  (1) **The model stopped comparing with reality.** Rule 1 (not our foreground) forced the arrow only when
  OUR RECORD said Hidden, so a NULL that came back afterwards was never corrected. The ARROW GUARD
  (`CursorModel::arrow_guard`, ~125 ticks = 1 s, armed by `release_mouse_capture`/`on_foreground_lost`)
  makes \"we owe the player an arrow\" a bounded state: while it runs, a system that reports no cursor
  gets the arrow pushed again. Bounded, so a foreground application that hides the cursor for its own
  reasons is not fought forever - which is why rule 1 compared with our own record in the first place.
  `cursor_sentinel` also runs while the guard is armed (the front end may never speak again after a
  release), and the release now pushes the arrow IN THE SAME CALL (`win::restore_arrow`, the symmetric of
  P1.57's \"hide in the same call\" - the `focus LOST after=` probe used to read `shape=Hidden`).
  (2) **Chromium's cache is the pusher, and it can only be invalidated through the CSS.** The pointer sits
  on WebView2's render child, which belongs to `msedgewebview2.exe`, so Chromium answers `WM_SETCURSOR`
  from the NULL it cached while we were capturing - a repeated intent, and even Rust's `SetCursor`, does
  not turn that back into an arrow. So: `win::refresh_cursor` now judges ownership by the ROOT window
  (`GetAncestor(under, GA_ROOT)`), which is our HWND - the old process test refused every window we
  actually own, i.e. that path NEVER ran in this app - and it reports whether it fired; and the front end
  has `PointerLock.nudgeCursor`, a two-step CSS write (`auto` now, the real value on the next frame, which
  the ui lane's per-frame `applyCursor` performs - no timer, no new resource). `auto` and `default` both
  draw the standard arrow, so the intermediate value is invisible. Called from both \"we owe an arrow\"
  paths (foreground lost, focus regained) and NEVER while we hold the mouse.
  Three new table tests (24 total) pin the guard: it corrects a NULL that came back, it never pushes a
  cursor the system already shows, it expires, and arming it twice is idempotent.
- **P1.61 - the reconciler decides the plan under the lock that applies it.** `DONE`. P1.60's log had one
  line left that nobody had asked for: `apply … shape=Arrow forced=true` → `apply … shape=Hidden
  forced=false` → `apply … shape=Arrow`. The plan used to be computed on the CALLER's thread
  (`cursor_sentinel`, `cursor_intent`, `mouse_capture`) and applied later inside `run_on_main_thread`, so
  two reconciles queued back to back could land out of order - the middle plan had been built while a
  capture was still on (rule 2: `shape=Hidden`) and arrived AFTER the release that switched it off. The
  `forced=false` is the tell: nothing in the model's CURRENT state could have produced that plan. The probe
  and the decision now happen inside the closure, under the same `model()` guard that applies them, so the
  state a plan is built from is the state it is applied to. `probe_of` only reads Win32 - and the main
  thread is where `SetCursor`/`ClipCursor` have to run anyway - so this costs nothing. The gate pins the
  ORDER (the closure before the probe), not just the presence of either.
- **P1.62 - dragging or resizing the window must not tow the pointer.** `DONE`. Reported as "resizing or
  dragging the window yanks the cursor once". The mechanism: the capture is a **1x1 px centre lock**, and
  `ClipCursor` CLAMPS the pointer into the rectangle it is given - so recomputing that rectangle from the
  new CLIENT rect on every geometry event (which `reclip_mouse_capture` did, one per pixel of a drag) moved
  the lock to the new centre and dragged the pointer along by the same delta the window moved. It is very
  visible because Windows draws its own move/size cursor during the modal loop, and the clamp also reaches
  the input pipeline as a teleport-sized jump. Two rules, modelled on SDL:
  (1) **A MOVE/SIZE SESSION POSTPONES THE CLIP.** The existing window subclass (the Alt-menu suppressor)
  now watches `WM_ENTERSIZEMOVE`/`WM_EXITSIZEMOVE` and `WM_NCLBUTTONDOWN`/`WM_NCLBUTTONUP` and only sets a
  FLAG (a window procedure must not take the model lock: it runs during the dispatch that `ClipCursor`
  itself can trigger). `reconcile` then hands the pointer back ONCE - releasing the clip is what lets the
  window be dragged at all, a stale 1px lock freezes the pointer - arms the arrow guard without ticking it,
  and does nothing else until the session ends; `reclip_mouse_capture` returns early for the same window of
  time. SDL does exactly this: `WIN_UpdateClipCursor` returns early while `in_title_click ||
  focus_click_pending || postpone_clipcursor` (SDL_windowswindow.c:1543). A capture request clears the flag,
  so a swallowed `WM_EXITSIZEMOVE` can never wedge the clip off for the rest of the run.
  (2) **A RE-CLIP NEVER MOVES THE POINTER.** `clip_target` now keeps the 1px lock AT THE POINTER while the
  pointer is inside the window (same confinement, zero movement) and falls back to the crosshair only for a
  pointer that is genuinely outside - so even the geometry changes that never see a session (Aero Snap, DPI,
  our own fullscreen switch) cannot tow anything. That forced the CROSSHAIR to become its own question
  (`crosshair_of`): the `warp` on the hidden -> visible transition used to be derived from the clip target,
  and with the target following the pointer it would have answered "already at the crosshair" for every
  position and never fired - the `becoming_visible_elsewhere_plans_a_warp` table test caught that.
  Two new table tests (26 total) pin the pointer rule from both sides (the lock follows the pointer; a
  moved window keeps the pointer where it is).
- **P1.62b - and the CAPTURE IS DROPPED when the pointer has left the window.** `DONE`. The first version of
  P1.62 was not enough, and the user's next log said why: `relative=true` for FOUR SECONDS while the user
  dragged the window (a late `LOCK request [world entered]` re-took the capture right after the geometry
  release, so the front end believed it held the mouse again), and the clip walked `963 -> 639 -> 480`,
  dragging the pointer along at every step. The rule "keep the lock where the POINTER is" cannot help there,
  because during a title-bar or border drag the pointer is in the NON-CLIENT area - outside the client
  rectangle the rule tests. So rule 2 now says: **a capture whose window no longer contains the pointer is
  OVER** (`CursorPlan::drop_capture`): release the clip, hand the arrow back, clear the capture request and
  emit `capture-lost` so the front end does its full "hand the mouse back + pause" routine (releasing on the
  Rust side alone is the documented trap). The hidden -> visible warp gets the same guard: a pointer outside
  the window is never moved (it is a pointer the user is holding a window by). Four older table tests had to
  change with it - they had encoded the OLD "clamp it back into the window" behaviour, which is exactly the
  tow - and two new ones pin the drop and the no-warp rule (28 total).
- **P1.62c - the clip is the CLIENT AREA, and centring is a SHOW-time thing.** `DONE`, and it REPLACES
  P1.62's rule (2) and P1.62b's capture-time refusal. The next log showed both: `capture on=true ok=false`
  followed by `MOUSE CAPTURE native refused, falling back to requestPointerLock` - the drop rule had been
  applied to the capture REQUEST, and since the pointer was still on the title bar (where it is right after a
  window drag) the native capture was refused and the game landed on **Chromium's own pointer lock**, which
  brings back ESC-unlock, its cooldown, and Chromium's client-area clip that tows the pointer just as happily.
  Two rules, both from the user's own reading of the problem ("capturing should not centre, only showing
  should") - which is exactly SDL's split: `SDL_HINT_MOUSE_RELATIVE_MODE_CENTER` is an OPTION, and the recentre
  is an event of entering or leaving relative mode, not something every tick does.
  (1) **The capture clips to the WHOLE CLIENT AREA** (`clip_target(p) = fit_into(p.client, region)`):
  `centre_lock` and the `remote_session` 2px adjustment are GONE. Both earlier attempts kept a 1px lock (first
  at the client centre, then at the pointer) and both had to MOVE the pointer as soon as the window moved out
  from under it - and `ClipCursor` clamps the pointer into whatever rectangle it is given, so that move IS the
  tow. The client area needs no move at all; its job is only to keep the (hidden) pointer from wandering onto
  another application. Where it sits inside the window is irrelevant (the view comes from raw deltas), and
  "opening a menu lands on the crosshair" is the `warp` of the hidden -> visible transition, which now asks
  `crosshair_of(p)` (a 1px rect at the client centre) and still moves the pointer while it is hidden.
  (2) **A capture REQUEST is never refused for a pointer that is outside the window.** `set_mouse_capture` uses
  `clip_target` directly instead of `decide` (whose rule 2 belongs to an ONGOING capture), and it now **hides
  FIRST and clips after**: the one-time clamp at capture time is then invisible, which is P1.57's lesson one
  step earlier in the same call. If the clip is refused, the arrow is handed straight back and the front end
  may still fall back - but only for a genuinely unclippable window.
  Two tests were removed with the rule they pinned and two replaced it (26 total).
- **P1.62d - the clip must CONTAIN the pointer, or `ClipCursor` moves it.** `DONE`. The user's next report
  was "much better, but it still moves a little", and the log had the number: at the moment the capture was
  established the probe read `pos=(1166,192)` and the trace right after read `pos=(1166,198)` - the pointer
  had been clamped 6px down into the client, because it was sitting on the TITLE BAR (the user was dragging
  the window while the world finished loading). Windows' move loop follows the pointer, so the window jumped
  6px with it. The whole 1px-lock saga (centre, then pointer, then client) had been chasing one invariant:
  **the rectangle handed to `ClipCursor` must already contain the pointer.**
  So the probe now carries the WHOLE WINDOW rect (`GetWindowRect`, screen coordinates - `CursorProbe.window`)
  next to the client rect, and `clip_target` picks the rect that contains the pointer: the CLIENT while the
  pointer is inside it (normal play, and the screen-edge margin applies), the whole WINDOW while it is on the
  frame (a title bar or a sizing border - i.e. exactly while the user drags or resizes). `fit_into` still
  clips to the visible part of the screen, and rule 2's drop now fires only for a pointer outside the
  WINDOW, not merely outside the client. One precedence rule fell out of it and is pinned by a test: the
  screen-edge margin (which keeps an invisible cursor off the taskbar's auto-hide band) yields when the
  pointer itself is in that band - containing the pointer wins, because a clip that excludes it is a clip
  that MOVES it.
- **P1.62e - a world entered with a hand on the window starts PAUSED.** `DONE`. Reported as "holding the
  title bar or a border without moving, then entering: it does not pause - it pauses only once I move". The
  reason is that a HELD press produces **no geometry event at all**, so `onWinGeometry` (the only signal the
  front end had for "the user is fiddling with the window") never fired: the entry captured the mouse with
  the user's hand still on the frame, and the first movement then paused it. The rule the user asked for is
  the one the project already applies to the foreground, so it took the same shape: **not foreground, OR a
  hand on the window, OR the window was fiddled with while loading => no capture, and the pause menu.**
  The platform half already existed: `WM_ENTERSIZEMOVE`/`WM_NCLBUTTONDOWN` set `CLIP_POSTPONED` (P1.62, for
  the clip), which is exactly "a hand is on the frame". It became `pub fn clip_is_postponed()`, and
  `reconcile` now notices its TRANSITION and pushes it to the front end as `win-session` (the window
  procedure has no AppHandle, so it cannot emit itself; the sentinel also runs while a session is active even
  with no intent). The front end keeps it in `SHELL_STATE.windowMoving`, next to `windowFocused` - a device
  fact pushed by the platform and read SYNCHRONOUSLY, which is what the lock manager needs (`PointerLock`
  refuses a capture while the window is moving: `LOCK skipped […]: the window is being moved or resized`) and
  what the entry driver needs. `LOOP_STATE.geometryDuringLoad` covers the other half of the same story: a
  geometry change while NOT in a world has nothing to pause yet, so it is REMEMBERED and the entry starts on
  the pause menu instead of handing the mouse over behind the user's back (our own mode switch is excluded -
  it returns earlier). The entry's log line names the reason: `WORLD entered while the window is being
  moved/resized -> pause menu (no capture)`.
- **P1.62f - a PUSHED platform flag is only current when the JS event loop was idle.** `DONE`. P1.62e's
  mechanism worked - the log proves it (`[cursor] window session moving=true` from the platform) - but the
  entry still captured the mouse 158ms later, i.e. the front end's copy of the flag was still `false` while
  the platform's was `true`. The push (`win-session`) is an EVENT, and the world entry's last stages
  generate and mesh the spawn window in long synchronous stretches: the push can still be sitting in the JS
  event queue when the entry takes its decision, which is taken in the same task continuum as the last
  stage. The user's own words pinned the symptom ("if I do not move it, it does not pause; the moment I
  move, it pauses" - the geometry event arrives when the loop is finally idle).
  So the entry now ASKS: a read-only `window_session_active` command (`win::clip_is_postponed()`) is awaited
  at the moment of the decision (`windowSessionActiveNow()`), and awaiting it also lets any queued push
  drain first. The lock manager KEEPS the pushed flag - it only ever decides from an idle event loop (a
  click, ESC, closing the backpack) - and the entry's log line now carries all three values
  (`[moving=… pushed=… fiddled=…]`) so a wrong decision says WHICH of them was wrong. The push itself is
  logged too (`WINSESSION pushed moving=…` in debug.log), so a late or missing delivery is visible instead of
  being inferred. **The general rule, worth keeping: a pushed device fact is trustworthy only when nothing
  long has blocked the loop since it was pushed; a decision taken at the end of a loading sequence must
  QUERY.**
- **P1.62g - handing the arrow back also lands on the crosshair.** `DONE`. Reported as "the entry fix works,
  but pressing Win no longer centres the cursor". P1.62's "hand the arrow back in the SAME call"
  (`win::restore_arrow`, called from the focus-loss branch) is what killed it: `decide`'s crosshair `warp` is
  gated on the hidden -> visible TRANSITION (`m.shape == Hidden`), and restoring the arrow sets that record to
  Arrow - so a later reconcile saw "no transition" and never warped. The 911-line boot.log says it exactly:
  **16 focus losses while capturing (Win / Alt+Tab) and not one warp among them**, while every explicit
  release (ESC, Resume, the backpack - which stay Hidden until the reconciler plans the Arrow) did warp to the
  client centre.
  Handing the arrow back and centring are ONE action, so they now happen together: the rule is a pure
  `cursor_model::hand_back_warp(m, probe)` (the crosshair, or `None`), and `restore_arrow` hides, warps and
  shows in that order. Its two guards are the ones the previous rounds established: a pointer OUTSIDE our
  window is never moved (P1.62d - the user may be holding the window by its title bar) and `centre_on_show`
  switches the whole thing off. One new table test pins all four cases (28 total).
- **P1.64 - taking the mouse may move the pointer into the window ONCE.** `DONE`. Reported as "minimise or
  maximise during the loading: it enters PAUSED (right), but then the cursor never disappears, the view
  cannot turn and only ESC does anything". P1.63's projection had kept SDL's "never tow" half but dropped
  the other one: entering relative mode is ALLOWED to recentre once. After a minimise/maximise/restore the
  pointer is usually outside the restored window (the taskbar, the desktop), so the projection refused to
  clip, marked the request DROPPED, and the front end read that as "the window was lost" - pause again, and
  Resume looped. The entry branch is now `m.shape != Hidden && the client has a visible part`: hide, move to
  the crosshair (invisible - the applier hides first), then clip. An ONGOING capture whose pointer leaves the
  window is still the drag case and still releases instead of towing, so invariant 1 is untouched. One new
  table test covers all three halves (the entry moves, an ongoing capture releases, a minimised window
  releases).
- **P1.66 - the "a hand is on the window" flag heals itself.** `DONE`. Reported as "minimise or maximise
  during the loading: it enters PAUSED, but then the cursor never disappears and the view cannot turn - only
  ESC works". Both logs showed the cause in one line: `WINSESSION pushed moving=true` and then NO
  `moving=false` for the rest of the run - `CLIP_POSTPONED` was WEDGED. It is set by `WM_NCLBUTTONDOWN`,
  which includes a click on the window's MINIMISE/MAXIMISE button, and the matching
  `WM_EXITSIZEMOVE`/`WM_NCLBUTTONUP` never reaches the window procedure (Windows hands the modal loop to the
  system around the state change). Every rule downstream then behaved "correctly": the world entry queries
  the flag and PAUSED, and every Resume was refused (`LOCK skipped [menu resume]: the window is being moved
  or resized`) - a visible cursor, a dead view, ESC the only working key. The self-heal that existed
  (`set_mouse_capture(on = true)` clearing it) could never run, because the gate that reads the flag refuses
  the request before that command is called.
  Now the truth is POLLED as well: `clip_is_postponed()` heals itself whenever the LEFT BUTTON is up
  (`GetAsyncKeyState(VK_LBUTTON)`) - a title-bar drag or a border resize always holds it, a caption-button
  click never does, and a polled fact cannot miss a message. `WM_CANCELMODE` is also a clear signal now (the
  system's "that modal loop is over", the partner of `WM_ENTERSIZEMOVE`). The front end needed no change: its
  query simply starts telling the truth again, and the transition push logs `moving=false` where the old run
  logged nothing.
- **P1.67 - a foreground loss is MEASURED and announced (Win+L, Win+;).** `DONE`. Two more boundary cases
  came in - "Win+L hides the cursor (it is hidden by default after unlocking)" and "Win+; (the emoji/symbol
  overlay) neither pauses nor hides it" - and they are ONE bug: Windows does not deliver `WM_KILLFOCUS` /
  Tauri's `Focused(false)` for every way the foreground can leave (the secure desktop of a session lock, the
  emoji overlay, UAC, the task manager), so the front end never ran its "hand the mouse back + pause" policy
  while the platform (which asks `GetForegroundWindow` every tick) already knew. P1.63 had deleted the
  platform-side notice (`capture_foreground_check` + `capture-lost`) in favour of the window event - and these
  two cases are exactly where the event is missing.
  The platform now announces the POLLED transition (a `LAST_FOCUSED` mirror: one `capture-lost` per loss, with
  a boot.log line), which the front end already handles, and ENUMERATION stops being necessary: Win+L, Win+;,
  UAC, the task manager, the task view and anything else are all "somebody else is foreground". A message can
  be missed; a poll cannot.
- **P1.69 - a cursor an overlay keeps showing ends the fight.** `DONE`. The Win+; (emoji/symbol panel) report
  was answered by the logs in one number: `foreground LOST (measured)` happened ONCE in a whole session (the
  Win+L case) - so the overlay **never takes the foreground**, and P1.67's mechanism cannot see it by
  definition. What the same log DID show is the shape of the problem: `apply … shape=Hidden forced=true`
  repeated with `showing=true hCursor=65539`, `enforced` climbing 1145 -> 1671 - a `SetCursor(0)` every 8 ms
  that never wins, because the overlay (a shell window) is the one drawing a cursor. Chromium pushes NULL
  while the CSS says `none`, so "we want hidden, we are focused, and the system keeps SHOWING a cursor" is a
  measurable statement about SOMEBODY ELSE - and it is the same fact for the emoji panel, the IME candidate
  window, the touch keyboard, the volume OSD and every other overlay. After `LOST_FIGHT_TICKS` (32 ticks
  ~= 250 ms) the projection gives up: it releases the clip, hands the request back (`drop_capture` -> the
  front end's pause policy) and logs `[cursor] cannot hide the cursor (an overlay is showing it) -> handing
  the mouse back`. That covers the whole class without enumerating it, stops the 125 pushes a second, and
  resets the counter on the drop so a front end that ignores the hint is re-told at most every 250 ms.
  One new table test pins it (and that a cursor the system already hides - the normal capturing state - is
  never a lost fight).
- **P1.68 - the foreground REGAIN is measured and announced too.** `DONE`. P1.67's mirror only announced the
  LOSS, so a Win+L unlock (which never sends the focus event either) came back to a window where nothing had
  repainted the cursor: it stayed hidden until the physical mouse moved. The same `LAST_FOCUSED` mirror now
  emits `win-focus` on the measured REGAIN, and the platform pushes the arrow itself
  (`refresh_cursor()` + `kick_cursor_repaint()`) before the front end's `reassertCursor("focus gain")` runs.
- **P1.70 - ONE hand-back: the crosshair is where the mouse comes back, on EVERY path.** `DONE`. Reported as
  "Win+; pauses but the cursor is not centred, and sometimes it jumps to the middle later for no reason" - two
  halves of one mistake, plus a third that only the logs showed.
  1. There were TWO centring paths. `decide`'s warp needs the hidden -> visible TRANSITION (`m.shape ==
     Hidden`), which the overlay path (P1.69's give-up) did not have, so a new platform helper
     (`win::restore_arrow`) was added in P1.62g to centre "on the release" - from the WINDOW EVENT, i.e. at a
     moment nobody controls. That is the "莫名其妙自己跑到中间": the move landed up to a second after the menu
     appeared, sometimes after the player had already moved the mouse. `restore_arrow()` is DELETED; the
     give-up branch calls `hand_back_warp` like every other hidden -> visible transition, in the same plan that
     shows the arrow (so the move is done while the pointer is still hidden).
  2. `hand_back_warp` used to refuse a pointer OUTSIDE our window (P1.62d, the title-bar case). The Win+; /
     IME overlay leaves the pointer over ITS OWN window, so that guard silently turned the centring off exactly
     on the path the report was about. The refusal is now ONLY `m.user_holding` (a real hand on the frame, read
     from the platform's postponed-clip flag) - "where the pointer is on the way in" is not a statement about
     what the player wants; "the mouse is mine again" is.
  3. The platform model gained the `user_holding` mirror so the rule is table-testable, and the ONE rule is
     pinned by the gate (`no fn restore_arrow`, `hand_back_warp` + `user_holding`, and every hidden -> visible
     transition using it). Three table tests updated, one added; 29/29 pass.
- **P1.71 - the CENTRE DEBT: a hand-back that cannot be centred invisibly is OWED, not performed.** `DONE`.
  The report after P1.70 was "Win+L still does not centre, and Win+; shows the cursor and THEN moves it to the
  middle". Both are one mistake: a move was issued at a moment when it could not be invisible.
  1. **Win+L.** P1.70's warp was planned on the LOSS tick, where `focused=false` (the secure desktop owns the
     input): the `SetCursorPos` went to a desktop the user was not looking at, the boot.log shows the trace
     still reading `pos=(0,0)` right after it, and after the unlock the pointer sat at `(320,195)` - the
     top-left corner of the clip rect, i.e. our own `ClipCursor` clamping the locked desktop's `(0,0)` read.
     Worse, that doomed call had CONSUMED the hidden -> visible transition (it recorded `shape=Arrow`), so no
     later tick planned a warp again and the cursor never came back to the crosshair. The old
     `win::restore_arrow` had the same defect (it was called from the focus-LOST handler), which is why Win+L
     never worked - not a P1.70 regression.
  2. **Win+;.** The give-up branch (P1.69) centred in the same plan, but the whole reason for giving up is that
     the cursor IS VISIBLE (a system overlay keeps showing it), so that move was a move the player watched:
     "the cursor appears and then jumps to the middle", 250 ms after the Win+; press.
  The cure is one new rule and one new piece of state. `invisible_moment(m,p)` = we are the FOREGROUND, the
  system reports NO cursor displayed (`GetCursorInfo`), and the front end is not asking for hidden (a move
  during a capture is invisible too, but it reaches the input pipeline as a synthetic mouse movement - the
  P1.62d teleport). The hand-back warp now requires the foreground, and anything it could not do becomes
  `CursorModel::centre_debt`, settled on the first `invisible_moment` - which is the tick right after a
  Win+L unlock (the log has `showing=false hCursor=0` there) and never happens while an overlay is on screen.
  The debt is dropped the moment the player takes the mouse back (`set_mouse_capture`) and by any applied
  warp, so it can never fire into a running session; it has no timer, because a lock can last minutes. The
  drop branch (a pointer the user dragged outside) deliberately arms NOTHING - a debt there would pull the
  pointer back in, the exact class of move P1.62…P1.62d removed. `trace_of` now ends with `debt=` so the
  state is readable in boot.log, the arming logs one rate-limited line, and the gate pins the rule
  (`invisible_moment`, `owes_centre`, the foreground term, the give-up arming, the spend, the clearing).
  Two new table tests (the Win+L sequence, and "never paid into a running capture"); 31/31 pass.
- **P1.72 - NATIVE ONLY: the Minecraft model, and the ESC hook loses half its job.** `DONE`. The user's
  ruling after the Chrome-lock investigation was "keep native only, do it the way MC does". Three findings
  made that the right call:
  1. **Chrome's pointer lock does NOT have the "no rotation at the screen edge" problem** — that is the
     API's headline guarantee, not a bug (W3C Pointer Lock 2.0: "the movement is not limited to the
     traditional boundaries (such as the user agent's window, or the overall screen)… There will be no limit
     to movementX/movementY"; MDN: "Without Pointer lock, the rotation stops the moment the pointer reaches
     the edge"). Its `unadjustedMovement` option only controls OS mouse acceleration.
  2. What pointer lock DOES impose are policies a page cannot turn off — and those are the whole reason this
     engine went native: ESC is a mandatory unlock gesture (spec: "a default unlock gesture must always be
     available… The ESC key is recommended"; Chrome also makes a re-lock need fresh user activation and
     applies an escape cooldown), focus loss unlocks by itself, and on exit the cursor is restored to where
     it was when the lock was entered (spec, "Exit Pointer Lock" step 1 + the `cursor position` definition)
     — so "the pause menu's cursor lands on the crosshair" is impossible there.
  3. **MC's mechanism is the one this engine already had**: since the 26.3 snapshot MC drives SDL3, and
     `SDL_SetWindowRelativeMouseMode` is literally `WIN_SetRawMouseEnabled` on Windows — hidden cursor,
     constrained to the window, deltas from raw HID. MC's Java side is then three calls: grab, release,
     and ONE `SDL_WarpMouseInWindow(centre)` on release; it never reads or moves the OS cursor while it
     holds the mouse, never re-derives the grab from focus/geometry (a resize only re-arms `ignoreFirstMove`),
     and has exactly one place that grabs and releases (`Gui.setScreen`).
  So: **`requestPointerLock` is gone from the engine** (a gate pin walks the seven mechanism files for
  `requestPointerLock` / `exitPointerLock` / `pointerLockElement` / `pointerlockchange`), `mousecapture.ts`
  no longer falls back — a refusal is reported and the mouse stays free, because a capture without raw input
  would hide and clip the cursor for a view that cannot turn, and `INPUT_STATE` is ONE boolean again
  (`locked` = "we hold the mouse", MC's `mouseGrabbed`): `canControl` is `locked && !isModalUi`, and
  `freeMouseActive`, `unlockIsIntentional` and the whole offscreen-window rule went with the browser path.
  **The low-level keyboard hook lost its ESC half** (it existed only to stop the browser's ESC-unlock from
  eating the first press) and kept the context-menu half (the menu key / Shift+F10 still make Windows reveal
  the cursor for a frame), so `esc_hook`/`EscEvent`/the `esc` event bridge/`escHook` are now
  `menu_hook`/`menuHook`. The mousemove look branch stays as the defence in depth it always was, now marked
  unreachable by construction.
- **P1.73 - the centring is paid on the hand-back and measured, and the cursor is nudged when Windows forgets to
  draw it.** `DONE`. The user's report after P1.71 was exact: "the cursor is visible but not on the crosshair,
  and clicking (or anything) puts it back on the crosshair". The boot.log named both halves:
  1. **The debt was paid at the wrong moment.** P1.71 armed it correctly but PAID it only at a moment it called
     "invisible": foreground AND no cursor displayed. The state a hand-back actually leaves is "the pause menu
     is up, so an arrow IS displayed (ours)" and often "the window is in the background" - so the debt waited,
     and the boot.log shows it being settled by a later accident: `222 armed → 236 paid` (the regain, i.e. the
     click that brought the window back), `336 armed → 352 paid` (same), and on the overlay path a lucky tick
     where Chromium reported `hCursor=0`. That is literally "clicking puts it back".
  2. **"We issued a warp" was treated as "we centred".** The Win+L loss-tick call is issued against the secure
     desktop and lands nowhere, so only a MEASUREMENT can end the debt.
  The cure (and it is simpler than what it replaces): the hand-back moves the pointer ONCE, right there, with
  **no foreground gate** (a plain background `SetCursorPos` lands; only the secure desktop swallows it) and no
  "is a cursor displayed" gate (the applier hides ours first); the debt is ARMED by any hand-back that does not
  leave the pointer on the crosshair; the retry needs only "no capture wanted" plus the foreground (so a doomed
  call is not fired every 4 ms for the length of a session lock); and the debt is SETTLED by the measurement - or
  by a move issued while in front, because the Win+L log proved that is the one that lands. `invisible_moment`
  and `spend_centre_debt` are gone, and so is the ping-pong risk with the player's own hand (a hand-back while
  focused owes nothing, because the move it just issued is the one that lands).
  3. **And then Windows did not draw the cursor at all.** After a Win+L unlock the system answered
     `showing=false hCursor=65539` for 1.5 s while `enforced` climbed 249 → 311 (62 pushes): the arrow handle IS
     set, the pointer IS on the crosshair, and the desktop draws nothing - until the player physically moves the
     mouse, by which time the hand has already taken the pointer off the crosshair. `SetCursor` (already set), the
     reconciler's `kick_cursor_repaint` jog (MSDN: a program moving the cursor is not "the mouse") and a
     synthetic `WM_SETCURSOR` (it only asks Chromium for the shape it already set) all left it undrawn, so the
     one thing MEASURED to fix it is what we now do: a net-zero `SendInput(MOUSEEVENTF_MOVE, +1, -1)`, i.e.
     injected input, which goes through the input stack exactly like the real mouse. It runs only in the exact
     state it was diagnosed in (`want` visible + foreground + `showing == false` + `hCursor != 0`), at most once
     every 500 ms, with one boot.log line - a NULL handle is a different disease (the arrow guard's) and a cursor
     we want hidden is never nudged into view, and while the mouse is captured the condition cannot hold at all.
  Two table tests rewritten around the new rule (including the Win+L sequence end to end: armed at the loss,
  not paid while locked, paid at the unlock); 32/32 pass.
- **P1.74 - the overlay give-up stops centring at all.** `DONE`, by request. P1.73 paid the centre debt one tick
  after the Win+; give-up (when the front end's "hand the mouse back" arrived), and the report's verdict was that
  a visible move is worse than no move: "remove the Win+; centring". So the give-up branch arms NOTHING now -
  the cursor stays exactly where the overlay left it until the player moves it themselves, and there is no debt
  left for the not-hidden branch to pay (and no `was_hidden` warp either, since the give-up already applied the
  Arrow shape). The other hand-backs are untouched: ESC / Resume / the backpack release the mouse while we are
  in front, and that move really is invisible (the applier hides the cursor first), so they keep centring on the
  crosshair; a lost foreground still goes through the debt, because its loss-tick move may land nowhere (Win+L).
  One test flipped from "owes the centring" to "owes nothing"; the gate pins the branch.
- **P1.75 - Win+L stops centring, and Win+; stops pausing.** `DONE`, by request ("把win加L的居中也去掉，win加；触发暂停也去掉"). Two switches, both the opposite of a rule this project had argued its way into:
  1. **The centre debt is deleted.** P1.70 warped on every hand-back (the Win+L move was issued against the
     locked desktop, landed nowhere, and consumed the transition); P1.71 turned that into a debt paid at an
     "invisible moment" (foreground AND no cursor displayed - a state the pause menu is never in, so it was paid
     by a later accident: "the cursor is not centred and clicking puts it back"); P1.73 paid it on the hand-back
     and settled it by measurement. Each was a real fix for a real log, and the report's verdict is still that
     the delayed move is worse than no move. So `p.focused` is back as the gate on the move itself, nothing is
     owed, nothing is retried, and `centre_debt` / `arm_centre_debt` / `settle_centre_debt` / `owes_centre` /
     `is_at_centre` / the `debt=` trace field are gone from both halves. What still centres is the DELIBERATE
     release - ESC, Resume, the backpack, the world leaving - which always happens while we are in front and
     whose move the applier makes invisible (`apply_cursor(false)` -> warp -> show).
  2. **The overlay give-up no longer hands the mouse back.** P1.69's give-up (release + `capture-lost` -> the
     front end pauses) existed because `SetCursor(0)` cannot win against a shell overlay: `enforced` climbed
     1145 -> 1671 (125 pushes a second) while the cursor stayed visible. Its verdict was "once the system has
     taken the screen, the player expects the game to pause"; the report's is the opposite - pressing Win+;
     must not pause. So the capture is KEPT (the view keeps turning: the deltas are WM_INPUT and the overlay
     never takes the foreground) and the shape pushes simply STOP (`force_shape = false`, and the clip is
     unchanged, so the branch makes no Win32 call at all). The old line
     `cannot hide the cursor (an overlay is showing it) -> handing the mouse back` is replaced by a rate-limited
     `an overlay is showing the cursor: keeping the capture and pausing nothing (P1.75)`, and `drop_capture` is
     back to meaning exactly one thing: the pointer left the window (the drag/resize tow of P1.62).
  Three table tests rewritten (the overlay keeps the capture and stops pushing; a hand-back centres only in
  front; the ordinary capturing state is untouched); 30/30 pass.
- **P1.76 - the CENTRE LOCK and RAW BUTTONS: the two things Minecraft does that we did not.** `DONE`, by
  request ("抄过来"), after the user's report that "in MC the cursor never moves no matter what, and the left/right
  buttons still work with the panel in front". Both came out of reading SDL's Windows backend and the MC sources
  directly (`E:\SDL-main`, the client/common trees), and both are small once the mechanism is known.
  1. **The centre lock.** SDL's relative mode does not merely hide and confine the cursor: `WIN_UpdateClipCursor`
  replaces the clip with `data->cursor_ctrlock_rect` - a **1x1 px box (3x1 on RDP) AT THE CLIENT CENTRE** -
  whenever `mouse->relative_mode && mouse->relative_mode_center`, and that hint is **on by default**
  (`include/SDL3/SDL_hints.h:3032-3051`, `src/video/windows/SDL_windowswindow.c:397-403` and `:1598-1632`).
  Windows itself then refuses to move the pointer out of that box, which is the whole reason MC's cursor is
  immovable, and why the cursor Win+; reveals (the shell's, i.e. the SYSTEM cursor) sits still exactly on the
  crosshair. MC calls no mouse rect, never re-centres, and never reads the cursor back - the pin is entirely the
  clip. We had this and deleted it in P1.62c (the 1px lock of that era towed the pointer whenever the window
  moved); it is back as `cursor_model::centre_lock`, and the concern that killed it is now covered the way SDL
  covers it (`postpone_clipcursor` during a title click/size session = our `CLIP_POSTPONED` + `win-session` +
  `user_holding`). Two rules lost their last case and are gone with it: P1.62's "drop the capture when the pointer
  leaves the window" (it cannot leave) and P1.64's one-time "entry move" (the clamp does it every tick). The
  whole-window probe field and its `GetWindowRect` per 4 ms tick went too. **The P1.63 invariant is deliberately
  inverted** - the rect given to `ClipCursor` no longer contains the pointer; moving it IS the mechanism.
  2. **Raw buttons.** SDL reads the button edges out of the same `RAWMOUSE` packet the deltas come from
  (`rawmouse->usButtonFlags` → `SDL_SendMouseButton(..., SDL_GetKeyboardFocus(), ...)`,
  `src/video/windows/SDL_windowsevents.c:556-573`, `:588`, `:690-732`) and ignores the legacy `WM_*BUTTON*`
  messages while raw mouse is on - so a click still reaches the game when a shell overlay owns it. `rawinput.rs`
  was already receiving those packets (`RIDEV_INPUTSINK`) and already documenting the `usButtonFlags` offset in a
  comment while reading past it; it now parses all five buttons into two bitmasks, pushes them as `raw-buttons`
  (its own event, so a click with no motion still arrives) and reports `btn=` on the RAWMON line. The front end
  decodes them in `input.ts::rawButtons` through the SAME `buttonToAction`/`buttonToCode` table the DOM path uses,
  with an explicit owner switch: **raw while captured, DOM while the cursor is free** (both sides gated, so one
  click can never be counted twice), and `releaseCapture()` now clears the held MOUSE binds (MC's
  `KeyMapping.releaseAll()` on a screen change) so a press whose release lands in another window cannot stick a
  block break across a pause. The wheel lives in the same union and is deliberately unread: nothing consumes a
  wheel event yet.
  Three table tests replaced (centre lock, "the clip does not depend on the pointer", "an outside pointer is
  locked in, never dropped"); 29/29 pass.
- **P1.77 - the centre lock is ONE pixel, and the repaint nudge no longer twitches.** `DONE`. Report after P1.76:
  "the centre lock is great - the cursor now comes out of the middle - but it can still be seen moving slightly,
  MC's is completely still". Two causes, both ours:
  1. **The box was 3x1, not 1x1.** P1.76 took SDL's *remote-desktop* width "as a compromise"; SDL's local box is a
     single pixel and only widens to 5x1 when `GetSystemMetrics(SM_REMOTESESSION)` is set
     (`remote_desktop_adjustment`, `SDL_windowswindow.c:397`). With three valid columns Windows clamps the
     pointer to the NEAREST one, so it parked 1px off the crosshair and could slide between cx-1/cx/cx+1. The
     probe now carries `remote` (read once and cached in `win::remote_session` - the value cannot change while
     the process lives) and `centre_lock` pads by 2 only for it. Locally the pointer now has exactly one
     position, which also makes `hand_back_warp` a permanent no-op: the pointer IS on the crosshair, always.
  2. **The P1.73 repaint nudge is a REAL 1px move, and it ran after the arrow was shown.** `nudge_cursor_overlay`
     injects `MOUSEEVENTF_MOVE +1` then `-1` (a zero-delta injection is ignored by Windows, so the move has to
     be real), and `reconcile` called it after `apply_shape` - i.e. the freshly drawn arrow twitched by a pixel
     on every hand-back. It now runs BEFORE the shape push, while nothing is displayed yet: the same rule the
     warp follows ("every move in this system happens while the cursor is hidden"), and the Win+L repaint cure
     is unchanged. The gate pins the ORDER, not just the call.
  One table test extended (1x1 locally, 5x1 with `remote`); 29/29 pass.
- **P1.78 - the injected-input cursor repair is gone: Windows' own behaviour after a lock is left alone.** `DONE`,
  by request. P1.73 added a net-zero `SendInput(MOUSEEVENTF_MOVE, +1/-1)` because a Win+L unlock leaves the system
  reporting `showing=false hCursor=65539` for a second or more - the arrow IS set and NOT drawn - and injected
  input is the one event MEASURED to make Windows draw it. The user's verdict after P1.77: the cursor now appears
  immediately after an unlock where Windows would have kept it hidden until the mouse moved, and that default is
  the behaviour they want back. So `nudge_cursor_overlay`, `maybe_nudge_stuck_cursor`, the `SendInput` declaration,
  the `INPUT`/`MOUSEINPUT` layouts, the `INPUT_MOUSE`/`MOUSEEVENTF_MOVE` constants and the reconciler call are
  deleted, and nothing replaces them. The repaint helpers that PREDATE the nudge stay (`refresh_cursor`'s synthetic
  `WM_SETCURSOR` and `kick_cursor_repaint`'s symmetric `SetCursorPos` jog): the P1.73 boot.log proves they do not
  change visibility - the cursor stayed undrawn for 1.5 s and ~62 pushes with both of them running, and only went
  away when the hand moved. The gate now pins their ABSENCE (`SendInput`, `nudge_cursor_overlay`,
  `maybe_nudge_stuck_cursor`, the log line), so "the cursor after an unlock waits for the mouse" is a decision
  recorded in code rather than an accident.
- **P1.79 - the Windows cursor mechanism moves behind a PLATFORM SEAM (the port's first structural step).** `DONE`,
  by request ("我只是想把目前属于win的情况搬出来后期任意移植和兼容那两个系统"). `win.rs` (1214 lines) was ONE file mixing
  three concerns; it is three now, and only one of them knows Windows exists: `cursor_model.rs` (unchanged, 1005
  lines: the pure rules + the 29 table tests), `cursor_session.rs` (the cross-platform state machine - the one
  `MODEL` table, the capture lifecycle, `reconcile`, the diagnostics, the Tauri-facing entry points, and **no
  platform call at all**), and `platform/windows.rs` (the backend: the `extern "system"` declarations, `probe_of`,
  `trace_of`, `apply_clip`/`apply_shape`/`apply_cursor`, `warp_to`, the window-procedure subclass, the WebView2
  accelerator-key switch). `platform/mod.rs` is the seam: it documents the exact function list a backend must
  provide AND `compile_error!`s on a target that has none, so a macOS/Linux build fails LOUDLY at that one file
  instead of inside 800 lines of Win32. `windows`/`webview2-com` moved to
  `[target.'cfg(windows)'.dependencies]` (one file used them), `main.rs`'s `windows_subsystem` attribute became
  `target_os`-conditional, and `lib.rs`'s 19 call sites plus `rawinput.rs`'s 6 now name `cursor_session::` /
  `platform::`. **Behaviour is unchanged BY CONSTRUCTION**: the split is a pure line-range move - not one line was
  retyped - and the only edits are four semantically identical ones (`GetForegroundWindow() == hwnd` ->
  `platform::is_foreground(hwnd)` in three places, `CLIP_POSTPONED.store(false)` ->
  `platform::clear_clip_postponed()`). The regression net is the one the mouse has always had: the 29 pure model
  tests, the 69-group gate (it reads the Rust sources BY PATH - now both halves, concatenated session-first so its
  two `split()` slices still see the capture lifecycle in its original order), tsc, and the manual list.
  **`rawinput.rs` is deliberately NOT cut in this round**: it is the same seam, but it shares no code with the
  cursor path, so folding it into this diff would only make a regression harder to localise. It is step 2; turning
  the free functions into `trait`s (so the compiler names what a port is missing) is step 3.
- **P1.80 - the whole Windows-native side moves behind the seam: raw input joins the cursor, and the seam
  becomes TRAITS.** `DONE`, by request ("把这两步弄好让我再次测试"). P1.79 cut the POINTER out of `win.rs`; this
  round cuts the DEVICE and finishes the contract.
  1. **`rawinput.rs` (726 lines) is now two files.** `rawinput_session.rs` (cross-platform: the accumulators the
     platform pushes into, the 4 ms push thread that drains them into `raw-input`/`raw-buttons`, the RAWMON line,
     `RawStats`, start/stop) and `platform/windows/rawinput.rs` (the device: the hidden `HWND_MESSAGE` window,
     `RIDEV_INPUTSINK`, the `WM_INPUT` parser, the `WH_KEYBOARD_LL` context-menu hook). The data direction is the
     design: **the collector never emits and the push thread never touches the device.**
  2. **The seam is three traits** (`CursorBackend`, `RawInputBackend`, `WebviewBackend`) instead of a documented
     function list, so a port gets a COMPILE error naming the method it forgot rather than a prose list that can
     drift. `platform/mod.rs` keeps one-line delegations (`platform::probe_of(..)`), which is why
     `cursor_session.rs` did not change by a single line in this round.
  3. **The backend is a directory**: `platform/windows/{mod,rawinput,webview}.rs` - pointer / device / webview host.
     The WebView2 half left `game.rs` and `lib.rs` too: `game.rs::apply_browser_args` now asks
     `platform::browser_args_base()` and publishes through `platform::publish_browser_args()`.
     **The Windows-only WINDOW FLAGS stayed in `tauri.conf.json`, and that is now a rule, not a choice.**
     This round first moved `additionalBrowserArgs` into Tauri's platform overlay `tauri.windows.conf.json`
     and had to REVERT it: `tauri-utils/src/config/parse.rs:185` merges the overlay with
     `json_patch::merge` (RFC 7386), where objects merge recursively but **ARRAYS ARE REPLACED WHOLESALE** -
     so a partial `app.windows: [{ label, additionalBrowserArgs }]` entry silently threw away `center`,
     `width`/`height`, `visible: false`, `title` and every other window field with it, and the window
     stopped being centred (**reported the same round: "每次启动窗口位置不同"**). The "verification" that
     missed it only grepped the built exe for the flag - presence, not absence-of-damage, which is exactly
     the wrong check for a merge. Overlaying a window requires repeating the WHOLE window object (a drift
     trap), and `additionalBrowserArgs` is documented Windows-only anyway, so the shared file is its home.
     Non-array overlay keys (a future `bundle.targets`) are safe.
  4. **No platform handle leaks upwards any more**: `lib.rs`'s three `window.hwnd()` sites became
     `platform::native_window(&window)` returning an opaque `NativeWindow`; `isize` survives only inside the
     model (`CursorModel.hwnd`, deliberately frozen).
  5. **The seam is now verifiable by grep**, and it is clean: `cursor_session.rs`, `rawinput_session.rs`,
     `lib.rs`, `game.rs` and `main.rs` contain **zero** non-comment platform traces; `#[cfg]` appears only in
     `platform/mod.rs`. `SetCursorPos` was also pulled back where it belongs (it used to be declared in
     `rawinput.rs` and borrowed by the cursor backend - a reverse dependency across the seam).
  Behaviour is unchanged: the moves are line-range copies, and the only edits are the seam plumbing. Gates: tsc 0,
  check:ecs 69 groups OK (its Rust-source assertions read the four files in order, and the two diagnostic-probe
  table rows were repointed), 29 pure model tests pass.
  **Still open**: turning the Windows `extern "system"` declarations into typed bindings (`windows` crate,
  `core-graphics`, `x11rb`) is a per-backend preference, not part of the seam. And the two browser-argument
  lists disagree in one place (the config carries `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`
  and `game.rs`'s append does not repeat it, so switching vsync off silently drops those three flags) - noted,
  not changed.
- **P1.81 - the WebView2 launch arguments get ONE owner, and the shared config stops carrying them.**
  `DONE`, by request ("该放到windows的就放到windows，不可以的就不理"). `additionalBrowserArgs` is deleted from
  `tauri.conf.json`; `platform/windows/webview.rs`'s `BROWSER_ARGS_BASE` is now the complete list and
  `game::apply_browser_args` publishes it **unconditionally** (it used to return early when vsync stayed on,
  which was only correct while the config held a second copy).
  **It also fixes a real bug the old duplication had already caused**: WebView2's variable REPLACES whatever
  the host was configured with - wry's default `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`
  included (`tauri-utils/src/config.rs:2080` says so in as many words) - and `game.rs`'s list omitted that flag,
  so **turning vsync off silently re-enabled those three components**. The flag is now in the host's list, so
  there is one source of truth and the two can no longer disagree.
  **What was deliberately NOT moved** (and why): `bundle.targets: ["nsis"]` stays in the shared config. The
  overlay mechanism works (P1.80 proved it the hard way), but `tauri build`'s bundler step cannot run in this
  checkout - it downloads `nsis-3.11.zip` and times out offline - so moving `bundle.targets` into
  `tauri.windows.conf.json` would be an **unverifiable config change to a documented workflow**
  (`npm run app:build`), and if it silently did not apply, Windows would try to bundle `msi` too and need WiX.
  Unverifiable is the one thing a config change may not be here. Also left alone because they are impossible
  or pointless to move: `main.rs`'s `windows_subsystem` (a crate-level attribute; Rust forbids it anywhere but
  the crate root, and it is already `cfg`-conditional), `Cargo.toml`'s
  `[target.'cfg(windows)'.dependencies]` (the only place Cargo accepts it), `package-portable.mjs` (a Node
  script - it needs a sibling per platform at port time) and `tools/*.bat` (they ARE Windows files).
  Verified: the packaged exe still contains `--disable-features=msWebOOUI`, and three launches still put the
  window at the same rect as P1.80's fix (title VoxelEngine, 1296x759 outer, (312,164)).
- **P1.82 - the native window handle becomes an OPAQUE TYPE: the last Windows-shaped thing leaves the
  shared layer.** `DONE`, by request ("那就只弄那个句柄"). This is the item the P1.79/P1.80 reports kept
  deferring ("only worth doing before a port"), and the reason it was deferred is the reason it is worth
  recording carefully: it had to touch `cursor_model.rs`, which the two earlier rounds deliberately froze
  as the regression anchor.
  1. **`NativeWindow` moved into `cursor_model.rs`** (the shared vocabulary module, where `ClipRect`,
     `ClipPos`, `CursorShape`, `CursorProbe` and `CursorPlan` already live) and `platform/mod.rs`
     re-exports it, so a backend only ever names one path. **The field is PRIVATE**: `NONE`, `from_raw`,
     `raw`, `is_none` and `is_some` are the whole API, and `from_raw`/`raw` are documented
     "backends only". `isize` remains the representation because that is what a pointer fits in on every
     target we build for and what a `static AtomicIsize` can hold - a raw `*mut c_void` would have needed
     an `unsafe impl Send/Sync` to live in the model's `Mutex`, i.e. `unsafe` in the shared layer, which
     is exactly what this round is removing.
  2. **The model field is `window`, not `hwnd`** - the word was the last Windows vocabulary in a
     platform-free file. `CursorModel.window: NativeWindow`, and "0 = no window" became
     `NativeWindow::NONE` / `is_none()`.
  3. The seam's signatures followed: `is_foreground(NativeWindow)`, `install_menu_suppressor(NativeWindow)`,
     `RawInputBackend::start_collector() -> Result<(NativeWindow, bool), String>`. The two session layers,
     `lib.rs` and `game.rs` no longer unwrap anything (`lib.rs` used to do
     `platform::native_window(&window).map_or(0, |h| h.0)`); `hwnd` now appears ONLY in
     `platform/windows/`, where it is the genuine Win32 parameter (extern declarations, the window
     procedure, `WebviewWindow::hwnd()`).
  4. **`cursor_model.rs` was edited for the first time since the freeze, and the 29 table tests came
     through**: the fixture's `hwnd: 42` is `window: NativeWindow::from_raw(42)`, and the count is still
     29/29. Acceptance is by grep: outside `platform/windows/` there are **zero** non-comment uses of
     `hwnd` or `isize`; inside, 14/20 and 23/35 respectively.
  Gates: tsc 0, check:ecs 69 groups OK, 29 model tests pass, release build with only the two pre-existing
  warnings.
- **P1.83 - THE FIRST PORT: Android boots, and it cost one file.** `DONE`, by request ("什么都不管直接先弄出
  一个apk先"). This is the round that tests whether the P1.79-P1.82 seam was worth it, and the answer is
  measured rather than claimed: `src-tauri/src/platform/android/mod.rs` is **the only new file**, and
  `cursor_model.rs`, `cursor_session.rs`, `rawinput_session.rs`, `game.rs`, `lib.rs` and the whole front
  end needed **no Android-specific change at all**.
  1. **The backend is almost empty, and that is the point.** A phone has no system cursor to capture
     (`native_window() -> None`, which the seam already reads as "capture impossible, pointer stays
     free") and no raw-input device (`start_collector` returns the honest error; the front end already
     treats "no raw input" as "use the DOM events", which is exactly right for touch). The remaining
     methods are no-ops. What a touch build actually needs is a front-end interaction model - stick,
     look-drag, on-screen buttons - i.e. presentation, not platform.
  2. Four small platform facts had to be handled: the Android library has to exist as `lib<name>.so`;
     `run()` gained `#[cfg_attr(mobile, tauri::mobile_entry_point)]` (the mobile entry point is the
     library, not `main.rs`); `set_fullscreen`/`is_fullscreen` split into
     `#[cfg(desktop)]`/`#[cfg(mobile)]` arms, because that Tauri API does not exist in a mobile build;
     and the toolchain (SDK 36 + NDK r27c + JDK 17) went to `E:\android\`.
     **`crate-type` note, CORRECTED in P1.85**: this round changed the manifest to
     `["staticlib", "cdylib", "rlib"]` and claimed the old "export ordinal too large" failure no longer
     reproduces - the claim was made from a RELEASE build only, and it is WRONG for debug (see P1.85).
  3. **`scripts/build-android.mjs` + `npm run app:android` = one command to an APK in `release\`**,
     the mirror of `package-portable.mjs`. Gradle writes the APK into its own fixed
     `gen/android/app/build/outputs/apk/<flavor>/<type>/` and Tauri never copies it anywhere, which is
     why the desktop had a `release\` folder and Android had nothing. The script is idempotent
     (`--skip-build`, `--skip-patch`, `--release`, `--target all`) and it also absorbs the three
     environment traps that each cost real time here:
     (a) `services.gradle.org` serves the Gradle distribution at ~20 KB/s and the plugin portal/Maven
     Central stall, so the wrapper and every repository list get Tencent/Aliyun mirrors first;
     (b) **`tauri android init` does not generate the whole project** - `tauri.settings.gradle`,
     `app/tauri.build.gradle.kts`, `app/tauri.properties` and ten Kotlin files under
     `app/src/main/java/.../generated/` are written by a BUILD, so the script asks the CLI for them
     (the outer `tauri android build`; the inner `android-studio-script` panics standalone on a missing
     `...-server-addr` file) and tolerates the CLI's own symlink failure;
     (c) `tauri android build` places the `.so` with a **symbolic link**, which Windows refuses
     without Developer Mode, so the script COPIES the file and edits `buildSrc/.../RustPlugin.kt` to
     drop the Gradle dependency on the CLI task.
  4. **Verified from a pristine template**, not on a hand-patched tree: `gen/android` was moved away,
     regenerated with `tauri android init`, and ONE command produced
     `release\VoxelEngineTauri-android\VoxelEngine-arm64-v8a-debug.apk` (133.7 MB, `com.voxelengine.tauri`,
     minSdk 24, arm64-v8a). A second run takes 13 s and patches nothing.
  5. The user's verdict on the device: **"完美…操作逻辑和安卓的web部分默认行为没有禁用"** - it boots to the
     menu and Android's WebView defaults (long-press, overscroll, pinch zoom) are still active, which is
     what they want.
  **Still open**: touch controls (the real work), a writable game root so logs and settings survive, and
  a smaller release APK (the debug `.so` alone is 126.8 MB).
- **P1.84 - two one-command build chains, and the frontend step they both need.** `DONE`, by request
  ("弄好一条龙服务"). The desktop needed three commands in a specific order (frontend -> cargo ->
  package) and two of them fail quietly-ish when run out of order or against a stale `dist\`; Android
  already had one command since P1.83 but was missing that first step.
  1. **`scripts/run.mjs`** is the shared process helper (`runShell` through the shell for
     `cargo`/`gradlew.bat`, `runCapture` WITHOUT a shell for `process.execPath`), and it owns
     `buildFrontend()` - the gate both chains now run first. Why it is a step and not a README note:
     `tauri-codegen` embeds `dist\` with `include_bytes!` (`embedded_assets.rs:401`), so cargo DOES
     rebuild when those files change - but only once they have changed. Skipping the gate compiles the
     previous frontend into the exe or the `.so`, silently. `tauri build` gets it free from
     `beforeBuildCommand`; a bare `cargo build` never did, and the Android chain only got it as a side
     effect of generating the Gradle glue (which also ran it once per ABI).
  2. **`scripts/build-windows.mjs` + `npm run app:windows`**: frontend gate -> `cargo build`
     (`--release`, or `--debug`) -> `package-portable.mjs`. `--debug` is new capability, not just a
     flag: it produces a **debug exe with the frontend embedded**, which - unlike a bare `cargo build` -
     runs by double-click (the bare one looks for `devUrl` and shows a blank window). It is built but
     not packaged, because `package-portable.mjs` reads the release profile.
  3. **`build-android.mjs` gained the same frontend step** (plus `--skip-frontend`), and its
     glue-generation call now passes `-c '{"build":{"beforeBuildCommand":""}}'` so the CLI does not run
     `npm run build` again per ABI.
  4. Verified end to end: `npm run app:windows` -> gate OK, cargo 2m04s, `release\VoxelEngineTauri\`
     25 files / 13.8 MB; `npm run app:android` -> gate OK, Gradle 13s,
     `release\VoxelEngineTauri-android\VoxelEngine-arm64-v8a-debug.apk` 133.7 MB; `--skip-build` and
     `--skip-patch` re-publish without recompiling.
  **Not done on purpose**: there is no single command that builds BOTH platforms - a desktop release and
  an APK have nothing in common after the frontend gate, and running one while debugging the other is
  the common case.
- **P1.85 - the crate-type change from P1.83 broke `tauri dev`, and the fix is a command-line flag.**
  `DONE` (found while verifying P1.84's `--debug`). P1.83 put `["staticlib", "cdylib", "rlib"]` in the
  manifest, which is what the Tauri template does. A manifest `crate-type` belongs to the PACKAGE, not
  to a target, so every desktop build then also linked `libvoxelengine_tauri_lib.dll` - and on Windows
  + the GNU toolchain the DEBUG one cannot be linked:
  `ld.exe: error: export ordinal too large: 90913`. The release profile survives (LTO +
  `opt-level = "s"` + `strip` cut the export count under binutils' ordinal limit), which is exactly
  why the release build had "verified" it and why the failure hid for a whole round: **`cargo build`
  and `npm run app:dev` were broken, and nothing in the shipped chains noticed.**
  The fix is the one the old comment had hinted at, minus the guesswork: `crate-type = ["rlib"]` is
  back, and `scripts/build-android.mjs` emits the Android `.so` with
  `cargo rustc --lib --crate-type cdylib` - a per-invocation override that leaves the manifest, and
  therefore every desktop build, untouched. (`cargo build --bin voxelengine-tauri` does NOT help: cargo
  still links the lib target's declared crate types.)
  Verified: desktop debug builds again (17s), `tauri dev`'s profile is usable again, the Android
  `.so` is still produced (127 MB) and the full Android chain still ends with a 133.7 MB APK. The
  `--debug` chain was then checked for real: the exe starts standalone and `game\logs\boot.log`
  contains the FRONT END's own probe lines, i.e. the embedded frontend really is running.
- **P1.86 — the vertical-sync switch stops needing a restart: the frame rate becomes OURS (pacing), and the
  display rate comes from the platform.** `DONE`, by request («我不想要重启我想要运行生效»). The switch had been a
  WebView2 launch argument (`config/vsync.json` → `--disable-gpu-vsync`) since the port, which is the one
  shape a runtime switch cannot have: Chromium reads its flags before the webview exists, so the button wrote a
  file, showed "(restart to apply)" — and, because the flag was the only lever, "off" could not even be faster
  (rAF stays pinned to the panel without `--disable-frame-rate-limit`). So the switch was **inert and
  restart-bound at the same time**.
  * **THE FLAGS BECOME FIXED** (`game.rs::EXTRA_BROWSER_ARGS` = `--disable-gpu-vsync
    --disable-frame-rate-limit`): the display-rate limit is lifted unconditionally, which is what hands the
    frame-rate question to the page. Nothing the user can switch may be a launch argument any more.
  * **THE PACING BECOMES THE FEATURE**: `pacingTargetHz(cap, vsync, refreshHz)` + `paceFrame(acc, delta,
    target)` are PURE functions in `data/globals/resources.ts`, and the loop calls them once per vblank.
    Unsynced = the cap (0 = uncapped); synced = the cap but never above the panel. Both settings are read from
    `FPS_CAP` every frame, so the switch applies on the next frame and persists in `settings.json` (it is in
    the settings check's schema now, which the old `vsync.json` never was).
  * **A VBLANK IS NOT A FRAME**: the fixed step runs on EVERY vblank (before the gate), while the look, the
    lane bodies and `frameProbe` run only on drawn ones — so the `FRAME` line and the FPS number still mean
    "drawn frames". The menu/load modes pace at the display rate whatever the settings say (they were never
    part of the frame-rate setting, and an unpaced ui lane at an unthrottled rAF rate is pure waste).
  * **THE REFRESH RATE COMES FROM THE PLATFORM** (`platform::display_refresh_milli_hz` →
    `DwmGetCompositionTimingInfo().rateRefresh`, MILLI-Hz): a rAF-derived measurement cannot see the panel any
    more, and rounding 59.94 to 60 drifts — one duplicated frame every ~16 seconds. 0 = unknown → a plain 60,
    never "uncapped". `display_refresh` is also a command, re-asked when the window mode changes (a fullscreen
    switch is how a program lands on a second monitor).
  * the `rAF(60Hz)` boot line was a **hard-coded string**, and it is now the real answer plus the pacing target;
    the `FRAME` line gained `raf=N/s` next to `n=` — the one number that says whether the browser really let go
    (60 next to 60 = it did not).
  WHAT THIS STILL CANNOT DO: switch the GPU's present mode (FIFO/immediate) at runtime. That is a swapchain
  concept and no browser exposes one — the honest limit that made "pacing" the right answer rather than a
  relaunch. See AGENTS.md's pacing note.
  **MEASURED WART, and the next step if the user wants it**: with the display-rate limit lifted, Chromium
  delivers ~1.8 callbacks per panel refresh (`raf=108/s` while drawing 57/s), so a target EQUAL to the panel's
  60Hz lands at **~57fps** (16.2-18.6ms frames, one repeated panel frame every ~20th refresh) instead of the
  16.67ms the engine held before. Rates well below the callback rate are EXACT (a 30 cap measured
  33.05-33.63ms), and the sync-off mode really is uncapped (measured 490fps, i.e. the switch does something
  dramatic). An early budget (a 4% "lead") was tried and **measured to change nothing**, so it was removed
  rather than shipped as a fudge. The correct cure is a real VBLANK CLOCK: `platform/windows/display.rs`
  already reads DWM's timing (`qpcVBlank` + `rateRefresh`), so the loop could draw once per panel vblank
  (exact 60, aligned, and lower input latency) instead of counting callbacks. Not done this round.
  VERIFIED: `tsc` 0; `check:ecs` 75/75 with the pacing arithmetic asserted directly (a 400Hz rAF draws 9 frames
  in 60 vblanks, not 60; a cap above the refresh means the refresh; an unknown rate falls back to 60) plus the
  command's deferral, the schema key, the fixed launch arguments and the absence of the vsync file; the real
  app's log shows the boot line, the webview arguments and `raf=`/`target=` per second, and toggling the switch
  in-game changes the frame rate within one frame with no relaunch (see TESTING.md).
- **P1.88 — the vertical-sync switch OFF no longer degrades over time, and the GPU timestamp stops being
  sampled per frame.** `DONE` (both found by playing with the switch off, as reported). Two "it gets worse the
  longer you play" bugs, both caused by the P1.86 change that lifted Chromium's display-rate limit:
  * **A LOOK INTENT IS NOW COALESCED.** `player.input.frameLook()` runs once per DRAWN frame and queues one
    `look` intent, while the fixed lane drains that queue 120 times a second. At 60fps the queue is always
    empty; with sync OFF the lane draws 500-650 frames a second, so the queue grew by ~4-5 intents per tick —
    **unbounded**, and every tick drained a longer backlog of tiny rotations, so the game slowed down the
    longer sync stayed off (and the array grew for ever). Ten small turns ARE one bigger turn, so the trailing
    look intent is accumulated into instead: at most one look is ever queued, whatever the frame rate. The
    key/motion intents are edge-driven and therefore bounded by the input device, not by the frame rate.
  * **THE GPU TIMESTAMP IS SAMPLED, NOT PER FRAME.** `diagnostics` resolved a GPU timestamp query on every
    render frame — one GPU sync point per frame, for a number printed once a second. It is now throttled to
    4 Hz AND only while the F3 panel is visible.
  VERIFIED: `tsc` 0; `check:ecs` 75/75 with both facts asserted (the coalescing, the sampling interval and the
  panel gate); and a real run with sync OFF for a minute holds a flat frame time instead of drifting.
- **P1.89 — the browser's OWN vsync is turned off too (an experiment, by request).** `DONE`, by request
  («把浏览器自带的垂直同步关了试试»). P1.86 pinned the launch arguments to `--disable-frame-rate-limit` only,
  on the measured grounds that un-syncing the compositor's present made the *synced* case worse (21ms worst
  frames). This round adds `--disable-gpu-vsync` back, so the WebView presents immediately instead of at the
  next refresh: the unsynced in-game mode now behaves like a real `vsync off` (higher rate, lower
  input-to-photon latency, and it can TEAR), at the cost that the SYNCED mode submits between refreshes and
  the panel repeats frames. Both are the same launch flag, so the in-game switch is still what picks between
  them — see `game.rs::EXTRA_BROWSER_ARGS` for the measurement that goes with each combination.
  What this does NOT change: the panel is still a 60Hz metronome, so a frame rate that is not a divisor of it
  (96/100/228…) still cannot be phase-locked, and the achieved rate in the 60..200 band still does not follow
  the cap (measured: `target=96fps` → ~60fps drawn with 21-36ms worst frames). The cure for THAT is still a
  DWM vblank clock (P1.86's open item).
- **P1.90 — the launch-argument experiments are taken back out: the browser's own defaults ship.** `DONE`, by
  request («把那个解锁flag的弄掉…就用浏览器那个默认的垂直同步好了»). P1.86 and P1.89 had added
  `--disable-frame-rate-limit` and `--disable-gpu-vsync`; both are gone from `game.rs`, so the WebView runs on
  Chromium's own pacing: its frame-rate limit pins rAF to the display refresh and its present waits for
  vertical blank — which IS `vsync on`, and it is the smoothest this stack can do (a clean ~16.7ms,
  `stalls=0`).
  WHAT THE EXPERIMENTS LEARNED, kept because it is why they are not worth keeping:
  * unpinning rAF (`--disable-frame-rate-limit`) made the callback supply ELASTIC (`raf` settles at ~2× the
    drawn rate), so the in-game cap stopped being honoured between ~60 and ~200 (`target=96fps` → ~60fps drawn
    with 21-36ms worst frames — judder that reads as 30fps), the whole ui lane ran once per DRAWN frame
    (500-650 DOM reconciles a second instead of 60), and the extra frames bought nothing: the panel is still a
    60Hz metronome;
  * un-syncing the compositor (`--disable-gpu-vsync`) is what a game means by "vsync off" (immediate present,
    tearing), but it charged the DEFAULT mode for the option (21-30ms worst frames instead of 16.7ms).
  SO THE SWITCH IS HONEST NOW, on top of the browser's defaults: a cap BELOW the refresh is exact (it skips
  whole refreshes — 30fps = every 2nd, measured 33.05-33.63ms), a cap AT or above it does nothing (rAF cannot
  exceed the refresh), and both positions of the vertical-sync switch pace at the refresh. What is given up
  deliberately: tearing and sub-refresh latency are not reachable from a WebView (see P1.86's closing note and
  the P1.87 native layer, which is where they WOULD be reachable).
- **P1.91 — two measured render bugs: the F3 `GPU:` number froze, and breaking a block could leave its face
  unrendered.** `DONE`, by request («f3的gpu帧率显示数字不会动以及修复问题破坏方块时有些方块的面不会渲染出来»).
  Both were real, and both were REGRESSIONS of the P1.88 pacing work rather than new code:
  * **the F3 GPU number never moved** — `diagnostics.ts` gated the throttled `resolveTimestampsAsync` on
    `UI_STATE.hidden !== false`, which is TRUE WHILE THE PANEL IS HIDDEN (the HUD spawns the F3 panel
    `hidden: true`; `ui.picker` toggles that field). The sampler therefore ran exactly when the panel was
    off screen and was skipped whenever it was up, so `perf.noteGpu` kept the value the last hidden frame
    had left. `renderF3Panel` had the polarity RIGHT (`hidden !== false` → return), so the panel drew a
    number nothing updated. Fixed with ONE predicate (`f3Visible()` = `?.hidden === false`) asked by both
    the sampler gate and the writer, and the gate now asserts the predicate, both call sites and that the
    inverted form is gone.
  * **the face of a block broken at a ±Z chunk border was not drawn** — `gatherChunkMeshInput` lays the six
    neighbour solidity planes out as `a * S + b`, but `makeSolidAt` read the ±Z planes as `lx + ly * S`,
    i.e. TRANSPOSED. Uniform planes are symmetric, which is why the flat world never showed it and why it
    surfaced only once an edit made a border plane non-uniform: the mesher then culled the cell at
    (lx, ly) against the solidity of (ly, lx) — the dug block's exposed face was dropped (a hole you can
    see through) and an unrelated cell in the same 32×32 layer was painted instead. Same layout on both
    sides now, and the gate drives a REAL world through the real gatherer with all six neighbours loaded:
    sealed = 0 faces, one dig = exactly 1 face, and its CENTROID must be the block the player dug past
    (`5.5,2.5,32`). Verified to FAIL on the transposed read with the predicted wrong cell (`2.5,5.5,32`).
  * **and a second, independent way the same face could come back**: `drain` documents the in-flight set as
    the validity token ("a key no longer in it was rebuilt on this thread — a block edit — so its result is
    dropped"), but `rebuild` never removed the key. A worker job gathered BEFORE the edit therefore landed
    a frame or two later and overwrote the fresh mesh with the pre-edit geometry, so the face the player
    had just exposed vanished again. `rebuild` retires the token now (the job is not cancelled — nothing is
    told to a worker — it is dropped on arrival), which covers the edited chunk AND every dirty border
    neighbour, because those are exactly the chunks whose planes the edit changed. The gate models a
    saturated one-job pool whose reply is delivered by hand: the token must be gone after the edit step and
    the late result must not reach `apply`.
  VERIFIED: `tsc` 0 errors; `check:ecs` 75/75 (three new behavioural assertions plus the predicate ones, each
  confirmed to fail against the old code); and a real block-breaking run at a chunk border with the F3 panel
  up. Not changed: the P1.90 pacing decisions, the launch arguments, and the mesher's output format.
- **P1.92 — the world has TERRAIN: a noise height field, and it is a torus-periodic one.** `DONE`, by request
  («现在立刻开始弄个噪声生成地形让我开始测试»). The flat layer cake is gone. The generator's shape is
  unchanged in the only way that matters — `generateChunk()` is still the ONE place that decides what a block
  is — but "which y is the surface" moved into a new pure module, `data/world/terrain.ts`:
  `terrainHeight(x, z)` answers the FIRST AIR LAYER of a column, and the generator writes grass over a
  3-layer dirt band over stone from the chunk's floor up to it.
  THE DESIGN DECISIONS, and what each one is protecting:
  * **PURE AND STATELESS.** No clock, no `Math.random`, no cache, no dependence on generation order: two
    chunks generated at different times (or in different worlds) must agree about the blocks they share, or
    the mesher draws a wall inside the ground and collision disagrees with the picture. The gate builds TWO
    independent worlds and compares a chunk block for block.
  * **EXACTLY PERIODIC ON THE TORUS.** X/Z wraps every `WORLD_CHUNKS_X * CHUNK_SIZE` = 1024 blocks, and the
    renderer draws the far side of the lap next to the near side, so an un-wrapped noise would put a cliff at
    the seam. Every octave's lattice index is taken modulo the cells in one lap and every cell size divides
    the period (128/64/32 over a 1024-block lap), which makes `terrainHeight(x) === terrainHeight(x + 1024)`
    ANALYTIC rather than approximate. `terrain.ts` duplicates the period instead of importing `world.ts`
    (which imports it) and the gate asserts the two numbers are equal.
  * **BOUNDED, SO THE FAST PATHS SURVIVE.** The field is clamped into
    `TERRAIN_MIN_Y..TERRAIN_MAX_Y` (96..160 around a base of 128), which is what lets the generator fill a
    chunk UNIFORMLY — and therefore ALLOCATION-FREE — when it is entirely above or below the terrain. Measured
    on the spawn window: 465 of 2312 chunks materialise (14.5 MB), the rest are one value with no array.
  * **THE SPAWN BECAME A QUESTION.** `WORLD_SURFACE_Y` is a LEVEL now, not the ground: the world-entry driver
    asks the generated column (`topSolidY(x, z, WORLD_MAX_Y - 1)`) and teleports the player onto it, on BOTH
    entry paths (behind the loading screen and into an already-warm world). The ceiling argument matters —
    `topSolidY` scans DOWNWARDS, so asking from the old spawn height would answer "inside the hill".
  TWO BUGS IT FOUND IN ITSELF, both caught by the gate's invariants rather than by eye, and both worth
  remembering because the shape of the generator makes them easy to repeat:
  * the "no column reaches into this chunk, so it is all air" test used the MINIMUM height where it needed the
    MAXIMUM: a surface landing exactly on a chunk's first layer lost its grass (the chunk that owned that
    layer bailed out as air, leaving the layer below showing dirt). The two early returns are about OPPOSITE
    extremes — `highest - 1 < bottom` is all-air, `lowest - SURFACE_LAYERS >= top` is all-stone;
  * writing ONLY the dirt band into a `materialise(stone)`-prefilled array left a ceiling of stone over the
    whole world. The array is materialised ZERO-FILLED (air) and each column is written from the floor up, so
    the sky is never touched.
  VERIFIED: `tsc` 0; `check:ecs` 76/76 (the new group asserts periodicity over a lap, determinism across two
  worlds, no hole under a surface and nothing floating above it, the layer order, the declared bounds, and
  that the uniform fast paths still hold); measured 484 sampled columns with zero structural violations, and
  a 2312-chunk window generated in 172 ms. Not changed: the block palette, the mesher, the streaming budget,
  the torus rendering (ghost meshes at the seam are still missing — see the known gaps), and the inert
  superflat/noise choice in the main menu, which still logs the mode and discards it.
- **P1.93 — the world is streamed in TWO RINGS: a distance LOD, and it needs no new mesher.** `DONE`, by
  request («先弄个lod给我看看»). The window was one flat ring of 32³ chunks (`RENDER_RADIUS_CHUNKS = 8`, ~288
  blocks). It is a FINE ring of real chunks plus a FAR ring drawn from the same terrain at `step` (2) fine
  chunks per coarse chunk: a far chunk is still a 32³ array — of 2×2×1 super voxels — and goes through the
  SAME `meshChunk` with the same input contract. The placement scales the mesh by `(step, 1, step)`, which is
  what turns a 32×32 super-voxel face into a 64×64 block face; **not one line of `mesh.ts` changed**, and
  neither did the geometry, the materials or the slot groups.
  THE THREE DECISIONS, each protecting something:
  * **SAMPLED FROM THE HEIGHT FIELD, NOT DIGESTED FROM THE WORLD.** A far chunk calls `terrainHeight` over one
    (S+2)² grid — no world reads, no `isSolid` lookups, no `ensureChunk`, so it costs the world ZERO voxel
    memory and nothing to generate. Digesting four fine chunks would have been ~4× the gather that is already
    the warm-up's dominant cost (measured 0.73–0.92 ms per fine chunk). A one-entry MEMO of the grid (a
    column's 8 chunks stream back to back) removes 7/8 of the sampling: the whole far ring's sampler went from
    2091 ms to ~450 ms.
  * **CONSERVATIVE, SO CRACKS ARE IMPOSSIBLE.** Each super voxel takes the MAXIMUM height of the fine columns
    it covers, so the coarse surface is never below the fine one. The gate asserts it POINTWISE against the
    real generator (every solid fine voxel must be solid in the coarse voxel above it) — that is the property
    that must not regress, and it caught a real bug on the first run.
  * **THE RINGS TILE, AND THEIR KEYS CANNOT COLLIDE.** The fine ring covers coarse columns [-r, r] = fine
    columns [-2r, 2r+1] — an EVEN span, so the rings meet with no gap and no overlap (an odd span leaves a
    one-column hole ring: 32 blocks of sky between the rings). A far key is `"<step>:cx,cy,cz"` in COARSE
    units, so an edit — every dirty key in the world is a fine key in fine units — can never name a far entry.
  THE PRICE, stated in the code and here: a far chunk is PROCEDURAL. A block edited out there is not reflected
  in it (it is correct wherever the player can reach, because the fine ring owns that). Warming the far ring
  up would need a world-backed sampler, which is the version to write if that ever matters.
  MEASURED on this machine (packaged build), against the P1.92 single window (2312 chunks / 465 materialised /
  629,514 faces / 91.3 MB / `WORLD ready at 2023ms`):
  * the fine ring alone: 1568 chunks / 324 materialised / 241k faces / 35 MB;
  * the far ring adds: 1408 chunks / 296 materialised / 245k faces / 35 MB at **0.83 ms per chunk** (a uniform
    far chunk 0.33 ms, one that builds a mesh 3.0 ms — hence a COST-WEIGHTED per-frame budget,
    `LOD_BUDGET_PER_FRAME` units with a mesh costing `LOD_MESH_COST`, capping the far ring at ~6 ms of a frame);
  * TOTAL: **486k faces and 70 MB for a world that reaches ~512 blocks instead of ~288** — i.e. twice the view
    distance for LESS geometry than before, because the fine ring is smaller than the old flat window;
  * `WORLD ready at 205ms` (the warm-up still builds only the fine ring), then the far ring streams in over the
    first ~3 s with no stall (`FRAME n=61 avg=16.6ms max=17.7ms stalls=0` once it has landed), F3's GPU figure
    2.21 ms from y=207 with the whole double-ring view on screen, and the terrain now fills the view well above
    the horizon line a fine-only window ended at.
  - `src/data/world/lod.ts` (new): the ring policy + the conservative sampler
  - `src/data/world/world.ts`: the layer rule factored into `terrainLayerValue`, so the generator and the LOD
    sampler cannot disagree about grass/dirt/stone
  - `src/plugins/render/systems/chunk-stream.ts`: two wanted sets, far keys, `buildFar`, the weighted budget,
    and `place` scaling a far mesh by its step
  - `src/data/globals/gfx.ts`: `ChunkMeshEntry.step` + `ChunkMeshCache.farKeys`
  - `src/plugins/render/index.ts`: the shipped policy (`DEFAULT_LOD`); the stream's own default stays "no LOD",
    which is the shape the worker/streaming tests drive
  - check-ecs: a new group (the rings tile with no gap and no overlap; every solid fine voxel is solid in the
    coarse one above it; a sampled chunk really does build geometry) and the two constructor-shape assertions
  - docs: AGENTS (the world state, the two-ring bullet, the known gaps), ROADMAP (the stage table, §3.6, this
    entry), TESTING (what an LOD ring looks like and where its boundary is)
- **P1.94 — the LOD's two follow-ups: the EMPTY COLUMN is fixed, and `G` shows you the tiers.** `DONE`, by
  request («先弄好lod的空列，侧面空洞先不理然后添加按钮g让我看见lod层级颜色»).
  * **THE EMPTY COLUMN (a real, player-visible bug of P1.93).** The fine window was built around the player's
    OWN chunk column while the far ring's inner hole is a whole number of COARSE columns — two sets that agree
    only when the player's column is EVEN. On an odd column the rings were shifted by one: one fine column was
    drawn by BOTH rings (two meshes in the same place, z-fighting) and one by NEITHER. The missing one is not a
    cosmetic seam: it is a 32-block-wide, full-depth column with no geometry at all, whose neighbours' walls are
    culled (their planes read the world, which has terrain there), so the player looks straight through the
    ground. Measured on the old code, per player column: even → 0 twice / 0 never; odd → 1 twice / 1 never, on
    every odd column tested (1, 3, 7, 101).
    THE FIX is `fineBase(policy, pc)` (`data/world/lod.ts`): the window is anchored to the coarse grid
    (`floor(pc/step)*step`), which is the only base at which the two rings tile. `step()` compares and stores
    the anchored column, and `prime`/`needsWarmUp` anchor too — a warm-up asked about a different column set
    than the one it will build would answer "already decided" for a cold window. With no LOD it is the
    identity, so the single-window path is byte-for-byte unchanged.
    VERIFIED on the REAL STREAM (not a re-derivation): with the player on columns 0/1/2/3/7, the stream's own
    `wantedKeys` + `farKeys` cover the same 900 columns with 0 drawn twice and 0 drawn never; the gate now
    tiles EVERY parity (0, 1, 2, 3, 7, 8, 100, 101, 251, 252) — its old assertion built both sets in absolute
    coordinates, which coincides with the player-relative frame only at column 0, which is exactly why it
    passed while the bug shipped.
  * **`G` — THE LOD VIEW.** Pressing G tints every chunk mesh by its tier (`LOD_TIER_TINT`: the fine ring green,
    the far ring blue), so "which part of the world is coarse" is something you can SEE. The tint MULTIPLIES the
    material (a textured block keeps its texture and takes the hue) and is part of the material cache key, so a
    tinted world holds one extra material per (look, tier) and the untinted ones stay cached — the view toggles
    off for free. Handled by `chunk-stream` itself: it owns the meshes and their materials, and a retint is one
    material swap per entry, which is exactly the reload's restyle (no geometry is touched). The key arrives
    through the same `KEY_EVENTS` log the other global chords use, with its own `KeyEdgeReader` cursor; G is
    bound to nothing else; a held key (repeat) and the key release are ignored.
  NOT FIXED, BY REQUEST: the far ring's outward rim still has no walls (a coarse chunk culls its outer faces
  against terrain that is not drawn there — the documented "edge of the world", now at ~512 blocks), and the
  ring boundary is still a visible LEDGE (the conservative max), not a stitched seam.
  VERIFIED: `tsc` 0; `check:ecs` 77/77 (the parity tiling loop, the conservativeness test, and a behavioural
  `G` test driving a real stream with a recording factory: plain → tinted per tier → unchanged by a repeat or a
  key release → plain again); the real-stream tiling probe above. Not changed: the mesher, the ring policy
  numbers, the streaming budgets, and the far ring's procedural nature.
- **P1.95 — the one-block holes at the LOD seam are closed (the cull-safe side planes).** `DONE`, by request
  («边缘位置由于方块简化后边对不上可以看到侧面被剔除的部分导致的空洞非常的小只有一个方块那样»).
  THE BUG, exactly as the user described it: a far chunk's ±X/±Z quad is `step × step` BLOCKS wide, but the
  neighbour on that side may be the FINE ring, whose surface is per BLOCK. The plane was built from the MAXIMUM
  height of the covered cell, so wherever the terrain stepped INSIDE that 2×2 area the wall was culled — and
  the lower fine block has no geometry of its own either, so you saw straight into the terrain through a hole at
  most one block across. Measured on the boundary wall of one far chunk: 863 of 1024 cells culled, 3 of them
  covering at least one air fine block, 2 with the far chunk's own body solid behind (i.e. showing its
  interior). Over three sampled boundary walls: 16 such cells.
  THE FIX is a second sampled grid: the sampler now keeps BOTH the MAXIMUM and the MINIMUM height of the
  covered `step × step` fine columns. The BODY and the ±Y planes take `max` (unchanged — the vertical neighbour
  is always the same level, because the rings are split by COLUMN, so `max` is exact there and the conservatism
  that makes cracks impossible is untouched); the ±X/±Z planes take `min`, i.e. a side wall is culled only when
  the WHOLE area it covers is solid. That is the only rule that is safe against a neighbour at ANY level, so it
  needs no knowledge of where the player stands (the alternative — a per-side "does this face the fine ring"
  mask — would have to live in the far chunk's KEY, because the answer changes as the ring moves).
  COST, measured on the far ring (1408 chunks / 296 materialised): **+2,439 faces (+1.0%)**, 35.5 → 35.9 MB,
  0.83 → 0.87 ms per chunk. The extra walls are drawn where the neighbour cell is only PARTLY solid, i.e. they
  are hidden behind the neighbour's own blocks — overdraw, not visible geometry.
  THE GATE NOW CHECKS IT PER BLOCK: every ±X/±Z plane cell that says "solid" must have every fine block it
  covers solid at that height, and the extra-wall ratio must stay small. Verified to FAIL on the old rule with
  exactly 16 bad cells, so the assertion has teeth. The old check ORed the two z blocks of the cell, which is
  precisely what hid this class of hole — one block across.
  NOT CHANGED, BY REQUEST: the world's outer rim still draws no walls (the documented "edge of the world") and
  the ring boundary is still a visible LEDGE (the conservative max), not a stitched seam.
- **P1.96 — `H` shows the meshes as a triangle wireframe.** `DONE`, by request («现在添加个h键位显示三角形线框»).
  `H` switches every chunk mesh to three.js's triangle wireframe: the mesher emits two triangles per face, so
  what you see is the mesh's REAL triangle edges (a flat ground shows the diagonal of every quad), which is what
  makes it useful for checking the things the last few rounds were about — a dug block's faces (P1.91), the ring
  boundary (P1.93/P1.95) and the LOD's coarse tier (whose triangles are twice as big as the fine ring's).
  HOW IT IS DONE, and the one non-obvious part: `wireframe` is a flag on the (shared, cached) chunk material, so
  ONE key press switches every chunk at once — but it is applied on every material RESOLUTION (`debugged` in
  `chunk-stream`), not only on the key press, so a pack reload (which drops the material cache and builds fresh
  materials) cannot silently lose the view. Both debug keys now share one `KEY_EVENTS` drain and one
  `refreshMaterials`, and they are independent: `G` + `H` gives a tier-COLOURED wireframe, which is the useful
  combination while checking the LOD.
  VERIFIED: `tsc` 0; `check:ecs` 77/77 with the `H` path driven end to end on a real stream (on → every entry's
  material carries the flag → a repeat and the key release are ignored → `G` does not disturb it → `H` again
  restores the solid look); live: 60 fps with the wireframe on, and the ring boundary is visible as a density
  change rather than a colour change.
- **P1.97 — a resource-pack switch now reaches the LOD ring (the reload's set was too narrow).** `DONE`, by
  request («已加载的lod切换资源包后不更新贴图当加载新的lod或者就lod被刷新后就加载新资源包的题图什么问题» — the
  user's report was exact, including the two cases that DID work).
  THE BUG: the reload's "re-resolve the looks" queue is filled by `VoxelWorld.markAllStale()`, which walks the
  WORLD's chunk map. The FAR RING is procedural and deliberately holds no chunk in that map (P1.93: it costs the
  world no voxel memory), so it was never named — and `restyle(key)` looks a chunk up by key, where a far entry's
  key is `"2:cx,cy,cz"` in coarse units. Every already-loaded far chunk therefore kept the PREVIOUS chain's
  material objects (the driver disposes and clears the material cache, but a mesh still holding the old material
  keeps rendering the old texture), while a far chunk built AFTER the reload — or one that was rebuilt after
  leaving and re-entering the ring — resolved fresh materials and looked right. Exactly the three behaviours
  reported: loaded = stale look, new/refreshed = new look.
  THE FIX is the second queue: `ChunkStreamSystem.markFarStale()` names every `step > 1` entry in the mesh cache,
  `restyleNext` drains the world's queue AND that one under the same per-frame budget, `restylePending` is their
  sum (the reload bar counts real work, so it has to see both), and the driver marks both in ONE place
  (`markChainStale`) on the success path and the rollback path alike. Nothing is meshed: `restyle` re-resolves
  the geometry's `(value, kind)` slots into the new chain's looks and swaps the material — and because that path
  also re-applies the debug views, a `G`/`H` state survives a reload on the far ring too.
  THE INVARIANT, now written down where it can be read: **a chain change must reach everything in the
  CHUNK_MESHES cache, not everything the world holds.** The gate asserts it with a generation stamp on every
  material the factory hands out: the world's queue alone leaves the far ring untouched (the bug, asserted as
  the contrast), and after `markFarStale()` EVERY entry — fine and far — has been re-resolved with no mesh lost
  and both queues empty.
  VERIFIED: `tsc` 0; `check:ecs` 77/77; live: F7's reload line now counts the far ring as well
  (`<n> chunk(s) stale, <n> restyled behind the screen`), and the far terrain takes the new chain's look without
  being rebuilt.
- **P1.98 — a chunk that APPEARS fades in, and an edit never does (`J` switches the effect off).** `DONE`, by
  request («区块加载就闪是不是要弄淡入什么的效果比较好» — after first asking how Distant Horizons and Cubyz do it,
  «E:\distant-horizons-3.3.4你看看他的加载效果…进入世界是从lod开始逐渐改改精度的»).
  THE COMPLAINT: a chunk that streams in pops at full opacity — a flash, and the worst case is the far ring,
  where one chunk covers 64×64 blocks.
  HOW THE TWO REFERENCE PROJECTS DO IT, and what was taken from each: **Distant Horizons** fades the LOD ring
  with a **DITHER** (`ditherDhFade`, `uDitherDhRendering`, over the last 0.5×–0.9× of the far clip) and
  deliberately keeps Minecraft's own chunk fade OFF so that vanilla chunks never flash at the DH border;
  **Cubyz** fades the last 32 blocks before `lodDistance` in the fragment shader (`passDitherTest`) and keeps a
  separate face range per coarser neighbour. Both therefore fade by DISTANCE, in the shader, and both fade the
  coarse tier only. This engine's window is small enough that the seam is worth hiding case by case instead:
  the fade here is **per chunk, on its FIRST appearance, in both rings, with no shader at all** — a plain
  material `opacity` ramp, which is what the flat `MeshLambertMaterial` pipeline can do without a custom node.
  THE MECHANISM: `FADE_IN_MS = 220` (~13 frames at 60 fps: long enough to read as a fade, short enough that a
  walking player never sees a translucent wall). A chunk's materials are shared per (look, tier) — that sharing
  is what makes `G`/`H` and a pack reload cheap — so a per-chunk opacity needs a **per-chunk COPY**:
  `beginFade` clones the resolution `materialsFor` just returned (so a tier tint or the wireframe comes along),
  sets `transparent = true, opacity = 0`, swaps them in and pushes a fade entry; `advanceFades` ramps them by
  the **LANE'S DELTA** (frame-rate independent, and testable: one big `step` finishes a fade), and at
  `>= FADE_IN_MS` `dropFade` puts the SHARED material back and **disposes** the copies. `depthWrite` stays ON:
  the chunk keeps occluding itself, so a fading chunk never shows its own back faces.
  WHERE IT IS CALLED, and the one place it must NOT be: `build`, `buildFar` and `applyResult`-fresh — the three
  ways a chunk gets a mesh — and **never `rebuild`**, because the block the player just dug is the one thing
  they are watching (P1.18i: an edit must be instant). A fade in flight when that chunk is edited is dropped by
  `advanceFades`' guard (the mesh no longer holds its copies), which is also what frees it — so no other path
  (edit, restyle, pack reload) needs a call.
  `J` IS THE SWITCH, a third debug key beside `G` (tier tint) and `H` (wireframe), handled in the same drain,
  and turning it OFF calls `finishAllFades`: with the effect off nothing would ever finish a fade, so a chunk
  caught mid-fade would stay translucent for ever.
  VERIFIED: `tsc` 0; `check:ecs` **78/78** with a new group driving the whole thing on a real stream (0 opacity
  on the first appearance → a `step(0)` does not move it → half the time is half the opacity → at `FADE_IN_MS`
  the shared material is back and every copy was disposed → an edit inside a chunk that is mid-fade puts the
  SHARED material back instead of restarting a fade → with `J` off, and after moving the window, the new chunks
  are opaque at once → with `J` on again the new chunks start invisible). BOTH NEW RULES WERE MUTATION-TESTED:
  adding `beginFade` to `rebuild` fails the edit assertion, and replacing the lane delta with a fixed
  `1000/60` fails the "no time, no progress" one.
  NOT CHANGED, BY REQUEST: nothing else — no shader, no fog, no distance-based fade, and the far ring's build
  cost is untouched (the fade is one clone and one material swap per chunk).
- **P1.99 — the other half: a chunk that LEAVES now fades out too.** `DONE`, by request («不理先，加入淡出效果»,
  after asking whether only the fade-in existed — it did, and the answer named the three places a chunk vanished
  on the frame it left).
  THE GAP: P1.98 faded a chunk IN, but every disappearance was instant — `unloadOutside` (the chunk left the
  streaming window), a chunk whose geometry became empty, and the ring swap, where the coarse mesh vanished on
  exactly the frame the fine chunk replacing it started to fade in. That last one is visible: the fine chunk is
  nearly invisible for its first frames, so the seam showed a flash of sky.
  THE MECHANISM: `unloadOutside` now deletes the KEY at once (nothing may treat the chunk as loaded, and the
  streaming budget may rebuild it) and hands the ENTRY to `beginFadeOut`, which makes the same per-chunk copies
  `beginFade` does — from the resolution `materialsFor` just returned, so a `G` tint or an `H` wireframe comes
  along — and ramps opacity 1 → 0 over `FADE_OUT_MS` (260, deliberately longer than the 220 of the fade in: where
  the two meet, the leaving mesh must still be there while the arriving one is still nearly invisible). When the
  fade ends the mesh leaves the scene AND its geometry is freed. Three things it needs to be correct rather than
  approximately right:
  * **A LEAVING MESH IS OUT OF THE CACHE BUT STILL IN THE SCENE**, so the fade list is the only owner of it —
    and the guard in `advanceFades` (a mesh that no longer holds its copies) must RETIRE an out fade instead of
    dropping it, or a ghost would stay in the scene for ever.
  * **A CHUNK THAT COMES BACK WHILE ITS GHOST IS FADING** takes the ghost down (`killDying` from
    `build`/`buildFar`/`applyResult`), or the same chunk is drawn twice for the rest of the fade — with the
    previous chain's look, if a pack reload happened in between.
  * **`FADE_OUT_MAX` = 512** caps how many meshes may be leaving at once, because the two cases are not alike: a
    NORMAL move retires a whole STRIP (the window is a square, so crossing one column drops ~15 columns × 8 Y
    chunks — measured ~250 with both rings), while a MASS unload (a teleport into a world: the whole previous
    window, thousands of meshes) is all hundreds of blocks away and behind the camera. Past the cap the rest are
    removed at once, exactly as before. `J` (P1.98) switches both directions off.
  VERIFIED: `tsc` 0; `check:ecs` **78/78** with the fade-out driven end to end on a real stream: the window is
  filled, the window moves two chunks, and the leaving meshes are still in the scene at full opacity, at exactly
  0.5 at half the time, and out of the scene (geometry disposed, copies freed) at `FADE_OUT_MS`; a chunk that
  comes back while its ghost is fading has the ghost taken down; and with `J` off a leaving chunk is removed at
  once. BOTH NEW RULES WERE MUTATION-TESTED: removing the `beginFadeOut` call fails "a chunk that LEAVES starts
  its fade at full opacity", and never taking a ghost down fails "at FADE_OUT_MS every leaving mesh is out of the
  scene".
  ALSO FIXED IN THE GATE, found by this work: the fade group moved the shared player row and restored it on the
  last line, so an assertion that threw left the player four chunks away and failed the NEXT group's "a re-entry
  into this window shows no screen" (measured) — the moves are now undone in a `finally`.
  NOT CHANGED, BY REQUEST: nothing else — an edit still never fades (P1.18i), and the fine ring still fades in
  (P1.98: its own edge pops the same way; the alternative is recorded in the P1.98 note).
- **P2.00 — the seam at the fine ring's edge: the far ring now keeps a READY RESERVE under it.** `DONE`, by
  request («弄好让我试试看», after «E:\voxy-263你看看这个怎么实现的lod据说这个比较聪明告诉我» and the two rounds
  before it that read DH and Cubyz).
  THE MEASURED COMPLAINT: with the appearance fades in place the sky at the fine ring's edge still FLASHED —
  the user's own diagnosis was exact («真实区块天空只会闪一下因为淡入淡化变快了而已»): the fades only shortened
  the hole. It was structural. The rings TILE (P1.93: the far ring owns exactly what the fine ring does not), so
  the moment the window moved, a column that left the fine ring was a BRAND NEW far column: no coarse mesh
  existed for it, and until the far budget reached it there was nothing behind the fine mesh at all.
  HOW THE THREE REFERENCES DO IT (all three were read for this):
  * **Voxy** (`E:\voxy-263`) is a 3D mipmap of the real voxels: `WorldSection` is 32³ at a level, `MAX_LOD_LAYER`
    = 4, and `WorldUpdater.insertUpdate` mips every ingested chunk up through all of them (`Mipper.mip` takes the
    MOST OPAQUE of the 8 children, leaves forced opaque, ties to the upper corner). The renderer walks a node
    tree on the GPU (`lod/hierarchical/traversal_dev.comp`): a node with children descends instead of drawing
    itself, and a node whose own mesh is missing requests it and DESCENDS meanwhile. The coarse level therefore
    always COVERS the fine one — the seam is a swap of which level is drawn, never a hole. Their only fade is at
    the very edge of the render distance (last 10%), and Sodium's per-chunk fade-in is CANCELLED
    (`MixinRenderRegionManager.voxy$cancelFade` → `-999999`).
  * **Cubyz** draws a parent node until all 8 of its children are meshed (`mesh_storage.zig`: rendered unless
    `finishedMeshingHigherResolution == 0xff`), re-meshes the boundary faces per coarser neighbour
    (`chunk_meshing.zig` `// lod border:`, mapping its own coordinates with `>> 1`), and fades ONLY the LOD
    geometry by distance with a 32-block dithered discard (`chunk_fragment.frag`, `opaqueInLod != 0`).
  * **Distant Horizons** renders vanilla and LODs into two depth-buffered images and blends them by distance in
    a full-screen pass (`vanilla_fade`: 1.5×–1.9× the LOD near clip), and DISABLES Minecraft's own per-chunk
    fade-in — "to prevent vanilla chunks from flashing on the Distant Horizons border" (3.3.4 even ships that as
    `disableVanillaChunkFadeIn()`).
  THE FIX HERE, the smallest version of that idea: `isFarBuildColumn` (data/world/lod.ts) is the BUILD set — every
  coarse column within `farRadius`, with `farBuildInner` (0 by default) as the knob — while `isFarColumn` stays
  the DRAWN set. `chunk-stream` builds both (`farReserveOffsets` after `farOffsets`, so entering a world fills
  the visible ring first) and `refreshFarVisibility` decides per frame which coarse chunks are needed: a column
  the fine ring covers keeps its coarse chunk hidden as soon as the fine chunks of that column are all DECIDED
  and none of them is still fading — otherwise it stays up. Walking, the trailing column's coarse chunk is drawn
  in the same step its fine chunks leave; the leading column keeps its coarse chunk until the fine chunks that
  replace it are opaque. The reserve is invisible (no draw calls) and is only ever built once per column; it
  costs the far budget one extra coarse ring (~24 columns at the shipped shape) and ~6 MB of meshes.
  VERIFIED: `tsc` 0; `check:ecs` **79/79** with a new group on a real stream and a tiny policy: the drawn set is
  still a tiling subset of the build set; with the window warm every covered coarse chunk is invisible and every
  drawn one is visible; moving one coarse column, the leaving column's coarse meshes were ALREADY built (they
  were the reserve) and are drawn in that same step; the column the fine ring claims stays drawn until its fine
  chunks are built AND opaque, then hides. MUTATION-TESTED both ways: removing the reserve from the build set
  fails "the reserve really covers coarse columns", and hiding a covered column regardless of its fine chunks
  fails "it is STILL DRAWN while its fine chunks are not built yet".
  ALSO FIXED: `scripts/check-ecs.mjs` was corrupted by a PowerShell `Set-Content` round trip (its UTF-8 `…`
  characters became `\uFFFD?`, breaking a string literal) and was restored from the commit, then re-edited with
  the file tools only. Do not write source files with PowerShell here.
  STILL POSSIBLE, NOT DONE (by request: one thing at a time): the DISTANCE DITHER fade (Cubyz-style, only the
  coarse tier, in a fragment stage) would retire the appearance fades entirely, and the fine ring could then
  stop fading in — which is what all three references do at this boundary.
- **P2.01 — the two fades become a per-ring SETTING in the settings panel.** `DONE`, by request («先在设置添加lod
  淡入谈出选项，和真实区块淡出淡入选项其他先不管»).
  WHY THEY ARE TWO QUESTIONS NOW: P1.98/P1.99 faded a chunk in when it appeared and out when it left, and P2.00
  made that unnecessary for the seam — the far ring keeps a READY RESERVE under the fine ring, so a real chunk is
  always replaced by geometry that is already there (the user's own finding: with the fades off the real chunks do
  not flash at all). What is left is a LOOK, and the two rings do not share it: the far ring's own outer edge
  still has nothing behind it, so its fade covers a real pop; the fine ring's fade is pure preference. All three
  reference implementations studied for P2.00 agree — Voxy cancels Sodium's per-chunk fade, Distant Horizons
  disables Minecraft's (`chunkSectionFadeInTime = 0`), Cubyz fades only its LOD geometry — so the shipped
  defaults are **LOD fade ON, real-chunk fade OFF**.
  HOW IT IS WIRED (the shape the frame cap and vsync already had): the values live in the `FADE_OPTIONS` resource
  (`data/globals/resources.ts`, `createFadeOptions` sanitising the file with the same "absent or unusable means
  the sane default" rule), the composition root loads them from `settings.json` and inserts the resource, the two
  settings rows change them through the `SetFadeOption` COMMAND (a UI callback may not assign a resource the tick
  reads), the save is HANDED the new value, and the boot settings check carries both in its `inForce` schema.
  `chunk-stream`'s `fadeOn(step)` is the whole reader: `step > 1` asks the LOD option, `step === 1` the chunk one,
  and the `J` key stays a session-only master switch over both (it never writes the file). The reserve's
  readiness rule (P2.00) needed no change: with the fine fade off there is simply no fine fade to wait for.
  THE ROWS are two-state toggles next to the diagnostic log's, with hints that say what each one means — the
  real-chunk hint names the reason it can safely be off ("the reserve covers the swap").
  VERIFIED: `tsc` 0; `check:ecs` **80/80** with a new group: the defaults and the sanitising rule (a sweep of
  unusable values), the `SetFadeOption` command applying at the BARRIER and touching one ring at a time, and a
  real stream driven through both flips — with the shipped defaults a NEW real chunk holds the SHARED material
  (no fade) while a new far chunk gets its own copy, and after `SetFadeOption` turns the chunk fade on and the LOD
  one off the next chunks that appear are the other way round. MUTATION-TESTED: making `fadeOn` ignore the
  options fails "with the setting OFF a real chunk appears on the SHARED material". The settings group also
  asserts the source shape (the command + the handed save + the `inForce` schema) and that all four new i18n keys
  exist in zh/en/ja.
- **P2.02 — the world's XZ lap is a SETTING: a custom size for the noise world, applied on entry.** `DONE`, by
  request («先给噪声世界弄个自定义xz范围的» —「进世界时生效」+「预设几个档位顺便加上自定义xz」).
  WHY IT IS THE FIRST STEP TOWARDS MORE LOD TIERS: the lap is the number that bounds a distance LOD. A ring at
  radius R is unambiguous only while `R < lap/2`; past that its far edge starts showing the terrain that is closer
  the other way round, i.e. the same hill appears twice on screen. The old hard-coded 32 chunks (1024 blocks)
  therefore caps this engine at TWO tiers (the far ring reaches ±480 blocks) — the five or six a planet-like world
  wants need 8192/16384 blocks, which is what the presets offer.
  WHAT MOVED: the period used to be `WORLD_CHUNKS_X/Z` constants in `data/world/world.ts`, duplicated in
  `terrain.ts` as `TERRAIN_PERIOD` with a gate assertion keeping them equal. It now lives in a leaf module
  `data/world/size.ts` that BOTH import (`world.ts` imports `terrain.ts`, so a value in either could not be shared
  without a cycle): `worldChunksX/Z()`, `worldPeriodBlocks()`, `setWorldChunks()`, `sanitizeWorldChunks()`. Every
  reader asks it — `wrapChunkX/Z`, `terrainPeriod()` (the noise MUST repeat exactly on
  the lap, so the lattice wrap is modulo the lap in force), the LOD sampler's `wrapBlock`, and the chunk stream's
  `nearestWrap`/`farKeys` periods.
  A LEGAL SIZE IS A MULTIPLE OF 16 CHUNKS (512 blocks), for two independent reasons: the terrain's coarsest octave
  is 512 blocks per lattice cell and every octave has to divide the lap, and the LOD rungs are powers of two, so
  the wrap must land on a cell grid both can align to. So "custom" is a custom multiple of 16: the panel offers
  the presets 1024/2048/4096/8192/16384 blocks as buttons AND a slider (32..512 chunks, step 16) bound to the value
  in force, and the domain is declared ONCE (`size.ts`) so the panel, the command and the entry cannot disagree.
  APPLIED ON ENTRY, NO RESTART (the user's choice): `enterWorld` starts by reading `WORLD_SIZE`, and when
  `setWorldChunks` reports the lap actually moved it resets the voxel map (`VoxelWorld.reset`) and every mesh
  (`chunkStream.resetForNewWorld`) — a chunk key is a WRAPPED identity and a mesh belongs to the old lap, so
  nothing may survive. That drop is also what makes `needsWarmUp` answer "yes", so the loading screen comes up and
  the whole window is rebuilt for the new world. Entering a world of the SAME size does nothing at all, so a
  re-entry stays as free as it was.
  THE CHOICE IS A SETTING: a `WORLD_SIZE` resource the driver reads, changed by the `SetWorldSize` command from the
  world-type panel (so a UI callback never assigns state the tick reads), written to `settings.json` as `worldXZ`
  with the value HANDED to the save, and carried in the boot check's `inForce` schema.
  VERIFIED: `tsc` 0; `check:ecs` **81/81** with a new group: the legal domain (clamping, snapping, presets, and
  `worldSizeFitsLod` accepting the shipped ring and refusing one that would reach past the half-lap); a REAL size
  change to 64 chunks — the period in force, the noise's lap, exact periodicity over the NEW lap and the loss of
  periodicity over the OLD one (a "change" that did not really move would leave the world as it was), a real torus
  wrap at the new size, and `VoxelWorld.reset` throwing the old world away — then the default is restored in a
  `finally` because every later group assumes it; the render half on a real stream (`resetForNewWorld` leaves no
  mesh and makes the window count as work again); and the wiring as source text (the entry applies it BEFORE it
  asks `needsWarmUp`, the command + handed save + `inForce` schema, the presets and the bound slider, and the two
  new i18n keys in zh/en/ja). MUTATION-TESTED: making `terrainPeriod()` a constant fails "the noise's lap follows
  the world".
  NOT DONE, AND THE NEXT STEP TOWARDS 5–6 TIERS: the ring ladder itself (a third, fourth… tier with its own
  radius, each finer tier's coverage becoming the next one's reserve), plus CHUNK EVICTION — a bigger lap makes the
  never-evicted chunk map (ROADMAP §3.2) matter more, because it grows with exploration rather than with the lap.
- **P2.03 — the far ring becomes a LADDER of six rungs, each one the next's ready reserve.** `DONE`, by request
  («先不管先弄lod层数吧弄个6层»).
  WHAT IT REPLACES: P1.93's window was exactly TWO rings (a fine one and one coarse one at `step` 2). It is now
  `DEFAULT_LOD = { tiers: 6, reach: 4 }`: rung 1 is the fine ring (real 32³ chunks), rung L has `step = 2^(L-1)`
  cells of `32·step` blocks, its ANNULUS is `reach` of those cells wide, and its HOLE — what it only BUILDS and
  keeps hidden — is exactly the coverage of everything inside it. The radii therefore grow: 128, 384, 896, 1792,
  3584 and 7168 blocks, so the outermost rung is what the biggest world-size preset (512 chunks, 16384 blocks) is
  for. **How many rungs a world gets is the LAP's business** (`lodTierFits`): the five presets hold 2, 3, 4, 5 and
  6, the DEFAULT 1024-block world holds 2, and the world-entry driver logs the number it built. `reach` is 4
  rather than 6 because a rung's hole is everything inside it — 6 would put the sixth rung at 12096 blocks and
  need a lap this engine does not have.
  THE HARD PART WAS THE TILING, AND IT IS WHY `LodTier` CARRIES RANGES. A rung's cells are aligned to the WORLD
  (a coarse cell must not move as the player walks, or the far terrain crawls), while the range that covers the
  window is measured from the window's own centre — so a rung whose centre is off its own grid has asymmetric,
  rectangular ends and NO fixed radius. `LodTier` therefore holds a `LodSpan` per axis (`lo`, `hi`, `holeLo`,
  `holeHi`) computed in absolute blocks by `lodLadder(policy, lap, centreX, centreZ)`, and the rungs CROP each
  other: a coarse cell only half covered by the finer coverage cannot be owned by both (a gap is a see-through
  hole, an overlap is z-fighting), so the rung inside gives the cell up. The first implementation kept the old
  symmetric radius per rung and the gate's tiling sweep caught a 64-block gap plus a z-fighting strip at every
  boundary above step 2 — the P1.94 bug in its general form.
  THREE MORE FIXES THE LADDER EXPOSED, all in the reserve/window logic:
    * the fade guard in `refreshFarVisibility` was keyed by the rung's OWN step, so a rung's reserve was held on
      screen by its own fade-in (a coarse surface drawn over real terrain for 220 ms). It is now keyed by the rung
      IMMEDIATELY INSIDE (`finerColumnFading`/`finerColumnDecided`), which is what the reserve actually waits for.
    * `finerColumnDecided` wrapped the children with the FINE period. With two rings that was correct (the only
      coarse rung's children ARE fine chunks); at rung 3 it made the children unmatchable at the torus seam, so a
      rung-3 reserve stayed drawn for ever one cell outside the wrap. `finerCells` now wraps by the finer rung's
      own period.
    * the ladder and the window's `offsets` became POSITION-dependent, and they were built inside `step()` — so
      `needsWarmUp`, which the entry driver asks BEFORE anything has stepped, read an EMPTY window and answered
      "nothing to build" for a cold world. That branch also holds `prime`, so a first entry would have skipped the
      loading screen AND the generation of the spawn window. `ensureLadder(pcx, pcz)` builds them for the position
      being asked about (two integer comparisons when it already matches), and the gate now asks a cold LOD window
      before any step.
  ALSO: `tierTint` indexed `LOD_TIER_TINT` by `step - 1`, which only worked while the ladder had two rungs; it is
  indexed by the rung now (six colours); the fine ring's offsets come from the ladder's rung 1 rather than the
  policy, so the two can never disagree about where the window ends; and the gate's P1.95 wall check was passing
  VACUOUSLY since the P1.93 signature change (`buildLodMeshInput(policy, …)` sampled with an object as `step`,
  which produced an all-air chunk the `input.uniform` guard skipped) — fixed to `T2.step`, so those 500+ cells are
  really inspected again.
  VERIFIED: `tsc` 0; `check:ecs` **82/82** with a new P2.03 group (the rung count per preset AND that it does not
  depend on where the window sits; every rung's step/reach/hole and the hole-is-the-inner-coverage identity in
  fine chunks; the tiling over four policies with both axes on different alignments; and a REAL 3-rung stream
  driven through the handover at rungs 2 and 3 — the cells a rung's hole gives up were the reserve, are drawn in
  the same step, and the cells it claims stay drawn until the finer chunks over them are built AND opaque).
  NOT DONE, AND THE NEXT STEPS: chunk eviction (a bigger lap and six rungs make the never-evicted chunk map matter
  more), and the outer rim (no fog yet, so 7168 blocks of world ends visibly).
- **P2.04 — the camera's far plane is raised to fit the ladder, and only the OUTERMOST rung fades.** `DONE`, by
  request («b试试…顺便改lod淡出淡入只有最外层的lod才有淡出淡入»).
  WHY THE CAMERA HAD TO MOVE: P2.03's ladder reaches 7168 blocks (its corner ~10138) while the camera's far plane
  was still `5000` — and a far plane is not a "draw distance hint": `three` culls an object whose bounding volume
  is entirely outside the frustum, so the outermost rung was BUILT, paid for (CPU + GPU memory) and never drawn,
  and the user saw the world end at ~5000 blocks with nothing but the flat sky behind it. `boot/main.ts` is
  `new THREE.PerspectiveCamera(75, aspect, 0.25, 12000)` now.
  WHY `near` IS 0.25 AND NOT 0.3–0.5: the DEPTH BUFFER's precision is dominated by `near`, and raising it is the
  cheap way to pay for a longer far plane — but the collision box is `halfWidth` 0.3 (`HUMANOID_BODY`), i.e. a wall
  you press against is 0.3 blocks from the eye, so anything above that clips the wall away at arm's length.
  0.25 sits just under that limit, improves the distance precision 2.5× over the old 0.1, and more than pays for
  the 2.4× longer far plane. (If distant z-fighting ever shows up, the next step is `logarithmicDepthBuffer: true`
  — confirmed to exist in this three build's `WebGPURenderer` — which would let `near` go back to 0.1.)
  **CORRECTION (same round, from the user's report): `near` is 0.1 again.** 0.25 was measured to let the player
  see THROUGH the wall beside them: the limit is not the body's 0.3 half-width but where the FRUSTUM reaches that
  wall, which is a depth of `0.3 / tan(halfFovH)` — ≈0.22 with a 16:9 window, less on a wider one — so a `near`
  above it clips a sliver of wall at the LEFT/RIGHT screen edges (straight ahead and above/below were fine, which
  is exactly what the report said: 「靠近方块左右两边好像可以透视」). `far` stays 12000: that is the half of
  P2.04 the ladder actually needed, and the precision `near` 0.25 bought is the precision the engine always had.
  If distance z-fighting ever shows up, `logarithmicDepthBuffer` is the answer, not a bigger `near`.
  THE FADE RULE (P2.04 proper): `fadeOn` was `step > 1 → fadeOptions.lod`, i.e. EVERY coarse rung faded. Only the
  OUTERMOST one should: every rung inside it is replaced by a cell the rung outside it was already holding in
  reserve, which is a swap between two meshes that are both on screen — a fade there only made the handover look
  mushy — while the outermost rung's own outer edge has nothing beyond it, so a cell appearing or leaving there is
  a REAL pop and keeps the fade. `fadeOn` now asks the ladder in force (`this.ladder`, rebuilt as the window
  moves) which rung is outermost, so a world whose lap holds two rungs fades its own outer rung, and the settings
  label/hint (zh/en/ja) say 「最外层 LOD 淡入淡出」.
  VERIFIED: `tsc` 0; `check:ecs` **82/82**, with the P2.01 group widened from a two-rung to a three-rung ladder so
  the assertion can tell "the outermost" from "a rung inside it": step 4 must take its own material copy to fade
  with while step 2 must appear on the SHARED material, and after flipping both settings (and MOVING the window,
  because the drain loop above leaves nothing new to build) the outermost rung appears shared with the fade off.
  Deliberately NOT verified live this round: the user asked to test the packaged build by hand.
- **P2.05 — the fade is UNIFORM again: every chunk fades in when it appears, out when it leaves.** `DONE`, by
  request («弄好淡出淡入…不改成最外层而是要那种…不分真实区块»). Supersedes the fade RULE of P2.01/P2.04 (the camera
  work of P2.04 stands).
  WHAT CHANGED: `fadeOn` was `step > 1 → only the outermost rung` (P2.04) and before that `step 1 → chunks,
  step > 1 → lod` (P2.01). It is now ONE answer for every step — `fadeEnabled && fadeOptions.lod` — so a real
  32³ chunk of the fine ring and a coarse cell of any rung behave identically: appeared → fade in, left → fade
  out. The reservation machinery needed no change (a coarse cell is still drawn until the finer chunks over it
  are BUILT AND OPAQUE, so a translucent chunk never uncovers the sky — it only lets the coarser level show
  through while it arrives), and `FadeOptions.chunks` is now the RETIRED pre-P2.05 switch: still read from an
  older `settings.json` so the boot check does not report it as repaired, no longer consulted by anything.
  THE PANEL HAS ONE ROW NOW (`settings.fadeLod` → 「淡入淡出(所有区块)」 / "Fade in/out (all chunks)" /
  「フェード(全チャンク)」, hint updated in zh/en/ja); the `真实区块淡入淡出` row is gone. `J` is still the
  session-only master switch.
  A SECOND FIX THE CHANGE EXPOSED: `pendingCount()` read the not-yet-built ladder and answered 0 before the
  first step (`this.wanted === null` → `offsets.length * CHUNK_Y_COUNT` with an EMPTY `offsets`), i.e. "there is
  no work" for a cold window — the same trap `needsWarmUp` had. It now builds the ladder for the player's own
  column first (`ensureLadder`), so a driver's load bar, `warmUp` and the gate's fill loops all see the real
  count.
  VERIFIED: `tsc` 0; `check:ecs` **82/82** — the P2.01 group is rewritten for the uniform rule (with the fade ON
  a real chunk AND both coarse rungs take their own material copies; with it OFF every one of them appears on the
  SHARED material; and the retired `chunks` switch provably cannot turn it back on), the settings-source
  assertions now require the single row, and the P2.00 reserve group passes again because the fine window is
  filled where it should be. Not verified live: the user tests the packaged build by hand.
- **P2.06 — the LOD pipeline moves to the GPU (M0 DONE: the sampler probe).** By request («我觉得应该把lod仍进gpu才行
  现在是不是纯cpu计算» → «c吧毕竟cpu吃不消»).
  WHAT WAS MEASURED FIRST, because the decision rests on it (one column = 8 Y chunks, sampling included):
  step 2 → 1.76 ms, step 4 → 5.34 ms, step 8 → 19.2 ms, step 16 → 73.8 ms, **step 32 → 289.7 ms** — the cost is
  `∝ step²`, because a conservative max has to know every one of the `step × step` fine columns in the cell
  (a rung-6 column is 1.18M `terrainHeight` calls). The six-rung ladder is 144+144+144+144+196 = 772 columns, i.e.
  **~71 s of MAIN-THREAD CPU**, of which rung 6 is ~57 s — and because the far budget is charged per CHUNK
  (uniform = 1 unit) while a whole column's 290 ms lands in one step, the player sees **~1 s frame stalls** while
  the outer rungs fill. The fine ring is not the problem: 2.28 ms per real chunk (0.11 generate + 0.72 gather +
  1.45 mesh) on the WORKERS.
  THE ROUTE (agreed, in four milestones): **M0** a probe that proves a GPU port of the field reproduces the CPU's
  values; **M1** sampling on the GPU (one dispatch per rung, one ~0.7 MB async readback, CPU meshing unchanged);
  **M2** the mesher in WGSL, validated against `meshChunk`; **M3** GPU geometry + indirect draw (draw calls from
  thousands to ~6-12) with per-cell visibility kept, because the reserve (P2.00) and the fades need it.
  M0 AS LANDED: `plugins/render/systems/lod-gpu-probe.ts`, run by `K` in a world. It builds the field as TSL
  FROM `TERRAIN_NOISE` (the seed, the octaves, the region cell, the amplitudes — exported as data for exactly
  this reason), one GPU thread per (S+2)² grid cell, `step²` samples per cell, and compares every value against
  `lodSampleGrid` — the production CPU grid, exported for the comparison rather than copied. It logs one line per
  rung (mismatches, max |Δ|, GPU ms, CPU ms) plus a verdict, and toasts the summary. **The answer it exists to
  produce**: f32 arithmetic over the same wrapping-integer hash reproduces the f64 field's rounded heights
  exactly, or it does not — and if it does not, the coarse surface can sit a block low, which is a crack (P1.93),
  so the fix is either f32 discipline on the CPU side or a one-block margin, decided from the probe's numbers.
  VERIFIED: `tsc` 0; `check:ecs` **83/83**, with a new group pinning the probe's foundations (the reference
  accessor IS the production max/min grid, re-derived cell by cell; `TERRAIN_NOISE` carries the field's numbers
  and the octave cells divide the lap; the probe's noise reads that data and never retypes the seed; its declared
  access and its `K` edge). The schedule's render batch gained a member (`lod.gpu.probe`), and AGENTS/TESTING
  were updated with it. The GPU half itself is NOT gate-testable (Node has no WebGPU), which is why the probe
  reports at runtime — M1-M3 will need the same kind of runtime self-check.
  NOT DONE: M1-M3, and the numbers they must beat are the ones above.
- **P2 — write ownership.** `PARTLY DONE`. Every write from outside a system is a named command
  (`SetMode`, `Teleport`, `SelectSlot`, `SwapSlots` in `ecs/commands.ts`) instead of a direct write
  in `main.ts`, `ui/gamemode.ts` or `plugins/ui/views/inventory.ts`. The per-entity capabilities that used to be
  constants or system fields are components now too (BODY, REACH, INTERACTION), so "only one entity
  can edit blocks" is no longer baked into the code. `input.ts` was the last module writing a gameplay
  component from outside a system run: its DOM listeners now take the same decisions at the same
  moment and merely QUEUE them (`InputIntent`), and its `step()` — the fixed lane's first system —
  writes CONTROL/VIEW/MOTION with a declared access set. What it still writes at event time is the
  DEVICE state (`INPUT_STATE` — the pointer-lock state machine has to react synchronously to a
  `pointerlockchange`), and it is now the ONLY writer of that resource (`host/browser/pointerlock.ts` no
  longer publishes a cached permission into it). Still outstanding:
  `MOTION.vy` has three
  writers inside the systems (movement's gravity, input's jump impulse, collision's contact zeroing)
  — that is legitimate physics, but a read-only view would make "who may write" checkable.
  TypeScript has no borrow checker, so a read-only interface type is the strongest available form.
- **P3 — remove import-time side effects.** `data/assets/i18n.ts` reads the filesystem at import. `PARTLY DONE`:
  `data/globals/uiscale.ts` no longer mounts DOM at import (the UI stage is `createUiMount()` + UI_MOUNT — §5.2
  P1.12), and `plugins/ui/views/menu.ts` no longer registers its six document listeners at import (they are
  `plugins/input/bind-gesture.ts`'s, mounted by `bindKeybindDrag()` — §5.2 P1.9). **The parenthetical that used
  to sit here was RIGHT, and P1.13 is the bill for it**: "their relative order is load-bearing" — when
  those listeners were installed at IMPORT time they ran before the input system's own listeners and could
  suppress an ESC out of the edge log; mounted from main.ts's body they run after it, which silently broke
  ESC during a rebind capture. The lesson is that a listener whose SEMANTICS depend on being first is
  exactly as fragile as the remaining import-time read, so the fix moved the decision to the event itself
  rather than restoring the order. Still to do: explicit `init*()` calls, and
  `gameRoot` (currently derived twice: `host/desktop/shell.ts` and `data/assets/textures.ts`).
- **P4 — high risk, needs in-game testing.** `plugins/ui/views/menu.ts`'s panel state machine and the key bind
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
| `data/assets/textures.ts:1-2,13`, `data/assets/blockregistry.ts:32`, `data/assets/i18n.ts:2-4` | a built-in `default.zip` / `defaultmod.zip` | `scripts/rearrange.mjs` produces neither, and none exists in the tree |
| `main.ts` (the `navTrees` comment) | an `after` naming a system registered later "would silently drop the edge" | nothing is silent: the schedule resolves names at `start()`, and `Schedule.batch()` THROWS (`"X" must run before "Y" but was batched no earlier`, a message that also misnames an `after` as "before"). The rule it is trying to state is "register a system before anything that points at it" — see §3.9 for the minimal reproduction |
| `packs/*/lang/*.json` `bind.hint` | "select a button, then click a key" | while capturing, a keycap mousedown is consumed and the click swallowed — the only exit is Esc |
| Dead code | `host/desktop/shell.ts`'s `centerCursor` export is never imported (the live one is in `host/browser/rawinput.ts`) | — |

(Four rows left this table across P1.7-P1.11: the raw-input header no longer claims the takeover rule is
"discarded when locked", `host/browser/pointerlock.ts` no longer claims every `relock()` comes from direct user
interaction (the focus-regained and world-entry paths are documented), the `winctl.exe`/`unTopmost` story is
gone with the kiosk path, `plugins/ui/views/inventory.ts`'s never-called `refreshIcons()` went with the view rewrite, and
`wasMaximizedBeforeFullscreen` is no longer even declared.)

---

# 6. The verification loop (there are no tests)

1. `node ./node_modules/typescript/bin/tsc --noEmit` — the type gate.
2. `npm run check:ecs` — the ECS invariant gate (`scripts/check-ecs.mjs`, 69 assertion groups,
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
   `plugins/player/systems/input.ts`, the part no assertion can cover is the feel: mouse look must not stutter or
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
   For `src/core/` add `src\core\world.ts` (plus the `data/`/`flow/` files it imports) to the file list, point
   `--outDir` at its own folder,
   and drop a `{"type":"commonjs"}` package.json in that folder — the repo root is
   `"type":"module"`, so without it Node refuses `require()` on the emitted `.js`. The full command
   is in `AGENTS.md` §Testing.
   `--ignoreConfig` is required (TypeScript 7 errors without it when files are named on the command
   line), and `src/data/world/*` deliberately has **no three.js and no ECS imports**, which is what makes
   this possible. `src/host/browser/chunkmesh.ts` can be tested the same way because Node resolves the
   real `three`; `src/core/*` imports no three.js at all, on purpose.
6. Reminder: `rearrange.mjs` **clears** `game\mods` and `game\resourcepacks` on every build. Re-copy
   `packs\*` before testing anything that involves blocks, language or the menu background.
