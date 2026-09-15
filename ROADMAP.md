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
3. ⚠️ marks work that touches race-sensitive code (`AGENTS.md` iron rule 2) or that can only be
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
| **P2 floating origin** | `TODO` | split coordinates into `int cell + float local`, render camera-relative, update by **delta only** | Must land **before** anything writes absolute world coordinates. `main.ts` currently does `playerPos.copy(SPAWN)` (absolute) — that is the pattern to eliminate. Reference technique: [big_space](https://docs.rs/big_space/0.6.0/i686-unknown-linux-gnu/big_space/) |
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
  `SOLID`, so **which hotbar slot is selected does not matter** — `interaction.ts` only asks the UI
  "is a hand non-empty?" via a callback. Making selection meaningful = palette values in the voxel
  data + per-value material/UV selection in `chunkmesh.ts`.
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

## 3.5 Interaction
- **GAP** Reach is a constant `REACH = 6`; repeat is a constant `REPEAT_SECONDS = 0.18`.
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
- **GAP** The inventory's block selection has no observable effect in the world (§3.2).
- **GAP** No crafting, no containers, no item stacks beyond a display count.
- **GAP** `ui/menu.ts` stores "which panel is open" as inline `style.display` strings and the rest of
  the app parses them (`main.ts`); `Menu.hide()` does not reset sub-panels. Fragile, see §5.2.

## 3.8 Streaming architecture
- **GAP** There is no third clock. `World` has a fixed lane (120 Hz) and a render lane (per rAF);
  streaming and meshing ride the render lane. Real terrain will want a *budgeted background* lane.

---

# 4. DECISIONS — deliberately not done (do not "fix" without asking)

| Decision | Why it is intentional |
|---|---|
| No fog | asked for explicitly; the visible world rim is the accepted cost |
| One block type | content work was explicitly out of scope; the palette is already per-voxel |
| Chunk data never evicted | the torus period bounds it; uniform chunks cost nothing |
| `eval("require")` in `shell.ts` / `rawinput.ts` / `textures.ts` | a plain `require`/import is externalised to `{}` by vite and `fs` becomes undefined at runtime. Load-bearing. The bundler warns; the warning is expected. |
| `const top = NaN` in `input.ts`'s SPACE log | display-only, inside the race-sensitive file. The real surface height is `VoxelWorld.topSolidY()` |
| Dead remnants left in place (main-menu world-type panel, always-hidden loading overlay, comments naming `BlockWorld` / the removed chunk system) | inert; removing them is churn without behaviour change. Superseded by §3 if the UI is ever reworked |
| No test runner, no CI | the verification loop is `tsc` + a manual flythrough (§6) |
| Single-threaded state (iron rule 3) | the only sanctioned extra thread is the raw-input plugin's collector |
| `hasMissingTexture` unread | the field is a placeholder; the mesher culls by geometry, not by this flag |

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
| `applyCursor()` (`platform/pointerlock.ts`) | also writes `input.clickLockAllowed` — a hidden second effect | low |
| `clickLockAllowed` | really means "no UI is open", not "clicking may grab the lock" | low |
| `freeMouseActive` | the cursor is HIDDEN in that mode; it means "Chromium cancelled the lock and the window is partly offscreen" | ⚠️ rule 2 |
| `rawTakeoverActive` (`input.ts`) | a **log de-duplication flag**, not the takeover state; the state is computed on demand | low |
| `MODE_NAMES` (`components/Player.ts`) | `walk → "Survival Mode"`; used by exactly one log line, while the UI uses i18n `mode.*` | low |
| `mode` | three unrelated meanings: `MoveMode`, `WindowMode`, `MenuBgMode` | low |
| `World` vs `VoxelWorld` | the ECS scheduler and the block world; `chunkstream.ts` imports both | low |
| `WORLD_MAX_Y` | the **writable limit** (256), not the visible top (128) | low |
| `SKIN` (`collision.ts`) | the contact epsilon — "skin" also means mesh skinning | low |
| `empty` (`chunkstream.ts`) | chunks that produced **no geometry**, which includes fully enclosed solid ones | low |
| `enterWithLoading()` / `genPanel` / `WorldGenMode` | name promises loading / world generation that do not exist | low, but see §4 |
| `BUILTIN_NAME = "default.zip"` (`textures.ts`) | a **live code path** looking for a pack the build no longer produces; same fiction in `blockregistry.ts` and `i18n.ts` comments | medium |

## 5.2 Make the implicit explicit (ranked; `AGENTS.md` iron rules still hold)
- **P0 — guard rails first.** `tsconfig`: enable `noUnusedLocals` + `noUnusedParameters` (it would
  immediately expose `refreshIcons()` and `wasMaximizedBeforeFullscreen`). Add
  `scripts/check.mjs`: text assertions for the invariants that currently only live in comments —
  `KB_ACTIONS` must cover every `BindAction`, `PHYS_DT × 12 === delta cap`, `panelCss` must still
  contain `display:none;`. **Without this, every later refactor is unverifiable.**
- **P1 — order assertions.** `World.addFixed` / `addRender` take a label; assert at startup that the
  registered order matches the expected sequence (`beginStep → controller → movement → collision →
  interaction`). Order is load-bearing and currently enforced by nothing.
- **P2 — write ownership.** `MOTION.vy` has four writers across three layers (movement per tick,
  the jump key handler, `setMode`, and the spawn reset in `main.ts`). Funnel the non-physics ones
  through named intents (`applyJumpImpulse()`, `resetMotion()`). Consider read-only views
  (`MotionRead`) so "who may write" becomes a compile-time fact — TypeScript has no borrow checker,
  so this is the strongest available form.
- **P3 — remove import-time side effects.** `ui/i18n.ts` reads the filesystem at import;
  `ui/uiscale.ts` mounts DOM at import; `ui/menu.ts` registers six document listeners at import
  (and their relative order is load-bearing). Convert to explicit `init*()` calls from `main.ts`.
  Also converge `gameRoot` (currently derived twice: `platform/shell.ts` and `rendering/textures.ts`).
- **P4 — high risk, needs in-game testing.** `ui/menu.ts` panel state machine; `input.ts` named
  write intents. Both live in code that cannot be verified by reading.

## 5.3 Documentation that still contradicts the code
Verified still present; each is a trap for the next reader:

| Where | Says | Reality |
|---|---|---|
| `ecs/store.ts:4`, `ecs/World.ts:8` | "the hand-rolled Player **stays outside**" the store | the player **is** a bare ECS id + 4 components (`components/Player.ts:3`) |
| `platform/rawinput.ts:5-7` | raw input is used "only when the lock was cancelled … discarded when locked" | `input.ts` says the takeover rule is "**lock state irrelevant**" |
| `platform/pointerlock.ts:11-12` | "all `relock()` calls come from direct user interaction" | `main.ts` also relocks on **window focus** |
| `platform/shell.ts:203-206` | describes a `winctl.exe` topmost fallback | the call is commented out (`:210`); the real path is `setAlwaysOnTop` |
| `rendering/textures.ts:1-2,13`, `blockregistry.ts:32`, `ui/i18n.ts:2-4` | a built-in `default.zip` / `defaultmod.zip` | `scripts/rearrange.mjs` produces neither, and none exists in the tree |
| `ui/inventory.ts:148` | `refreshIcons()` re-bakes icons on UI-scale change | the method is **never called** (`iconSize` is fixed at 40) |
| `packs/*/lang/*.json` `bind.hint` | "select a button, then click a key" | while capturing, a keycap mousedown is consumed and the click swallowed — the only exit is Esc |
| Dead code | `shell.ts:201,228` `wasMaximizedBeforeFullscreen` is written and never read; `shell.ts`'s `centerCursor` export is never imported (the live one is in `platform/rawinput.ts`) | — |

---

# 6. The verification loop (there are no tests)

1. `node ./node_modules/typescript/bin/tsc --noEmit` — the only automated gate.
2. `npm run build-all` (or `node scripts/build-all.mjs`) — supports `--check-only`. **Read the last
   line**: `RESULT: OK` / `INCOMPLETE` / `FAILED`. A failed `vite` step leaves the *previous* release
   in place, so the artifacts in the report can look fine while the build failed.
3. Launch `release\VoxelEngineNWWeb\launcher.exe` and walk the flythrough in `AGENTS.md` §Testing.
4. **For pure logic, write a throwaway assertion script** — this works well and is how the voxel
   layer is currently verified:
   ```powershell
   node .\node_modules\typescript\bin\tsc src\voxel\chunk.ts src\voxel\world.ts src\voxel\raycast.ts `
     --ignoreConfig --outDir .tmp --module commonjs --target es2022 --skipLibCheck `
     --types node --lib es2022,dom,dom.iterable
   # then a .cjs file that requires the output and asserts; delete .tmp afterwards
   ```
   `--ignoreConfig` is required (TypeScript 7 errors without it when files are named on the command
   line), and `src/voxel/*` deliberately has **no three.js and no ECS imports**, which is what makes
   this possible. `src/rendering/chunkmesh.ts` can be tested the same way because Node resolves the
   real `three`.
5. Reminder: `rearrange.mjs` **clears** `game\mods` and `game\resourcepacks` on every build. Re-copy
   `packs\*` before testing anything that involves blocks, language or the menu background.
