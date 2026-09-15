# AGENTS.md — guide for AI assistants (and humans who want the fast tour)

Read this before changing anything. It maps the architecture, the invariants that keep it
correct, and where new code goes. The user-facing README (Chinese) covers build/run and the
mod/resource-pack format; this file covers how the CODE is organized and which lines are
load-bearing.

**This file describes only what EXISTS.** Everything planned, unfinished or deliberately skipped
is in `ROADMAP.md` — read that too before proposing work. The two never overlap: if they ever
disagree about what is shipped, this file is right and `ROADMAP.md` is stale.

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
├── main.ts                 composition root: construct systems, register them into the
│                           World, wire UI callbacks. It ALSO owns the rAF loop itself
│                           (fixed-step accumulator + FPS-cap gate, `renderFrame`), the
│                           per-frame `diagnostics` render system, and the main-menu
│                           panorama loop.
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
│   ├── World.ts            parent scheduler: addFixed (120 Hz physics ticks) / addRender
│   │                       (once per rAF). Registration order IS execution order.
│   │                       Owns `entities` (EntityStore).
│   ├── store.ts            EntityStore: bare-id entities, lifecycle, typed component
│   │                       storage, queries. The pure-ECS half.
│   ├── components/         component DEFINITIONS (pure data + spawn helpers). Player.ts
│   │                       defines POSITION/ORIENTATION/MOTION/CONTROL + spawnPlayer().
│   └── systems/            all behavior, query-driven:
│       ├── input.ts        pointer-lock state machine + mouse/key/bind capture → writes
│       │                   CONTROL keys + accumulates view deltas. RACE-SENSITIVE (rule 2).
│       ├── controller.ts   consumes view deltas → yaw + pitch clamp (pitch is clamped to
│       │                   ±89.4° in EVERY mode; there is no wrap past the zenith)
│       ├── movement.ts     mode-dependent locomotion over every entity matching
│       │                   CONTROL+POSITION+ORIENTATION+MOTION (query-driven). Integrates the
│       │                   tick PROVISIONALLY — collision re-integrates and resolves it.
│       ├── collision.ts    AABB vs the voxel grid, one axis at a time, sub-stepped. Runs AFTER
│       │                   movement in the fixed lane. Owns motion.onGround and zeroes
│       │                   motion.vy on contact; skips spectator (noclip).
│       ├── interaction.ts  break (left) / place (right) through a voxel raycast + the target
│       │                   outline. Polls CONTROL.keys with a dt cooldown (no event listeners),
│       │                   refuses placement overlapping the player body box, and never acts
│       │                   while input.canControl is false (so UI clicks cannot edit blocks).
│       └── chunkstream.ts  render lane: keeps the chunks around the player generated, meshed
│                           and placed at their nearest torus representation (budgeted), and
│                           drains VoxelWorld.takeDirty() so block edits re-mesh immediately
├── rendering/              anything drawn: camera-view.ts (interpolation + quaternion),
│                           textures.ts (pack chain resolution), blockicons.ts (icon baking),
│                           chunkmesh.ts (face-culled chunk geometry + the checker material)
├── platform/               host/browser services, produce data only: shell.ts (NW.js:
│                           settings/logs/window), keybinds.ts, rawinput.ts, pointerlock.ts,
│                           debuglog.ts, perf.ts
└── ui/                     DOM interfaces (self-managing, deliberately NOT in the World
                            loop): mainmenu, menu/pause+settings+keybinds, hud, inventory,
                            i18n (zh/en/ja), uiscale, fonts, background, gamemode
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

## The two clocks (how the loop runs)

```
rAF frame:
  accumulator += delta
  while (acc >= 1/120 && steps < 12) world.stepFixed(1/120)  // fixed tps, MC-style
                                                             // (steps<12 = spiral-of-death clamp)
      1. cameraView.beginStep()                  // freeze the render-interpolation source
      2. controller.step()                       // consume input deltas, apply yaw + pitch clamp
      3. movement.step()                         // query-driven locomotion (PROVISIONAL)
      4. collision.step()                        // resolve the tick against the voxel world
      5. interaction.step()                      // break / place (polled, rate-limited)
  FPS-cap gate: when fpsCap > 0 and the frame budget is not yet met, RETURN here
                (physics above already advanced; only drawing/stats are gated)
  world.render(alpha, delta)                     // alpha = remainder of the physics tick
      1. cameraView.render(alpha)                // position lerp + orientation quaternion
      2. chunkStream.step()                      // generate / mesh / place chunks (budgeted)
      3. diagnostics                             // perf/PHYS log/F3 (main.ts)
      4. renderer.render(scene, camera)
```

**Registration order in main.ts is load-bearing.** `beginStep` must run before `controller`
(freeze the interpolation source before physics moves the player), `collision` must run AFTER
`movement` (it re-integrates and resolves the displacement movement just wrote), `interaction`
sits last in the fixed lane (so its raycast starts from the settled pose), and the render lane
draws only after the view is synced. When adding systems, preserve these relative orders.

## Iron rules (breaking any of these = silent bugs)

1. **Component records are created once at spawn and mutated in place.** Systems cache the
   record references in their constructors and only write fields. `EntityStore.add` throws on
   duplicates and on dead ids — that is enforcement, not a suggestion. Never "replace" a
   component record; every cached reader would silently desync.
2. **The pointer-lock/input race code in ecs/systems/input.ts is timing-sensitive**
   (skipFirstMove, lockGraceUntil, raw-input takeover arbitration, spike guards). It encodes
   real Chromium/Windows races. Do not simplify or reorder without replaying them.
3. **All game state changes happen on the single JS main thread** in a deterministic order.
   The only other threads are the rawinput native plugin's collector thread (atomic
   accumulator, polled every 8 ms) and the GPU. Keep it that way.
4. **Comments that say "do not simplify" document fixed bugs.** They are load-bearing.
5. **Field initializers cannot read parameter properties.** Native class fields initialize
   before constructor-body parameter-property assignments — resolve component records in the
   constructor BODY (see the pattern in every system).

## ECS conventions

- Entities are bare numeric ids; components are plain data records (no methods).
- Systems never import each other. They read/write shared component data and are registered
  into the World (explicitly, in main.ts — no auto-discovery; order matters).
- Resolve component records once per system lifetime, mutate in place per tick.
- Query-driven: `world.entities.query(CONTROL, POSITION, ...)` returns a snapshot array —
  safe to despawn during iteration; any entity carrying those components is processed
  automatically (that is how a future NPC joins for free).
- Flat files until a module needs a second file; then a folder + a `create()` factory, and
  registration stays explicit.
- `ui/` is deliberately outside the World loop: DOM is event-driven and pauses the game.

## Testing

There is no test runner. `tsc` (strict) plus a manual flythrough is the verification loop:
enter the game → you land on the flat voxel surface at WORLD_SURFACE_Y and can walk and jump
(if you fall forever instead, the chunk window was not generated — check `chunkStream.prime`)
→ chunk meshes stream in over the first couple of seconds → fly (double-tap Space) down into
the ground and confirm you STOP rather than pass through → Shift ×25 sprint → look past the
zenith: pitch CLAMPS at ±89.4° in EVERY mode (no wrap) → F3 shows a real `top` and the loaded
chunk count → aim at a block: the white outline follows the crosshair → LEFT-click breaks it and
the hole appears the same frame → RIGHT-click puts it back → dig a 1x1 shaft down and jump out
of it → build a pillar UP from the surface (this is the one thing that used to be impossible: the
writable range ended exactly where the ground started) → hold a mouse button and open a menu: no
block may change (interaction is gated on `input.canControl`) → ESC menus, E inventory, F3 panel
all work.
If you add pure logic (like EntityStore or VoxelWorld's wrapping), compile the single file
standalone and assert behavior in a throwaway node script.

## Pending work

Not here. The planet/terrain roadmap, the gaps inside the systems that DO exist, the
deliberately-deferred decisions, and the LLM-facing debt backlog all live in **ROADMAP.md**. Keep
the split: this file is facts about shipped behaviour, that one is intent. When work lands, move
the entry here and delete it there.

## Known gaps (do not "fix" without asking)

- The voxel world has NO content: `generateChunk()` (voxel/world.ts) fills every chunk with a
  single block — no heightmap, biomes or ores. Breaking and placing DO work, but there is only
  ONE block type: placement always writes SOLID and the inventory is consulted only to require a
  non-empty hand. The mesher draws the built-in checker texture (CHECKER_TEXTURE_URL) instead of
  consulting blockregistry.ts, so mod blocks appear in the inventory but not in the world.
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
  display-only and deliberately untouched (rule 2 territory); the real surface height is
  `VoxelWorld.topSolidY()`, used by main.ts diagnostics and the F3 panel.
- The torus is drawn by placing each chunk at its nearest representation, which is perfectly
  seamless while the world is uniform. Real terrain will need ghost meshes near the seam (or a
  much larger WORLD_CHUNKS period), otherwise the wrap will visibly snap.
- Inert remnants of the removed engine — dead code and stale comments, NOT bugs; do not
  "restore" or "fix" them: the main menu's world-type panel (`mainmenu.ts` gen panel plus the
  i18n keys main.genTitle/genSuperflat/genNoise; main.ts's `onStartSingle` logs `mode` and then
  discards it), the always-hidden loading overlay (main.ts), and comments mentioning BlockWorld
  or the REMOVED chunk system (the new chunk system in voxel/ is unrelated).
- `ui/menu.ts` was rewritten around an explicit binding-interaction state machine (click
  shield + capture-free drag + physical capture, all documented at the top of the file).
  Still the densest file — the two shield-arm paths and the Esc-during-drag branch are
  load-bearing click-synthesis handling. Do not merge the arm paths.
- Multiplayer is a placeholder button.
