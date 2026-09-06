# AGENTS.md — guide for AI assistants (and humans who want the fast tour)

Read this before changing anything. It maps the architecture, the invariants that keep it
correct, and where new code goes. The user-facing README (Chinese) covers build/run and the
mod/resource-pack format; this file covers how the CODE is organized and which lines are
load-bearing.

## What this is

VoxelEngineNWWeb — a Minecraft-style first-person sandbox on NW.js (Chromium + Node in one
process) with a three.js WebGPU renderer, packaged as a portable Windows directory.

**Current world state: there is NO terrain.** The planet/LOD/voxel-world systems were removed.
Entering a game shows an empty sky: walking falls forever (no ground), creative flight
(double-tap Space) works, Shift sprints at a test-only ×25. Blocks exist only in the inventory
UI (registry + 3D icons). A terrain rebuild is planned — never assume world geometry exists.

## Directory map — what goes where

```
src/
├── main.ts                 composition root ONLY: construct systems, register them into the
│                           World, wire UI callbacks. No per-frame logic lives here.
├── blockregistry.ts        block data registry (merges blocks.json across packs)
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
│       │                   CONTROL keys + accumulates view deltas. RACE-SENSITIVE (rule 3).
│       ├── controller.ts   consumes view deltas → applies yaw/pitch semantics
│       └── movement.ts     mode-dependent locomotion over every entity matching
│                          CONTROL+POSITION+ORIENTATION+MOTION (query-driven)
├── rendering/              anything drawn: camera-view.ts (interpolation + quaternion),
│                           textures.ts (pack chain resolution), blockicons.ts (icon baking)
├── platform/               host/browser services, produce data only: shell.ts (NW.js:
│                           settings/logs/window), keybinds.ts, rawinput.ts, pointerlock.ts,
│                           debuglog.ts, perf.ts
└── ui/                     DOM interfaces (self-managing, deliberately NOT in the World
                            loop): mainmenu, menu/pause+settings+keybinds, hud, inventory,
                            i18n (zh/en/ja), uiscale, fonts, background, gamemode
packs/                      official example mod + resource pack (copy into game/)
launcher/, rawinput/        native sources (C launchers, Rust input plugin)
scripts/                    build chain: get-nw.mjs → tsc && vite build → rearrange.mjs
app/                        NW.js manifest source (rearrange.mjs copies it to game/core/)
```

Placement rule of thumb: touches the OS/browser/NW.js → `platform/`; touches three.js/pixels →
`rendering/`; mutates entity data per tick → `ecs/systems/`; entity state itself →
`ecs/components/`; visible DOM → `ui/`.

## The two clocks (how the loop runs)

```
rAF frame:
  accumulator += delta
  while (acc >= 1/120) world.stepFixed(1/120)   // fixed tps, MC-style
      1. cameraView.beginStep()                  // freeze the render-interpolation source
      2. controller.step()                       // consume input deltas, apply view semantics
      3. movement.step()                         // query-driven locomotion
  world.render(alpha, delta)                     // alpha = remainder of the physics tick
      1. cameraView.render(alpha)                // position lerp + orientation quaternion
      2. diagnostics                             // perf/PHYS log/F3 (main.ts)
      3. renderer.render(scene, camera)
```

**Registration order in main.ts is load-bearing.** `beginStep` must run before `controller`
(freeze the interpolation source before physics moves the player), and the render lane draws
only after the view is synced. When adding systems, preserve these relative orders.

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
enter the game → walk falls (no ground) → double-tap Space to fly → Shift ×25 sprint →
pitch past the zenith wraps (fly/spectator) → ESC menus, E inventory, F3 panel all work.
If you add pure logic (like EntityStore), compile the single file standalone and assert
behavior in a throwaway node script.

## Known gaps (do not "fix" without asking)

- No terrain/collision: `groundTop()` is NaN, walking falls forever, jump is unreachable.
- `ui/menu.ts` was rewritten around an explicit binding-interaction state machine (click
  shield + capture-free drag + physical capture, all documented at the top of the file).
  Still the densest file — the two shield-arm paths and the Esc-during-drag branch are
  load-bearing click-synthesis handling. Do not merge the arm paths.
- Multiplayer is a placeholder button.
