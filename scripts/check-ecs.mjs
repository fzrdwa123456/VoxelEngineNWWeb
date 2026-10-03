// ===== ECS invariant check: compile the ECS half and assert what it promises =====
// `AGENTS.md` makes claims that a type-checker cannot verify and that no human can re-derive by
// reading: entity handles detect stale ids, a query's cache is invalidated by structural changes,
// one process supports one World, an undeclared data dependency throws, the schedule's batches are
// what the docs say, and the members of a batch really do commute. Those claims are exactly the ones
// that break silently during a refactor, so they get a command.
//
// Everything is compiled with the SAME `tsc` the build uses, into `node_modules/.cache/` —which is
// git-ignored, so nothing in the tracked tree is written, AND Node can still resolve `three/webgpu`
// from there (it looks up the directory chain and finds the real `node_modules`). Neither the ECS
// nor the systems' fixed lane import three.js or touch the DOM, which is what makes the replay
// possible; the VOXEL resource is only ever used through `isSolid()`, so a real `VoxelWorld` serves
// as one.
//
// Usage:  node scripts/check-ecs.mjs        (or: npm run check:ecs)
// Exit:   0 = every assertion passed, 1 = something failed (each failure names itself).
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { ROOT, TSC_BIN } from "./paths.mjs";

const NODE = process.execPath;
const OUT = path.join(ROOT, "node_modules", ".cache", "voxelengine-ecs-check");
/** A pack file's bytes in the snapshot's own shape. Since P1.18f that shape is BYTES, not base64: the
 *  transport is one binary body and a file's value is a VIEW into it (see `decodePackSnapshot`). */
const packBytes = (text) => new Uint8Array(Buffer.from(text, "utf8"));

/** Sources to compile. tsc follows their imports, so this list is "the ECS plus the fixed lane". */
const SOURCES = [
  "src/core/world.ts",
  "src/plugins/player/components.ts",
  // The PLAYER's commands (P1.18b): they read/write this plugin's own components, so they live next to
  // them and no `core/` file imports `plugins/` at all.
  "src/plugins/player/commands.ts",
  // The entity-free commands (P1.18d): they write data VALUES, so they live in `data/` next to the resources
  // they read — the kernel keeps only the mechanism (`core/effect/command-queue.ts`).
  "src/data/globals/commands.ts",
  // The boot / world-entry FLOW: the stage list is data and `runBootFlow` is the only logic (its deps are
  // injected, so it needs no DOM and no World).
  "src/core/flow/boot.ts",
  // ===== The plugin system (P1.18): extension points, the registry, the install lifecycle, the manifest
  // and the six plugin declarations. All of them are import-safe (no DOM, no Tauri), which is what lets
  // this gate drive them directly.
  "src/core/extension/point.ts",
  "src/core/extension/slots.ts",
  "src/core/extension/registry.ts",
  "src/core/plugin/descriptor.ts",
  "src/core/plugin/api.ts",
  "src/core/plugin/lifecycle.ts",
  "src/core/plugin/errors.ts",
  "src/boot/manifest.ts",
  "src/boot/manifest-types.ts",
  // The UI tables' IMPLEMENTATION (P1.18d): the kernel declares `UiTablesHook` and the root supplies it, so
  // this is the module that really writes `UI_ACTIONS`/`UI_SOURCES` — the gate drives it directly.
  "src/boot/ui-tables.ts",
  "src/plugins/world/index.ts",
  "src/plugins/player/index.ts",
  "src/plugins/render/index.ts",
  "src/plugins/diagnostics/index.ts",
  "src/plugins/ui/index.ts",
  "src/plugins/ui-debug/index.ts",
  "src/plugins/ui-keybind/index.ts",
  "src/plugins/ui-inventory/index.ts",
  "src/plugins/ui-toast/index.ts",
  "src/plugins/input/index.ts",
  "src/plugins/content-default/index.ts",
  "src/data/globals/resources.ts",
  // The bind DATA (action ids, defaults, panel rows, keycap display names) and the cube's face table: the
  // modules that act on them are in logic/ (keybinds.ts, chunkmesh.ts).
  "src/data/globals/binds.ts",
  "src/data/globals/keylayout.ts",
  "src/data/globals/faces.ts",
  // The diagnostic-probe prefix table (the switch and its filter stay in host/desktop/shell.ts).
  "src/data/globals/probes.ts",
  // The configuration change bus: the notification half of a config value is behaviour (logic/host), the
  // value itself is data.
  "src/core/services/bus.ts",
  "src/plugins/player/systems/snapshot.ts",
  "src/plugins/player/systems/controller.ts",
  "src/plugins/player/systems/movement.ts",
  "src/plugins/player/systems/collision.ts",
  "src/plugins/player/systems/interaction.ts",
  // The input system: import-safe in Node (its only host dependency, platform/keybinds.ts, has no
  // imports at all, and the DOM is touched from the constructor's listeners, never at import time).
  "src/plugins/player/systems/input.ts",
  "src/plugins/render/systems/chunk-stream.ts",
  "src/plugins/render/systems/diagnostics.ts",
  // The delayed intents (relock / lock retry / cursor re-assert): the ui-lane system that applies
  // whatever wall-clock deadline has passed. It owns no timer and touches no DOM itself.
  "src/plugins/ui/systems/delays.ts",
  // The widget layer: pure data + one pure style function + the action table + the reconciler. None of
  // them touches the DOM at import time, which is what lets this gate load them.
  "src/data/assets/theme.ts",
  // The menu background's KIND + SIGNATURE (P1.18g): driven below against synthetic chains, so the file the
  // pack reload asks "did the backdrop change?" is the real one.
  "src/data/assets/background.ts",
  "src/plugins/ui/components.ts",
  "src/data/globals/actions.ts",
  // The presentation TOKENS + state shapes are pure data (gfx.ts); the factories that build those objects
  // are the boundary's (host/browser/presentation.ts). A check that needs either loads both.
  "src/data/globals/gfx.ts",
  "src/host/browser/presentation.ts",
  // The boot flow's DATA (the walker lives in core/flow/boot.ts).
  "src/data/globals/boot.ts",
  "src/plugins/ui/systems/bindings.ts",
  "src/plugins/ui/systems/reconcile.ts",
  // The three UI systems that own state the views used to keep privately: the F3+F4 picker (key edges
  // -> PICKER_STATE -> a SetMode command), the HUD toast (a wall-clock deadline in a resource), and the
  // key bind panels + drag gesture (KEYBIND_GESTURE as data, the panels derived every frame).
  "src/plugins/ui-debug/systems/picker.ts",
  "src/plugins/ui-toast/systems/toast.ts",
  "src/plugins/ui/systems/loading.ts",
  "src/plugins/ui/systems/hud.ts",
  // The inventory reconcile (a system now �?it used to be `Inventory.sync()`, a method on the view, which
  // is why this file was not compiled here before). It imports the icon baker + the block registry, both
  // of which are import-safe in Node (the WebGPU renderer they use is created lazily on the first bake).
  "src/plugins/ui-inventory/systems/inventory.ts",
  "src/plugins/ui-keybind/systems/keybind.ts",
  "src/plugins/ui/systems/navigation.ts",
  "src/plugins/render/systems/camera.ts",
  // The block target outline: a render-lane system that reads the TARGET_HIT component and moves a
  // three.js mesh. Import-safe in Node �?it imports three.js for TYPES only and the mesh arrives as the
  // BLOCK_OUTLINE resource, which the check inserts as a stub.
  "src/plugins/render/systems/outline.ts",
  // Import-safe in Node: the settings repair is a PURE comparison and lives in its own
  // dependency-free module (the Tauri shell it belongs to imports @tauri-apps/api, which Node's
  // CJS require cannot load) �?which is exactly what the boot check asserts here.
  "src/core/services/settings-diff.ts",
  // Import-safe in Node: no DOM at import time, and the WebGPU renderer is created lazily on the first
  // bake —so the icon cache's synchronous reader can be asserted here.
  "src/host/browser/blockicons.ts",
  "src/data/world/world.ts",
];

let passed = 0;
let failed = false;
const ok = (name) => {
  console.log(`  [ok]    ${name}`);
  passed++;
};
const fail = (name, err) => {
  console.log(`  [FAIL]  ${name}: ${err instanceof Error ? err.message : String(err)}`);
  failed = true;
};
function check(name, fn) {
  try {
    fn();
    ok(name);
  } catch (err) {
    fail(name, err);
  }
}
const assert = (condition, message) => {
  if (!condition) throw new Error(message ?? "assertion failed");
};
const equal = (actual, expected, message) => {
  if (actual !== expected) throw new Error(`${message ?? "value"}: expected ${expected}, got ${actual}`);
};
/** SOA columns are Float32Array, so a float64 literal reads back quantized. The collision SKIN is
 *  1e-3, four orders larger, so the quantization cannot change behaviour. */
const close = (actual, expected, message) => {
  if (!(Math.abs(actual - expected) < 1e-6)) {
    throw new Error(`${message ?? "value"}: expected ~${expected}, got ${actual}`);
  }
};
/** For quantities collision deliberately offsets (it leaves a body SKIN clear of the surface) */
const near = (actual, expected, eps, message) => {
  if (!(Math.abs(actual - expected) < eps)) {
    throw new Error(`${message ?? "value"}: expected ~${expected} (+/-${eps}), got ${actual}`);
  }
};
/** Every material a fake `dispose()` was called on — which is how "the fade freed its copies" is observable. */
const fakeDisposed = [];
/** The chunk material a TEST factory hands out. It has to behave like a three.js material for the paths that
 *  touch one: the debug views set `wireframe` (+`needsUpdate`) and the appearance fade (P1.98) needs a real
 *  `clone()`/`dispose()` pair, because a per-chunk opacity cannot be shared. */
const fakeChunkMaterial = (extra = {}) => {
  const material = {
    // The DEFAULTS come first and the caller's overrides after them: three.js's own `clone()` copies the
    // flags in force, so a fake that flattened a passed `wireframe: true` back to false would make the fade's
    // copy look un-debugged and fail the H assertion against CORRECT engine code (measured).
    wireframe: false,
    transparent: false,
    opacity: 1,
    needsUpdate: false,
    // `shared` marks a material the CACHE handed out. It is what tells a chunk's own fade COPY (a clone, a
    // material of its own) from the shared one the world is drawn with — and a real clone is NOT the cache's
    // instance, so the copy clears it.
    shared: false,
    ...extra,
    // A real clone COPIES the flags in force, which is what lets a fade copy inherit a tint/wireframe.
    clone: () =>
      fakeChunkMaterial({
        ...extra,
        wireframe: material.wireframe,
        transparent: material.transparent,
        opacity: material.opacity,
        shared: false,
      }),
    dispose() {
      fakeDisposed.push(material);
    },
  };
  return material;
};

// ===== compile =====
console.log("=== check-ecs: compile the ECS half -> " + OUT + " ===");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
writeFileSync(path.join(OUT, "package.json"), '{ "type": "commonjs" }\n');
try {
  execFileSync(
    NODE,
    [
      TSC_BIN,
      ...SOURCES,
      "--ignoreConfig",
      "--outDir",
      OUT,
      "--rootDir",
      "src",
      "--module",
      "commonjs",
      "--target",
      "es2022",
      "--strict",
      "--skipLibCheck",
      "--types",
      "node",
      "--lib",
      "es2022,dom,dom.iterable",
    ],
    { cwd: ROOT, stdio: "pipe" },
  );
  ok("tsc compiled the ECS half");
} catch (err) {
  const output = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim();
  fail("tsc", new Error(output || "compilation failed"));
  console.log("\nRESULT: FAILED");
  process.exit(1);
}

const require = createRequire(import.meta.url);
const load = (rel) => require(path.join(OUT, rel));
/** The presentation TOKENS + state shapes live in data/globals/gfx.ts (pure data) and the factories that
 *  build those objects in host/browser/presentation.ts (the boundary); a check that needs either wants both. */
const loadPresentation = () => ({
  ...load("data/globals/gfx.js"),
  ...load("host/browser/presentation.js"),
});
const { World } = load("core/world.js");
const { Schedule } = load("core/flow/schedule.js");
const { entityIndex } = load("core/data/entity.js");
const C = load("plugins/player/components.js");
const { defineComponent, defineRecord } = load("core/data/component.js");
const { defineResource } = load("core/data/resource.js");
const { defineCommand } = load("core/effect/command-queue.js");
const {
  canControl,
  createLoadingState,
  createInputState,
  createKeyEventLog,
  createPickerState,
  createToastState,
  createUiModalState,
  // …and the per-ring appearance fades (P2.01), which every stream a test builds has to insert.
  createFadeOptions,
  FADE_OPTIONS,
  LOADING_STATE,
  INPUT_STATE,
  isMenuUi,
  isModalUi,
  KEY_EVENTS,
  LOCAL_PLAYER,
  PICKER_STATE,
  publishKeyEdge,
  TOAST,
  UI_MODAL,
  VOXEL,
} = load("data/globals/resources.js");
const { SetFadeOption, SetLoadingStage, ShowToast } = load("data/globals/commands.js");
// The four PLAYER commands moved to the plugin that owns the components they write (P1.18b): `core/` no
// longer imports `plugins/`, and the gate loads each from the module that declares it.
const { SelectSlot, SetMode, SwapSlots, Teleport } = load("plugins/player/commands.js");
const { TERRAIN_TOP_Y, VoxelWorld, WORLD_MAX_Y } = load("data/world/world.js");
// The torus period is the WORLD SIZE in force now (P2.02 — `data/world/size.ts`), not a constant: everything that
// used to read `WORLD_CHUNKS_X` asks these instead.
const {
  worldChunksX,
  worldChunksZ,
  worldPeriodBlocks,
  setWorldChunks,
  sanitizeWorldChunks,
  WORLD_CHUNKS_MIN,
  WORLD_CHUNKS_MAX,
  WORLD_CHUNKS_STEP,
  WORLD_SIZE_PRESETS,
} = load("data/world/size.js");

// ===== 1. core: handles, storage, queries =====
console.log("\n--- entities, component storage and queries ---");

check("a stale handle is detectable, and the slot is recycled with a new generation", () => {
  const world = new World();
  const A = defineComponent("check-a", { x: "f32" });
  const a = world.spawn();
  const b = world.spawn();
  equal(world.store.entities.isAlive(a), true, "alive");
  equal(world.despawn(a), true, "despawn");
  equal(world.store.entities.isAlive(a), false, "stale handle must not report alive");
  equal(world.despawn(a), false, "double despawn is a no-op");
  const c = world.spawn();
  equal(entityIndex(c), entityIndex(a), "the slot is reused");
  equal(world.store.entities.isAlive(a), false, "the old handle stays dead after recycling");
  equal(world.store.entities.isAlive(b), true, "the other entity is untouched");
  void A;
});

check("SOA values survive column growth, and a recycled row starts zeroed", () => {
  const world = new World();
  const P = defineComponent("check-p", { x: "f32", y: "f32" });
  const first = world.spawn();
  world.insert(first, P, { x: 7, y: -2 });
  equal(P.x[entityIndex(first)], 7, "written value");
  world.despawn(first);
  const again = world.spawn();
  world.insert(again, P);
  equal(P.x[entityIndex(again)], 0, "a recycled row must not inherit the previous occupant");
  const ids = [again];
  for (let i = 0; i < 3000; i++) {
    const e = world.spawn();
    world.insert(e, P, { x: i });
    ids.push(e);
  }
  equal(P.x[entityIndex(ids[0])], 0, "the first row survived the reallocation");
  equal(P.x[entityIndex(ids[3000])], 2999, "the last row is correct after doubling");
  equal(world.query(P).length, 3001, "every carrier is found");
});

check("RECORD components keep their identity; a dead occupant's record does not resurface", () => {
  const world = new World();
  const R = defineRecord("check-r", () => ({ vy: 0 }));
  const a = world.spawn();
  world.insert(a, R);
  const record = world.get(a, R);
  record.vy = 5;
  equal(world.get(a, R), record, "the record identity is stable");
  world.despawn(a);
  const b = world.spawn();
  equal(entityIndex(b), entityIndex(a), "same slot");
  equal(world.has(b, R), false, "the component is detached");
  equal(world.get(b, R), undefined, "the old record must not resurface");
  world.insert(b, R);
  assert(world.get(b, R) !== record, "a fresh record is created");
});

check("a query caches its result and refreshes on structural change", () => {
  const world = new World();
  const A = defineComponent("check-qa", { v: "f32" });
  const B = defineComponent("check-qb", { v: "f32" });
  const e1 = world.spawn();
  const e2 = world.spawn();
  world.insert(e1, A);
  world.insert(e1, B);
  world.insert(e2, A);
  const query = world.query(A, B);
  equal(world.query(A, B), query, "the query is cached per component set");
  equal(query.length, 1, "one match");
  world.insert(e2, B);
  equal(query.length, 2, "structural change invalidates the cache");
  world.despawn(e2);
  equal(query.length, 1, "despawn invalidates it again");
  equal(world.query(A).length, 1, "removing B did not touch A");
});

check("one process supports one World (component storage is per definition)", () => {
  // A probe component, not a real one: claiming a real component here would make it unusable for
  // the Worlds below, which is exactly the constraint being tested.
  const Probe = defineComponent("check-probe", { v: "f32" });
  const first = new World();
  first.insert(first.spawn(), Probe, { v: 1 });
  const second = new World();
  const entity = second.spawn();
  let threw = false;
  try {
    second.insert(entity, Probe, { v: 2 });
  } catch (err) {
    threw = /already bound to another World/.test(String(err));
  }
  assert(threw, "a second World must be refused, not silently share rows");
});

check("commands are deferred to a barrier; resources are typed and guarded", () => {
  const world = new World();
  const log = [];
  const Cmd = defineCommand("check-log", (_w, payload) => log.push(payload));
  const TIME = defineResource("check-time");
  world.insertResource(TIME, { dt: 1 });
  equal(world.resource(TIME).dt, 1, "resource read");
  let threw = false;
  try {
    world.insertResource(TIME, { dt: 2 });
  } catch {
    threw = true;
  }
  assert(threw, "a duplicate resource insert throws");
  world.addSystem({ name: "noop", stage: "fixed", run: () => {} });
  world.start();
  world.commands.send(Cmd, "a");
  equal(log.length, 0, "nothing runs before a barrier");
  world.stepFixed(1 / 120);
  equal(log.join(""), "a", "the barrier applied it");
});

// ===== 2. the player entity: components and commands =====
console.log("\n--- the player entity: components, spawn helpers, commands ---");

// ONE World for everything below: component storage is owned per definition, so a second World that
// touches the player's components would be refused —which is the constraint asserted a moment ago.
const world = new World();
const rawVoxel = new VoxelWorld();
let solidCalls = 0;
world.insertResource(VOXEL, {
  isSolid: (x, y, z) => {
    solidCalls++;
    return rawVoxel.isSolid(x, y, z);
  },
});
world.insertResource(INPUT_STATE, createInputState());
world.insertResource(UI_MODAL, createUiModalState());
// The three resources the UI systems own: key edges (published by the device layer), the F3+F4 picker's
// state, and the toast with its wall-clock deadline.
world.insertResource(KEY_EVENTS, createKeyEventLog());
world.insertResource(PICKER_STATE, createPickerState());
world.insertResource(TOAST, createToastState());
const localPlayer = C.spawnPlayer(world, { x: 1, y: 2, z: 3 }, ["stone", "dirt"]);
world.insertResource(LOCAL_PLAYER, localPlayer);

// The fixed lane the physics checks replay: snapshot -> test gravity -> collision. Access is
// declared on the TEST system too, because an undeclared system is invisible to the conflict rule.
const { PositionSnapshotSystem, SNAPSHOT_ACCESS } = load("plugins/player/systems/snapshot.js");
const { CollisionSystem, COLLISION_ACCESS } = load("plugins/player/systems/collision.js");
const snapshot = new PositionSnapshotSystem(world);
const collision = new CollisionSystem(world);
const falling = [];
world.addSystem({
  name: "motion.snapshot",
  stage: "fixed",
  ...SNAPSHOT_ACCESS,
  run: () => snapshot.step(),
});
world.addSystem({
  name: "check.gravity",
  stage: "fixed",
  after: ["motion.snapshot"],
  reads: [C.MOTION],
  writes: [C.POSITION],
  run: () => {
    for (const entity of falling) {
      const index = entityIndex(entity);
      const motion = world.get(entity, C.MOTION);
      motion.vy -= 24 / 120;
      C.POSITION.y[index] += motion.vy / 120;
    }
  },
});
world.addSystem({
  name: "player.collision",
  stage: "fixed",
  after: ["check.gravity"],
  ...COLLISION_ACCESS,
  run: () => collision.step(),
});
world.start();
// Terrain must exist: reads do not generate, so a missing column is a fall-through.
for (let cx = 0; cx <= 2; cx++) {
  for (let cz = 0; cz <= 2; cz++) {
    for (let cy = 0; cy < 8; cy++) rawVoxel.ensureChunk(cx, cy, cz);
  }
}

let nextX = 100;
const newPlayer = (items = []) => C.spawnPlayer(world, { x: nextX++, y: 2, z: 3 }, items);

check("spawnPlayer attaches the full component set with the documented defaults", () => {
  const player = newPlayer();
  const index = entityIndex(player);
  for (const component of [
    C.POSITION,
    C.PREV_POSITION,
    C.ORIENTATION,
    C.VIEW,
    C.MOTION,
    C.CONTROL,
    C.BODY,
    C.REACH,
    C.INTERACTION,
    C.INVENTORY,
    C.PLAYER,
    C.TARGET_HIT,
  ]) {
    equal(world.has(player, component), true, `has ${component.name}`);
  }
  equal(C.POSITION.y[index], 2, "position");
  equal(C.PREV_POSITION.z[index], 3, "the sweep origin starts where the body is");
  close(C.BODY.halfWidth[index], C.HUMANOID_BODY.halfWidth, "halfWidth");
  close(C.BODY.eyeHeight[index], C.HUMANOID_BODY.eyeHeight, "eyeHeight");
  equal(C.REACH.distance[index], C.DEFAULT_REACH, "reach");
  equal(C.ORIENTATION.fwdZ[index], -1, "initial heading");
  equal(C.PLAYER.fieldNames.length, 0, "the marker carries no data");
  equal(C.TARGET_HIT.active[index], 0, "nothing is targeted before the first raycast");
});

check("starting items fill the hotbar and nothing else", () => {
  const player = newPlayer(["a", "b", "c"]);
  const inventory = world.get(player, C.INVENTORY);
  equal(inventory.slots.length, C.INVENTORY_SLOTS, "slot count");
  equal(inventory.selected, 0, "selection");
  equal(inventory.slots[0].type, "a", "first slot");
  equal(inventory.slots[3], null, "past the items");
  equal(inventory.slots[C.HOTBAR_SLOTS], null, "the backpack stays empty");
});

check("SelectSlot / SwapSlots are deferred to a barrier and clamped", () => {
  const player = newPlayer(["a", "b"]);
  const inventory = world.get(player, C.INVENTORY);
  world.commands.send(SelectSlot, { entity: player, slot: 4 });
  world.commands.send(SwapSlots, { entity: player, a: 0, b: 30 });
  equal(inventory.selected, 0, "nothing before the barrier");
  world.stepFixed(1 / 120);
  equal(inventory.selected, 4, "selection applied");
  equal(inventory.slots[30].type, "a", "swap applied");
  for (const [name, payload] of [
    ["over", { entity: player, slot: 999 }],
    ["negative", { entity: player, slot: -1 }],
    ["fractional", { entity: player, slot: 1.5 }],
  ]) {
    world.commands.send(SelectSlot, payload);
    world.stepFixed(1 / 120);
    equal(inventory.selected, 4, `a ${name} selection is ignored`);
  }
});

check("Teleport moves POSITION and PREV_POSITION together and clears the view deltas", () => {
  const player = newPlayer();
  const index = entityIndex(player);
  C.VIEW.yawDelta[index] = 5;
  C.POSITION.x[index] = 99;
  world.commands.send(Teleport, { entity: player, x: 7, y: 8, z: 9 });
  world.stepFixed(1 / 120);
  equal(C.POSITION.x[index], 7, "position");
  equal(C.PREV_POSITION.x[index], 7, "sweep origin, or the next sweep starts elsewhere");
  equal(C.VIEW.yawDelta[index], 0, "buffered view deltas");
});

check("SetMode resets flying and the vertical state", () => {
  const player = newPlayer();
  const control = world.get(player, C.CONTROL);
  const motion = world.get(player, C.MOTION);
  control.flying = true;
  motion.vy = 7.5;
  motion.onGround = true;
  world.commands.send(SetMode, { entity: player, mode: "fly" });
  world.stepFixed(1 / 120);
  equal(control.mode, "fly", "mode");
  equal(control.flying, false, "flying");
  equal(motion.vy, 0, "vy");
  equal(motion.onGround, false, "onGround");
});

check("a generic movable entity is not the player and cannot edit blocks", () => {
  const npc = C.spawnMovable(world, { x: 300, y: 130, z: 300 });
  equal(world.has(npc, C.PLAYER), false, "no PLAYER marker: the input freeze never applies");
  equal(world.has(npc, C.VIEW), false, "no buffered mouse deltas");
  equal(world.has(npc, C.REACH), false, "no reach");
  equal(world.has(npc, C.INTERACTION), false, "no rate limits");
  equal(world.has(npc, C.INVENTORY), false, "no items");
  // movement's and collision's and the snapshot's queries must all accept it
  assert(world.query(C.CONTROL, C.POSITION, C.ORIENTATION, C.MOTION).indices.includes(entityIndex(npc)), "movement's query");
  assert(world.query(C.CONTROL, C.POSITION, C.MOTION, C.BODY, C.PREV_POSITION).indices.includes(entityIndex(npc)), "collision's query");
  assert(world.query(C.POSITION, C.PREV_POSITION).indices.includes(entityIndex(npc)), "the snapshot's query");
});

// ===== 3. the fixed lane: physics =====
console.log("\n--- the fixed lane: snapshot, gravity, collision ---");

const physics = world;
const drop = (x) => {
  const entity = C.spawnMovable(world, { x, y: 200, z: 5.5 });
  falling.push(entity);
  return entity;
};
const ticks = (n) => {
  for (let i = 0; i < n; i++) world.stepFixed(1 / 120);
};

check("a non-player entity lands, and PREV_POSITION tracks it", () => {
  const npc = drop(5.5);
  const index = entityIndex(npc);
  ticks(400);
  const motion = physics.get(npc, C.MOTION);
  equal(motion.onGround, true, "gravity, collision and onGround all worked for an NPC");
  // The ground is a NOISE FIELD now (P1.92), so the landing height is ASKED of the generated column rather
  // than assumed to be the base level: `topSolidY` is the same query the collision sweep agreed with.
  const surface = rawVoxel.topSolidY(5, 5, WORLD_MAX_Y - 1);
  assert(surface !== null, "the column the NPC falls down has ground in it at all");
  near(C.POSITION.y[index], surface + 1.6, 0.01, "landing height (collision leaves SKIN clearance)");
  assert(
    Math.abs(C.PREV_POSITION.y[index] - 200) > 50,
    "PREV_POSITION must have left the spawn height —the bug was that only the local player's row was written",
  );
  assert(
    Math.abs(C.POSITION.y[index] - C.PREV_POSITION.y[index]) < 0.25,
    "PREV_POSITION trails POSITION by at most one tick",
  );
});

check("the sweep stays cheap once resting (no replay of a stale origin)", () => {
  const npc = drop(6.5);
  ticks(400);
  equal(physics.get(npc, C.MOTION).onGround, true, "settled");
  solidCalls = 0;
  ticks(20);
  const perTick = solidCalls / 20;
  assert(perTick < 40, `expected a few isSolid() calls per resting tick, got ${perTick}`);
});

check("an entity with no PREV_POSITION is skipped, not swept from a bogus origin", () => {
  const orphan = physics.spawn();
  physics.insert(orphan, C.POSITION, { x: 20.5, y: 200, z: 20.5 });
  physics.insert(orphan, C.MOTION, { vy: 0, onGround: false });
  physics.insert(orphan, C.CONTROL, { keys: new Set(), mode: "walk", flying: false });
  physics.insert(orphan, C.BODY, { halfWidth: 0.3, height: 1.8, eyeHeight: 1.6 });
  const index = entityIndex(orphan);
  assert(
    !physics.query(C.CONTROL, C.POSITION, C.MOTION, C.BODY, C.PREV_POSITION).indices.includes(index),
    "collision must not resolve it",
  );
  C.POSITION.y[index] = 190;
  ticks(5);
  equal(C.POSITION.y[index], 190, "untouched: the loud failure is 'falls', not 'jitters'");
});

check("chunk meshing runs on WORKERS: the lane queues, drains and applies it (P1.18h)", () => {
  // The route: the PURE mesher (data/world/mesh.ts) turns voxel BYTES into typed arrays, a Worker pool runs it
  // off the main thread, and the render lane queues jobs and APPLIES the results inside a step — never from a
  // worker callback, so the scene is still only touched in a lane, in a deterministic order.
  const { ChunkStreamSystem } = load("plugins/render/systems/chunk-stream.js");
  const { meshChunk, gatherChunkMeshInput } = load("data/world/mesh.js");
  const { VoxelWorld } = load("data/world/world.js");
  const { CHUNK_SIZE } = load("data/world/chunk.js");
  const P = loadPresentation();

  // ===== 1. THE PURE MESHER, driven directly (this is the function a worker runs) =====
  const S = CHUNK_SIZE;
  const air = new Uint8Array(6 * S * S);            // every neighbour face is open, so nothing is culled
  const solid = new Uint8Array(6 * S * S).fill(1);  // every neighbour face is solid, so everything is culled
  const blocks = new Uint8Array(S * S * S);         // AIR (0) everywhere…
  blocks[1 + 1 * S + 1 * S * S] = 7;                // …except ONE voxel of value 7 at (1,1,1)
  const one = meshChunk({ uniform: false, uniformValue: 0, blocks, planes: air });
  equal(one.faces, 6, "a lone voxel emits all six faces");
  equal(one.slots.length, 3, "…gathered into three looks (side, top, bottom)");
  equal(
    one.slots.map((s) => `${s.key >> 2}/${s.key & 3}:${s.count}`).join(","),
    "7/2:4,7/0:1,7/1:1",
    "…keyed by (voxel value, kind) in first-seen order, so the caller can resolve each to a material",
  );
  equal(one.positions.length, 6 * 4 * 3, "four vertices per face");
  equal(one.normals.length, 6 * 4 * 3, "…with a normal each");
  equal(one.uvs.length, 6 * 4 * 2, "…and a uv each");
  equal(one.indices.length, 6 * 6, "six indices per face (two triangles)");
  equal(one.transfer.length, 4, "the four buffers come back as TRANSFERABLES, not as copies");
  // The two fast paths the flat world lives on.
  equal(meshChunk({ uniform: true, uniformValue: 0, blocks: null, planes: air }).faces, 0, "all-air emits nothing");
  equal(meshChunk({ uniform: true, uniformValue: 3, blocks: null, planes: solid }).faces, 0,
    "a solid chunk inside solid neighbours emits nothing (its shell is culled too)");
  assert(meshChunk({ uniform: true, uniformValue: 3, blocks: null, planes: air }).faces > 0,
    "…while a solid chunk with open neighbours is a shell of faces (the uniform fast path)");

  // ===== 2. THE LANE'S HALF, with the real mesher behind a fake transport =====
  // A REAL VoxelWorld (so the flat generator produces chunks with faces), the shared player handle, and a
  // geometry/material pair that records what happened instead of drawing.
  const voxel = new VoxelWorld();
  const cacheWorld = new World();
  cacheWorld.insertResource(VOXEL, voxel);
  cacheWorld.insertResource(LOCAL_PLAYER, localPlayer);
  const cache = P.createChunkMeshCache({ add() {}, remove() {} });
  cacheWorld.insertResource(P.CHUNK_MESHES, cache);
  cacheWorld.insertResource(P.CHUNK_MATERIAL, P.createChunkMaterial());
  // The stream reads the per-ring fade settings every step (P2.01), so every world it is built on needs them.
  cacheWorld.insertResource(FADE_OPTIONS, createFadeOptions());
  // The stream reads the key-edge log for the `G` LOD view (P1.94), so every world it is built on needs it.
  cacheWorld.insertResource(KEY_EVENTS, createKeyEventLog());

  const applied = [];   // faces applied through a geometry (the WORKER path)
  const rebuilt = [];   // sync rebuilds (the main-thread path)
  const restyled = [];  // look re-resolutions (the PACK RELOAD path, P1.18i)
  const fakeMesh = {
    createGeometry: () => ({
      // A real three.js Mesh is built around this in `applyResult`, and its constructor reads
      // `geometry.morphAttributes` — hence the empty object (the ONE thing a fake geometry owes it).
      geometry: { dispose() {}, morphAttributes: {} },
      specs: [],
      faces: 0,
      apply: (_v, result) => {
        applied.push(result.faces);
        return result.faces;
      },
      rebuild: () => {
        rebuilt.push(1);
        return 0;
      },
      // What a real geometry does here: rewrite its look list in place. Nothing about the vertices is
      // touched, which is the whole point of the assertion below.
      restyle: () => {
        restyled.push(1);
        return 1;
      },
      dispose: () => {},
    }),
    getMaterial: () => fakeChunkMaterial(),
  };
  // The pool stands in for the Workers: it runs the REAL pure mesher on the input the lane gathered, and hands
  // the result back on the NEXT `take()` — which is exactly how a worker reply arrives (a later frame).
  const jobs = [];
  const requests = [];
  let fail = false;
  const pool = {
    workers: 2,
    get inFlight() {
      return requests.length - jobs.length;
    },
    request(key, input) {
      requests.push(key);
      jobs.push({ key, result: fail ? null : meshChunk(input) });
      return true;
    },
    take() {
      return jobs.splice(0, jobs.length);
    },
  };
  const stream = new ChunkStreamSystem(cacheWorld, fakeMesh, pool);
  stream.prime(1, 3);
  stream.step();
  assert(requests.length > 0, "the lane hands chunks to the pool instead of meshing them itself");
  const firstBatch = [...cache.inFlight];
  equal(firstBatch.length, requests.length, "…and remembers which of them are in flight");
  equal(applied.length, 0, "nothing is applied from the request: the result is not back yet");
  stream.step();
  // The SAME keys are no longer in flight (the next batch starts asking immediately, so the SIZE of the set
  // is the wrong thing to look at — the keys that came back are).
  equal(firstBatch.filter((key) => cache.inFlight.has(key)).length, 0,
    "a result that came back is applied and retired in the SAME lane");
  assert(applied.length > 0, "…through the geometry (a worker's mesh), and");
  equal(rebuilt.length, 0, "…with no main-thread meshing needed at all");
  equal(requests.length, firstBatch.length + cache.inFlight.size,
    "…one job per chunk: nothing is asked for twice while its mesh is in flight");

  // A worker that FAILS must not leave a hole: the chunk falls back to this thread.
  fail = true;
  applied.length = 0;
  rebuilt.length = 0;
  const before = cache.meshes.size;
  for (let i = 0; i < 8 && cache.inFlight.size > 0; i++) stream.step();
  assert(rebuilt.length > 0 || applied.length > 0 || cache.meshes.size >= before,
    "a failed job degrades into the main-thread path rather than into a hole");

  // ===== 2b. THE TWO QUEUES KEEP THEIR OWN THREAD RULES =====
  fail = false;
  // A BLOCK EDIT is the one path that stays on THIS thread: the player is watching that single block.
  const meshed = [...cache.meshes.keys()];
  if (meshed.length > 0) {
    const parts = meshed[0].split(",").map(Number);
    rebuilt.length = 0;
    const asked = requests.length;
    voxel.setBlock(parts[0] * CHUNK_SIZE + 1, parts[1] * CHUNK_SIZE + 1, parts[2] * CHUNK_SIZE + 1, 1);
    stream.step();
    assert(rebuilt.length > 0, "a BLOCK EDIT is re-meshed on this thread (no round trip: the player is waiting)");
    // (the same step keeps streaming the rest of the window, so the assertion is about THIS key, not a count)
    assert(!requests.slice(asked).includes(meshed[0]), "…so the edited chunk itself is not handed to a worker");
  }

  // ===== 2c. AN EDIT RETIRES A JOB THAT IS ALREADY IN FLIGHT FOR THAT CHUNK (P1.91) =====
  // `drain`'s contract is "the in-flight set is the validity token: a key that is no longer in it was rebuilt
  // on this thread in the meantime (a block edit)". That was DOCUMENTED BUT NOT IMPLEMENTED on the edit path:
  // `rebuild` left the key in flight, so a worker whose planes were gathered BEFORE the edit came back a frame
  // later and overwrote the fresh mesh — the face the player had just exposed vanished again, which is the
  // other half of "some faces do not render when breaking blocks". A one-job, hand-delivered pool makes "was
  // the stale result applied" a single number.
  const { AIR } = load("data/world/chunk.js");
  const voxel2 = new VoxelWorld();
  const world2 = new World();
  world2.insertResource(VOXEL, voxel2);
  world2.insertResource(LOCAL_PLAYER, localPlayer);
  const cache2 = P.createChunkMeshCache({ add() {}, remove() {} });
  world2.insertResource(P.CHUNK_MESHES, cache2);
  world2.insertResource(P.CHUNK_MATERIAL, P.createChunkMaterial());
  world2.insertResource(FADE_OPTIONS, createFadeOptions());
  world2.insertResource(KEY_EVENTS, createKeyEventLog());
  const inFlight2 = [];   // requested, not yet DELIVERED (a real worker's round trip)
  const arrived2 = [];    // delivered: what the next `take()` hands the lane
  const staleApplied = [];  // apply() calls: a mesh refilled from a worker's result
  const probeMesh = {
    createGeometry: () => ({
      geometry: { dispose() {}, morphAttributes: {} },
      specs: [],
      apply: () => { staleApplied.push(1); return 1; },
      rebuild: () => 10,   // a mesh WITH faces, so the main-thread edit really installs one
      restyle: () => 1,
      dispose: () => {},
    }),
    getMaterial: () => fakeChunkMaterial(),
  };
  const pool2 = {
    workers: 1,
    get inFlight() { return inFlight2.length; },
    request(key, input) {
      // ONE job at a time: a saturated pool, so the scenario is a single chunk and nothing else.
      if (inFlight2.length > 0) return false;
      inFlight2.push({ key, result: meshChunk(input) });   // meshed NOW: the pre-edit world
      return true;
    },
    take() { return arrived2.splice(0, arrived2.length); },
  };
  const stream2 = new ChunkStreamSystem(world2, probeMesh, pool2);
  stream2.prime(1, 3);
  stream2.step();
  equal(inFlight2.length, 1, "one chunk is out at the pool (the transport is saturated)");
  equal(cache2.inFlight.size, 1, "…and the lane holds its validity token");
  const jobKey = inFlight2[0].key;
  const jp = jobKey.split(",").map(Number);
  voxel2.setBlock(jp[0] * CHUNK_SIZE + 1, jp[1] * CHUNK_SIZE + 1, jp[2] * CHUNK_SIZE + 1, AIR);
  stream2.step();
  assert(!cache2.inFlight.has(jobKey),
    "a block edit RETIRES the in-flight token for the chunk it rebuilds (the worker's planes predate the edit)");
  arrived2.push(inFlight2.shift());   // the worker finally answers…
  stream2.step();
  equal(staleApplied.length, 0, "…and its pre-edit result is DROPPED, not applied over the fresher mesh");
  // A PACK RELOAD is BULK, and it RESTYLES instead of re-meshing (P1.18i): a new chain changes what a block
  // LOOKS like, while the vertex data depends on the VOXELS alone (every uv is a per-face constant), so the
  // geometry is still correct and only its look list has to be resolved again. That turns a reload from
  // "thousands of chunk meshes" into "thousands of lookups".
  // Drain the transport first, so what follows is about the reload and nothing else.
  for (let i = 0; i < 200 && cache.inFlight.size > 0; i++) stream.step();
  rebuilt.length = 0;
  restyled.length = 0;
  const askedBeforeReload = requests.length;
  const meshesBefore = cache.meshes.size;
  assert(meshesBefore > 0, "the window has real meshes for a reload to restyle");
  voxel.markAllStale();
  for (let i = 0; i < 64 && voxel.staleCount > 0; i++) stream.step();
  equal(voxel.staleCount, 0, "the reload's queue drains over frames (budgeted, so it is never one long frame)");
  equal(restyled.length, meshesBefore, "every loaded mesh is RESTYLED exactly once…");
  equal(rebuilt.length, 0, "…and NOT ONE of them is re-meshed on this thread");
  equal(requests.length, askedBeforeReload, "…nor handed to a worker: a reload costs lookups, not geometry");

  // THE SAME DRAIN, DRIVEN BY HAND (P1.18i): the pack reload driver calls `restyleStale` behind the loading
  // screen, exactly the way the world-entry driver calls `warmUp` behind it. The async wrapper is asserted by
  // SHAPE below (this gate has no async groups); what is asserted HERE is the sync batch both callers share —
  // it must empty the queue, restyle every mesh once, and mesh nothing (no worker, no rebuild).
  restyled.length = 0;
  rebuilt.length = 0;
  applied.length = 0;
  const askedBeforeBatches = requests.length;
  const meshesAtDrain = cache.meshes.size;
  const marked = voxel.markAllStale();
  let taken = 0;
  let batches = 0;
  for (let i = 0; i < 512 && voxel.staleCount > 0; i++) {
    taken += stream.restyleNext(128);
    batches++;
  }
  equal(voxel.staleCount, 0, "a batch-driven drain leaves the queue EMPTY");
  equal(taken, marked, "…having taken every chunk the reload marked stale");
  equal(batches, Math.ceil(marked / 128), "…one batch per 128 of them (the budgeted core both callers share)");
  equal(restyled.length, meshesAtDrain, "…restyling every loaded mesh exactly once, and");
  equal(rebuilt.length, 0, "…re-meshing none of them,");
  equal(applied.length, 0, "…applying no worker result,");
  equal(requests.length, askedBeforeBatches, "…and asking the pool for nothing at all");
  equal(stream.restyleNext(128), 0, "an empty queue hands back nothing (so a caller can loop on it)");

  // ===== 3. THE WIRING, asserted where it lives =====
  // Read directly: this group sits above the section's `readSource`/`stripComments` helpers (they are defined
  // further down the file), so it uses `fs` the way the chunk-stream group next door does.
  const read = (rel) => require("node:fs").readFileSync(path.join(ROOT, "src", rel), "utf8");
  const systems = read("plugins/render/index.ts");
  assert(/w\.pool \?\? null,/.test(systems) && /w\.lod === undefined \? DEFAULT_LOD : w\.lod/.test(systems),
    "the pool is the chunk stream's third dependency (absent = main thread, which the gate uses), and the FAR " +
      "RING (P1.93) is the fourth — the plugin decides the shipped policy, the constructor's own default is off");
  // …and the FIFTH is where the far ring's height grids come from (M1): the GPU sampler the plugin just built. It is
  // handed in as `LodGridSource`, so the stream does not know what a GPU is (the gate's own stream gets none, i.e.
  // the CPU sampler, which is what keeps every far-ring assertion in this file valid without a device).
  assert(/lodSampler\.source,/.test(systems),
    "the GPU sampler (M1) is the chunk stream's FIFTH dependency, injected as `LodGridSource`");
  const root = read("boot/main.ts");
  assert(/const meshPool: MeshWorkerPool = createMeshWorkerPool\(\{ log: logDebug \}\)/.test(root),
    "the composition root builds the pool, with the log sink worker failures are reported to");
  assert(/meshPool,/.test(root), "…and hands it in as a host instance");
  const poolSrc = read("host/browser/mesh-pool.ts");
  assert(/createMeshWorkerPool/.test(poolSrc), "the pool creates the workers (a host object: a plugin may not import it)");
  assert(/slot\.worker\.postMessage\(job, transfer\)/.test(poolSrc),
    "…and posts each job WITH its buffers as transferables (no copy on the way in)");
  // A FAILING WORKER IS LOUD AND LOCAL (P1.18i): it is reported, its own jobs fall back to this thread, and it
  // is DROPPED so the rest of the pool keeps working. It used to fail every job in the pool and say nothing.
  assert(/MESH worker failed/.test(poolSrc) && /slots\.splice\(at, 1\)/.test(poolSrc),
    "a worker that dies is logged and dropped, instead of being left in the rotation");
  assert(/get hasPool\(\)/.test(read("plugins/render/systems/chunk-stream.ts")),
    "…and a pool with no worker left is treated as ABSENT (main-thread meshing), not as saturated for ever");
  assert(/pool\.workers > 0 \? pool : null/.test(read("plugins/render/plugin.ts")),
    "…including a pool that never started one: the plugin hands the stream null instead");
  const geomSrc = read("host/browser/chunkmesh.ts");
  assert(/restyle\(voxel: VoxelWorld\): number/.test(geomSrc) && /this\.slotKeys\.push\(key\)/.test(geomSrc),
    "the geometry keeps each slot's (value, kind), which is what makes a restyle possible without the mesher");
  const worker = read("host/browser/mesh-worker.ts");
  assert(/meshChunk\(input\)/.test(worker) && /result\.transfer/.test(worker),
    "the worker runs the pure mesher and transfers the result back");
  // THE SCREEN-DRIVEN DRAIN, end to end (P1.18i): the stream can run the whole queue for a caller that yields,
  // the reload driver is that caller, and it runs it AFTER marking the world stale — behind the screen it
  // already has up, instead of leaving ~24 frames of it to the game.
  // (Raw source, not `stripComments`: that helper is defined further down the file, so it is in its TDZ here.)
  const streamSrc = read("plugins/render/systems/chunk-stream.ts");
  assert(
    /async restyleStale\(\s*yieldTo: \(\) => Promise<void>,/.test(streamSrc) &&
      /this\.restyleNext\(\);\s*await yieldTo\(\)/.test(streamSrc),
    "the stream can drain the whole stale queue in batches for a caller that yields (the loading screen)",
  );
  assert(/RESTYLE_DRAIN_BATCHES/.test(streamSrc) && /guard < RESTYLE_DRAIN_BATCHES/.test(streamSrc),
    "…under a guard, so a world larger than this one can never wedge a reload's screen");
  assert(/restyleStale\(/.test(read("data/globals/render-handles.ts")),
    "…and the reload driver may only reach it through the published handle (a plugin type it cannot import)");
  const reloadSrc = read("boot/drivers/pack-reload.ts");
  assert(/await restyleBehindScreen\(\)/.test(reloadSrc), "the reload driver DRIVES that drain…");
  assert(
    reloadSrc.indexOf("deps.voxel.markAllStale()") < reloadSrc.indexOf("await restyleBehindScreen()"),
    "…after it marks the world stale (there is nothing to resolve before that)",
  );
  assert(
    (reloadSrc.match(/await restyleBehindScreen\(\)/g) || []).length === 2,
    "…on BOTH paths: the successful reload and its rollback (the old chain's looks too)",
  );
  assert(!/queued for a restyle/.test(reloadSrc),
    "…and the summary no longer promises work the game frames will do later",
  );
});

check("a block broken at a chunk border re-meshes the RIGHT face of its ±Z neighbour (P1.91)", () => {
  // MEASURED BUG: `gatherChunkMeshInput` lays every neighbour plane out as `a * S + b`, but `makeSolidAt`
  // read the ±Z planes as `lx + ly * S` — TRANSPOSED. A uniform plane is symmetric, so the swap was
  // invisible until a block was broken on a ±Z chunk border (that is also why the flat world hid it): the
  // plane stops being uniform, the mesher culls a cell from somewhere ELSE in the same 32x32 layer, and the
  // newly exposed face is simply MISSING — the player looks through the terrain.
  //
  // This drives the real world through the real gatherer, with all six neighbours LOADED so the sealed
  // count is exactly 0 and the face that must appear is unambiguous.
  const { meshChunk, gatherChunkMeshInput } = load("data/world/mesh.js");
  const { VoxelWorld } = load("data/world/world.js");
  const { AIR } = load("data/world/chunk.js");
  const voxel = new VoxelWorld();
  // Chunk (0,2,0) spans y 64..95 — solid stone, and (being below the surface band) UNIFORM, so it takes the
  // mesher's shell fast path, which is exactly where the plane read happens.
  for (const [dx, dy, dz] of [
    [0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  ]) {
    voxel.ensureChunk(dx, 2 + dy, dz);
  }
  const meshOf = (cx, cy, cz) => meshChunk(gatherChunkMeshInput(voxel, voxel.ensureChunk(cx, cy, cz), cx, cy, cz));
  /** Every face's CENTROID, local to the chunk: a +Z face on voxel (x,y,z) sits at (x+.5, y+.5, z+1). */
  const centroids = (m) => {
    const out = [];
    for (let i = 0; i < m.faces; i++) {
      const c = [0, 0, 0];
      for (let v = 0; v < 4; v++) for (let k = 0; k < 3; k++) c[k] += m.positions[i * 12 + v * 3 + k] / 4;
      out.push(`${c[0]},${c[1]},${c[2]}`);
    }
    return out.sort().join(" | ");
  };
  equal(meshOf(0, 2, 0).faces, 0, "a solid chunk inside six LOADED solid neighbours is sealed: nothing to draw");

  // Break the block the player digs PAST: in the +Z neighbour's first layer, at local (5, 2) of the plane
  // z = 32 — so the block at local (5, 2, 31) must paint its +Z face.
  voxel.setBlock(5, 66, 32, AIR);
  equal(meshOf(0, 2, 0).faces, 1, "breaking a block on the far side of the +Z border exposes exactly ONE face here");
  equal(centroids(meshOf(0, 2, 0)), "5.5,2.5,32", "…the face of the block the player dug past, not of a transposed cell");

  // …and the mirrored direction through the -Z neighbour's last layer (which WRAPS: z = -1).
  voxel.setBlock(5, 66, -1, AIR);
  equal(centroids(meshOf(0, 2, 0)), "5.5,2.5,0 | 5.5,2.5,32", "…and the ±Z planes are read with the same layout");

  // The source contract behind it: the two halves must keep ONE layout (`a * S + b`). (Raw fs read:
  // `readSource`/`stripComments` are declared further down the file, so they are in their TDZ here.)
  const meshSrc = require("node:fs").readFileSync(path.join(ROOT, "src", "data", "world", "mesh.ts"), "utf8");
  assert(
    /if \(lz === S\) return planes\[PLANE\.PZ \* PLANE_BYTES \+ lx \* S \+ ly\] === 1;/.test(meshSrc) &&
      /planes\[plane \* PLANE_BYTES \+ a \* S \+ b\]/.test(meshSrc),
    "the mesher READS the Z planes with the layout the gatherer WRITES (a * S + b)",
  );
});

check("the terrain is a NOISE FIELD: one field everywhere, torus-periodic, solid from the floor up (P1.92)", () => {
  // The world used to be a flat layer cake; it is a height FIELD now, and everything downstream reads it
  // through `isSolid()`/`topSolidY` (the mesher's face culling, collision, the spawn). What must hold is
  // therefore not "these numbers" but the PROPERTIES the flat generator got for free:
  //   * the same field in every world and at every moment (a chunk generated later must agree with the one
  //     already drawn beside it, or the seam is a wall);
  //   * EXACTLY periodic on the torus (the renderer draws the far side next to the near side, so an
  //     un-wrapped noise would put a cliff at the lap);
  //   * a column solid from the ground floor to its surface and air above it — no holes, nothing floating.
  const T = load("data/world/terrain.js");
  const { AIR, CHUNK_SIZE, CHUNK_VOLUME } = load("data/world/chunk.js");
  const { FALLBACK_PALETTE } = load("data/world/palette.js");

  equal(T.terrainPeriod(), worldChunksX() * CHUNK_SIZE,
    "the noise's lap IS the torus period in force (both read data/world/size.ts — P2.02)");
  equal(TERRAIN_TOP_Y, T.TERRAIN_BASE_Y, "the old flat surface height is the field's BASE level");

  // 1. ONE FIELD, EXACTLY PERIODIC, INSIDE ITS DECLARED BOUNDS.
  let wraps = 0;
  let lowest = T.TERRAIN_MAX_Y + 1;
  let highest = T.TERRAIN_MIN_Y - 1;
  for (let i = 0; i < 512; i++) {
    const lap = T.terrainPeriod();
    const x = (i * 37) % lap;
    const z = (i * 91) % lap;
    const h = T.terrainHeight(x, z);
    if (h === T.terrainHeight(x + lap, z) && h === T.terrainHeight(x, z + lap)) wraps++;
    if (h < lowest) lowest = h;
    if (h > highest) highest = h;
    assert(
      h >= T.TERRAIN_MIN_Y && h <= T.TERRAIN_MAX_Y,
      `height ${h} stays inside the bounds the generator's uniform fast paths are built on`,
    );
  }
  equal(wraps, 512, "a lap in X and a lap in Z land on the SAME column");
  assert(highest - lowest >= 20, `the field is not flat: sampled range ${lowest}..${highest} over one lap`);

  // 2. THE SAME FIELD IN EVERY WORLD, block for block.
  const a = new VoxelWorld();
  const b = new VoxelWorld();
  const ca = a.ensureChunk(0, 3, 0);
  const cb = b.ensureChunk(0, 3, 0);
  let same = 0;
  for (let lz = 0; lz < CHUNK_SIZE; lz++) {
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        if (ca.get(lx, ly, lz) === cb.get(lx, ly, lz)) same++;
      }
    }
  }
  equal(same, CHUNK_VOLUME, "two independently built worlds generate an identical chunk");

  // 3. A COLUMN IS SOLID FROM THE GROUND FLOOR TO ITS SURFACE, AND AIR ABOVE IT. (Reads do not generate, so
  //    every sampled column's chunks are ensured first — exactly what the chunk stream does for the player.)
  const ensureColumn = (w, x, z) => {
    for (let cy = 0; cy < 8; cy++) w.ensureChunk(Math.floor(x / CHUNK_SIZE), cy, Math.floor(z / CHUNK_SIZE));
  };
  const grass = FALLBACK_PALETTE.indexOf("grass") + 1;
  const dirt = FALLBACK_PALETTE.indexOf("dirt") + 1;
  const stone = FALLBACK_PALETTE.indexOf("stone") + 1;
  const columns = [[0, 0], [5, 5], [31, 17], [64, 64], [127, 300], [333, 777], [900, 100], [1023, 1023]];
  for (const [x, z] of columns) {
    ensureColumn(a, x, z);
    const surface = a.topSolidY(x, z, WORLD_MAX_Y - 1);
    assert(surface !== null, `column ${x},${z} has ground at all`);
    for (let y = 0; y < surface; y++) {
      assert(a.isSolid(x, y, z), `column ${x},${z} is solid at y=${y} — no hole under the surface`);
    }
    for (let y = surface; y < WORLD_MAX_Y; y++) {
      assert(!a.isSolid(x, y, z), `column ${x},${z} is air at y=${y} — nothing floating above the surface`);
    }
    equal(a.getBlock(x, surface - 1, z), grass, `column ${x},${z}: grass on top`);
    equal(a.getBlock(x, surface - 2, z), dirt, `column ${x},${z}: dirt under the grass`);
    equal(a.getBlock(x, surface - 5, z), stone, `column ${x},${z}: stone below the dirt band`);
  }

  // 4. THE UNIFORM FAST PATHS SURVIVE THE FIELD: `isUniform` is what the mesher skips and what keeps a tall
  //    world cheap, and a bounded field is what lets a chunk be filled with ONE value at all.
  const deep = a.ensureChunk(0, 0, 0);
  const sky = a.ensureChunk(0, 7, 0);
  const band = a.ensureChunk(0, 3, 0);
  equal(deep.isUniform, true, "a chunk below the surface band is uniform…");
  equal(deep.uniformValue, stone, "…and it is stone");
  equal(sky.isUniform, true, "a chunk above the field is uniform…");
  equal(sky.uniformValue, AIR, "…and it is air");
  equal(band.isUniform, false, "a chunk the surface crosses materialises (it really does have blocks to draw)");
});

check("LOD: the far ring is coarse, never BELOW the fine surface, and meets the fine ring exactly (P1.93)", () => {
  // The window is two rings now: an inner ring of real chunks and an outer one drawn from the same terrain at
  // `step` fine chunks per coarse chunk. What must hold is (a) the two rings TILE the view — no column drawn
  // twice, none drawn never — and (b) the coarse surface is never lower than the fine one, which is the single
  // property that makes an LOD ring incapable of opening a crack. Both are asserted against the real generator.
  const L = load("data/world/lod.js");
  const { meshChunk } = load("data/world/mesh.js");
  const { CHUNK_SIZE } = load("data/world/chunk.js");
  const { VoxelWorld, WORLD_MAX_Y } = load("data/world/world.js");
  const { FALLBACK_PALETTE } = load("data/world/palette.js");
  const policy = L.DEFAULT_LOD;
  // THE LADDER IN FORCE for a shipped-size world (P2.03): rung 1 is the fine ring, rung 2 is the old far ring,
  // and the rest are the new ones. The first two rungs are what most of this group is about — the properties
  // that must hold for EVERY rung are asserted in the P2.03 group below.
  const LADDER = L.lodLadder(policy, 512, 0, 0); // a 512-chunk lap: the whole shipped ladder fits
  const T2 = LADDER[1];
  equal(T2.step, 2, "rung 2 is the coarse ring the gate has always checked");
  equal(T2.hole, policy.reach, "…whose hole is the fine window (4 of its 2-chunk cells)");
  equal(T2.x.holeHi - T2.x.holeLo, T2.hole, "…and its cells are exactly that window");

  // 1. THE RUNGS TILE THE VIEW — FOR EVERY PLAYER COLUMN, not just an aligned one (P1.94 — measured bug). The
  //    fine ring must be built around `fineBase(playerColumn)`, because it is a whole number of the SECOND
  //    rung's columns while that rung's hole is a whole number of them too. Built around the RAW column, every
  //    ODD column left one fine column owned by NEITHER rung — a 32-block-wide, full-depth column with no
  //    geometry whose neighbours' walls are culled, i.e. a hole you look straight through — and one owned by
  //    BOTH (two meshes in the same place, z-fighting). This loop is that regression test.
  const tile = (raw, zRaw = raw) => {
    const base = L.fineBase(policy, raw);
    const zBase = L.fineBase(policy, zRaw);
    // The two rungs' ranges for THIS window: exactly what `wantedKeys`/`farKeys` build (rung 1 in fine chunks,
    // rung 2 in its own 2-chunk cells, both anchored on the world grid).
    const here = L.lodLadder(policy, 512, base * CHUNK_SIZE, zBase * CHUNK_SIZE);
    const t1 = here[0];
    const t2 = here[1];
    const owner = new Map();
    let overlaps = 0;
    const claim = (x, z) => {
      const k = `${x},${z}`;
      if (owner.has(k)) overlaps++;
      owner.set(k, 1);
    };
    for (let dx = t1.x.lo; dx < t1.x.hi; dx++) {
      for (let dz = t1.z.lo; dz < t1.z.hi; dz++) claim(base + dx, zBase + dz);
    }
    const ccx = Math.floor(base / t2.step);
    const ccz = Math.floor(zBase / t2.step);
    for (let cx = t2.x.lo; cx < t2.x.hi; cx++) {
      for (let cz = t2.z.lo; cz < t2.z.hi; cz++) {
        if (!L.inTierAnnulus(t2, cx, cz)) continue;
        for (let dx = 0; dx < t2.step; dx++) {
          for (let dz = 0; dz < t2.step; dz++) {
            claim((ccx + cx) * t2.step + dx, (ccz + cz) * t2.step + dz);
          }
        }
      }
    }
    // …and the promise: inside rung 2's OWN corner-to-corner extent, every fine column is claimed exactly once.
    // A rectangle, not a square: the two axes' ranges are measured from their own centres.
    const c2x = ccx + t2.x.hi;
    const c2z = ccz + t2.z.hi;
    const l2x = ccx + t2.x.lo;
    const l2z = ccz + t2.z.lo;
    let gaps = 0;
    for (let x = l2x * t2.step; x < c2x * t2.step; x++) {
      for (let z = l2z * t2.step; z < c2z * t2.step; z++) if (!owner.has(`${x},${z}`)) gaps++;
    }
    return { gaps, overlaps, size: owner.size, square: (c2x - l2x) * t2.step * (c2z - l2z) * t2.step };
  };
  for (const [raw, zRaw] of [[0, 0], [1, 1], [2, 2], [3, 3], [7, 7], [8, 8], [100, 100], [101, 101], [251, 251], [252, 252], [4, 9], [9, 4]]) {
    const t = tile(raw, zRaw);
    equal(t.gaps, 0, `player column ${raw},${zRaw}: no column is drawn by NEITHER rung`);
    equal(t.overlaps, 0, `player column ${raw},${zRaw}: none is drawn by BOTH rungs`);
    equal(t.size, t.square, `player column ${raw},${zRaw}: the union is exactly the ladder's own rectangle`);
  }
  equal(L.fineBase(null, 7), 7, "with no LOD the alignment is the identity (the single-window path is untouched)");
  equal(L.fineBase(policy, 7), 6, "…and with LOD an odd column rounds DOWN to the coarse grid");

  // 2. THE COARSE VOXEL CONTAINS THE FINE ONES, pointwise: wherever a fine block is solid, the coarse voxel
  //    that covers it is solid too. That is the property (not "the top of the column") which makes a crack
  //    impossible — a hole would need a solid fine block with an AIR coarse voxel over it.
  const world = new VoxelWorld();
  const stone = FALLBACK_PALETTE.indexOf("stone") + 1;
  const dirt = FALLBACK_PALETTE.indexOf("dirt") + 1;
  const grass = FALLBACK_PALETTE.indexOf("grass") + 1;
  let inspected = 0;
  let holes = 0;
  let faces = 0;
  let materialised = 0;
  for (let cx = T2.x.lo; cx < T2.x.hi; cx += 3) {
    for (let cz = T2.z.holeHi; cz < T2.z.hi; cz += 3) {
      if (!L.inTierAnnulus(T2, cx, cz)) continue;
      for (let cy = 2; cy <= 5; cy++) {
        const input = L.buildLodMeshInput(T2.step, cx, cy, cz, stone, dirt, grass);
        const result = meshChunk(input);
        faces += result.faces;
        if (!input.uniform) materialised++;
        const solidAt = (lx, ly, lz) =>
          input.uniform
            ? input.uniformValue !== 0
            : input.blocks[lx + ly * CHUNK_SIZE + lz * CHUNK_SIZE * CHUNK_SIZE] !== 0;
        for (let lx = 0; lx < CHUNK_SIZE; lx += 7) {
          for (let lz = 0; lz < CHUNK_SIZE; lz += 7) {
            for (let dx = 0; dx < T2.step; dx++) {
              for (let dz = 0; dz < T2.step; dz++) {
                const fx = cx * T2.step * CHUNK_SIZE + lx * T2.step + dx;
                const fz = cz * T2.step * CHUNK_SIZE + lz * T2.step + dz;
                for (let cy2 = 2; cy2 <= 5; cy2++) {
                  world.ensureChunk(Math.floor(fx / CHUNK_SIZE), cy2, Math.floor(fz / CHUNK_SIZE));
                }
                for (let ly = 0; ly < CHUNK_SIZE; ly += 3) {
                  inspected++;
                  if (!world.isSolid(fx, cy * CHUNK_SIZE + ly, fz)) continue;
                  if (!solidAt(lx, ly, lz)) holes++;
                }
              }
            }
          }
        }
      }
    }
  }
  assert(inspected > 100, `the sampler really was inspected (${inspected} fine voxels under coarse ones)`);
  equal(holes, 0, "every SOLID fine voxel is solid in the coarse voxel above it — no crack is possible");
  assert(faces > 0 && materialised > 0, "and the sampled chunks do produce geometry to draw");
  equal(L.isFarColumn(policy, 0, 0), false, "the far ring never covers a cell the fine ring owns");
  equal(L.isFarColumn(policy, T2.x.hi + 1, 0), false, "…nor anything past its reach");

  // 2b. THE SIDE WALLS MAY NOT BE CULLED AGAINST A FINER NEIGHBOUR (P1.95 — measured bug, one block big).
  //     A far chunk's ±X/±Z quad is `step × step` BLOCKS wide while the neighbour on that side may be the FINE
  //     ring, whose surface is per block. Culling with the MAXIMUM height of the covered cell deletes the wall
  //     wherever the terrain steps INSIDE the cell, and the fine block that is lower has no geometry either —
  //     so you see into the terrain through a hole at most one block across (measured: 3 of 1024 cells on one
  //     boundary wall, 2 of them showing the interior). The rule is therefore `min`: cull only when the WHOLE
  //     covered area is solid. This asserts it PER BLOCK, which is what the old check missed — it ORed the two
  //     z blocks of the cell together, and that hid exactly this case.
  let wallCells = 0;
  let wallHoles = 0;
  let extraWalls = 0;
  for (const [cx, cz] of [
    [T2.x.holeHi, 0],
    [0, T2.z.holeHi],
    [T2.x.holeHi, T2.z.holeHi],
  ]) {
    if (!L.isFarColumn(policy, cx, cz)) continue;
    for (let cy = 2; cy <= 5; cy++) {
      const input = L.buildLodMeshInput(T2.step, cx, cy, cz, stone, dirt, grass);
      if (input.uniform) continue;
      const gx0 = cx * T2.step * CHUNK_SIZE;
      const gz0 = cz * T2.step * CHUNK_SIZE;
      // The west wall faces the coarse cell at `gx0 - step`, which covers `step × step` FINE BLOCKS.
      for (let ly = 0; ly < CHUNK_SIZE; ly++) {
        const y = cy * CHUNK_SIZE + ly;
        for (let lz = 0; lz < CHUNK_SIZE; lz++) {
          const culled = input.planes[1 * CHUNK_SIZE * CHUNK_SIZE + ly * CHUNK_SIZE + lz] === 1;
          let solid = 0;
          let total = 0;
          for (let dx = 0; dx < T2.step; dx++) {
            for (let dz = 0; dz < T2.step; dz++) {
              const fx = gx0 - T2.step + dx;
              const fz = gz0 + lz * T2.step + dz;
              for (let cy2 = 2; cy2 <= 5; cy2++) {
                world.ensureChunk(Math.floor(fx / CHUNK_SIZE), cy2, Math.floor(fz / CHUNK_SIZE));
              }
              total++;
              if (world.isSolid(fx, y, fz)) solid++;
            }
          }
          wallCells++;
          if (culled && solid < total) wallHoles++; // culled although part of it is air → a hole
          if (!culled && solid === total) extraWalls++; // drawn although it is fully solid → harmless overdraw
        }
      }
    }
  }
  assert(wallCells > 500, `the side walls really were inspected (${wallCells} cells)`);
  equal(wallHoles, 0, "no side wall is culled while ANY block it covers is air — that was the one-block hole");
  assert(
    extraWalls < wallCells * 0.05,
    `the cull-safe rule over-draws a little, not a lot (${extraWalls} of ${wallCells} cells)`,
  );

  // 3. THE `G` LOD VIEW (P1.94): every mesh is tinted by its TIER, and pressing G again puts the look back.
  //    Driven on a real stream over a real world with a RECORDING factory, so this asserts the whole path:
  //    the key edge → the toggle → the material re-resolve → what each mesh ends up holding.
  assert(L.tierTint(1) !== L.tierTint(2), "each tier has its own colour");
  assert(L.LOD_TIER_TINT.length >= 2 && /^#[0-9a-f]{6}$/i.test(L.tierTint(1)), "…as hex, one per tier");
  const { ChunkStreamSystem } = load("plugins/render/systems/chunk-stream.js");
  const { VOXEL, LOCAL_PLAYER, KEY_EVENTS, createKeyEventLog, publishKeyEdge } = load("data/globals/resources.js");
  const P = loadPresentation();
  const viewWorld = new World();
  const viewVoxel = new VoxelWorld();
  viewWorld.insertResource(VOXEL, viewVoxel);
  viewWorld.insertResource(LOCAL_PLAYER, localPlayer);
  const viewCache = P.createChunkMeshCache({ add() {}, remove() {} });
  viewWorld.insertResource(P.CHUNK_MESHES, viewCache);
  viewWorld.insertResource(P.CHUNK_MATERIAL, P.createChunkMaterial());
  // BOTH tiers fade, so this group keeps driving the fade MECHANISM (P1.98/P1.99) whatever the shipped default
  // is; the defaults themselves are asserted in the P2.01 group below.
  viewWorld.insertResource(FADE_OPTIONS, createFadeOptions(true, true));
  const edges = createKeyEventLog();
  viewWorld.insertResource(KEY_EVENTS, edges);
  let materialGen = 0;
  const recording = {
    createGeometry: () => ({
      geometry: { dispose() {}, morphAttributes: {} },
      specs: [{ key: "view-look", texture: null, color: null }],
      apply: () => 5,
      rebuild: () => 5,
      restyle: () => 1,
      dispose() {},
    }),
    // The one thing this factory owes the assertion: it is ASKED for a tint, per mesh — and every resolution is
    // stamped, so "was this mesh re-resolved after the chain change" is observable (P1.97).
    getMaterial: (_state, _spec, tint) => fakeChunkMaterial({ tint: tint ?? null, gen: ++materialGen }),
  };
  const view = new ChunkStreamSystem(viewWorld, recording, null, policy);
  view.step();
  // A mesh with GROUPS holds an ARRAY of materials (one per look), so read the tint through both shapes.
  const tintOf = (m) => (Array.isArray(m) ? (m[0]?.tint ?? null) : (m?.tint ?? null));
  const tierOf = () => [...viewCache.meshes.values()].map((e) => `${e.step}:${tintOf(e.mesh.material)}`);
  assert(tierOf().length > 0, "the stream built meshes to tint");
  equal(tierOf().filter((t) => !t.endsWith(":null")).length, 0, "with the view OFF every mesh takes the plain look");
  publishKeyEdge(edges, { code: "KeyG", down: true, repeat: false });
  view.step();
  const tinted = tierOf();
  assert(tinted.some((t) => t === `1:${L.tierTint(1)}`), "G tints the FINE ring with the tier-1 colour");
  assert(tinted.every((t) => !t.endsWith(":null")), "…and every mesh in the window, not just one");
  // A repeat must not flip it (a held key is one press) and a keyUP must not either.
  publishKeyEdge(edges, { code: "KeyG", down: true, repeat: true });
  publishKeyEdge(edges, { code: "KeyG", down: false, repeat: false });
  view.step();
  assert(tierOf().every((t) => t === `1:${L.tierTint(1)}` || t === `2:${L.tierTint(2)}`), "a repeat/keyup does not toggle");
  publishKeyEdge(edges, { code: "KeyG", down: true, repeat: false });
  view.step();
  equal(tierOf().filter((t) => !t.endsWith(":null")).length, 0, "pressing it again puts the plain look back");

  // 3b. `H` — THE TRIANGLE WIREFRAME (P1.96): the same material switch, one flag further, and the two keys are
  //     INDEPENDENT (a wireframe you can still colour by tier is what makes it useful while checking the LOD).
  const wireOf = (m) => (Array.isArray(m) ? (m[0]?.wireframe ?? null) : (m?.wireframe ?? null));
  const wires = () => [...viewCache.meshes.values()].map((e) => wireOf(e.mesh.material));
  assert(wires().length > 0, "there are meshes to switch");
  assert(wires().every((w) => w === false), "with H off every mesh is solid geometry");
  publishKeyEdge(edges, { code: "KeyH", down: true, repeat: false });
  view.step();
  assert(wires().every((w) => w === true), "H draws EVERY chunk mesh as a triangle wireframe");
  // …and it must also mark the material for RECOMPILATION: three.js caches a pipeline per material and the
  // wireframe flag decides the primitive TOPOLOGY, so setting the flag alone leaves the world solid (measured).
  const materials = [...viewCache.meshes.values()].flatMap((e) =>
    Array.isArray(e.mesh.material) ? e.mesh.material : [e.mesh.material],
  );
  // ONLY A MATERIAL THAT WAS ALREADY COMPILED NEEDS THE RECOMPILE FLAG. A chunk built in THIS VERY STEP (an
  // appearance fade, P1.98) holds a freshly CLONED material that three.js has never compiled — and the real
  // `Material.copy` does not carry `needsUpdate` either — so it is compiled with `wireframe` already in force.
  // A fade copy is exactly the material `beginFade` marked `transparent`, so the flag is asked of the SHARED
  // ones; without it in `debugged`, the reused materials stay stale and this still fails.
  const rebuilt = materials.filter((m) => m.transparent !== true);
  assert(rebuilt.length > 0, "the step left shared materials to recompile");
  assert(rebuilt.every((m) => m.needsUpdate === true), "…and asks three.js to rebuild those materials");
  // A repeat and the key release are ignored, exactly like G.
  publishKeyEdge(edges, { code: "KeyH", down: true, repeat: true });
  publishKeyEdge(edges, { code: "KeyH", down: false, repeat: false });
  view.step();
  assert(wires().every((w) => w === true), "a repeat/keyup does not toggle the wireframe");
  // …and it composes with the tint: G on, H on, then G off leaves the wireframe alone.
  publishKeyEdge(edges, { code: "KeyG", down: true, repeat: false });
  view.step();
  assert(wires().every((w) => w === true), "G does not disturb the wireframe");
  assert(tierOf().every((t) => !t.endsWith(":null")), "…and the tint came back with it");
  publishKeyEdge(edges, { code: "KeyG", down: true, repeat: false });
  view.step();
  assert(wires().every((w) => w === true), "turning the tint off leaves the wireframe on");
  publishKeyEdge(edges, { code: "KeyH", down: true, repeat: false });
  view.step();
  equal(wires().every((w) => w === false), true, "H again puts the solid geometry back");

  // 3c. A CHAIN CHANGE MUST REACH EVERY MESH IN THE CACHE (P1.97 — measured bug). The reload's stale queue is
  //     filled from the WORLD (`VoxelWorld.markAllStale`), and the FAR RING is procedural — it holds no chunk in
  //     that map — so every already-loaded far chunk used to keep the PREVIOUS chain's materials and only picked
  //     the new ones up when it happened to be built or rebuilt. `markFarStale()` is the second queue.
  const genOf = (e) => (Array.isArray(e.mesh.material) ? e.mesh.material[0] : e.mesh.material).gen;
  const gens = (step) =>
    [...viewCache.meshes.values()].filter((e) => step === undefined || e.step === step).map(genOf);
  const farBefore = gens(2);
  const fineBefore = gens(1);
  assert(farBefore.length > 0, "the far ring has meshes in the cache (the case that broke)");
  // The OLD path, on its own: the world's queue reaches the fine ring and CANNOT name a far chunk — the bug.
  viewVoxel.markAllStale();
  view.restyleNext(4096);
  assert(gens(1).every((g, i) => g !== fineBefore[i]), "the world's queue does re-resolve the FINE ring");
  equal(gens(2).join(","), farBefore.join(","), "…but it cannot reach the far ring — that was the bug");
  // …and with the far queue marked, EVERY entry changes generation, with no mesh lost.
  const marked = view.markFarStale();
  assert(marked > 0, `markFarStale names the far meshes (${marked})`);
  assert(view.restylePending >= marked, "…and the pending count includes them (the reload bar counts both queues)");
  viewVoxel.markAllStale();
  view.restyleNext(4096);
  equal(gens(2).length, farBefore.length, "no far mesh left the cache");
  assert(gens(2).every((g, i) => g !== farBefore[i]), "EVERY far mesh was re-resolved");
  assert(gens(1).every((g, i) => g !== fineBefore[i]), "…and every fine one too");
  equal(view.restylePending, 0, "…and both queues are empty afterwards");
});

check("a chunk that APPEARS fades in, one that LEAVES fades out (P1.98/P1.99) - an EDIT never fades", () => {
  // The reported complaint: a chunk that streams in POPPED at full opacity, which reads as a flash. The fix is
  // a per-chunk appearance fade — the chunk draws with its OWN copy of the material, starting at 0 opacity and
  // ramped by the LANE's delta, and the shared material is put back (copies freed) when it ends. What the gate
  // must hold to:
  //   * a chunk that appears starts INVISIBLE and ramps over FADE_IN_MS — driven by the frame delta, NOT by
  //     wall-clock time (a `step(0)` must not move it), which is also what makes it frame-rate independent;
  //   * an EDIT stays instant: `rebuild` never starts a fade, even for a chunk that is mid-fade (P1.18i);
  //   * the copies do not leak (every one is disposed when its fade ends);
  //   * `J` turns the effect off, ends what is in flight at once, and a chunk that appears afterwards is drawn
  //     with the shared material immediately;
  //   * and the OTHER direction (P1.99): a chunk that LEAVES the streaming window keeps its mesh in the scene,
  //     ramped 1 → 0, and is taken down (mesh out, geometry freed, copies freed) only when that fade ends —
  //     removing it on the frame it left is the same pop, at the ring boundary where the coarse mesh vanishes
  //     as the fine one replacing it starts fading in.
  const L = load("data/world/lod.js");
  const { ChunkStreamSystem, FADE_IN_MS, FADE_OUT_MS } = load("plugins/render/systems/chunk-stream.js");
  const { AIR, CHUNK_SIZE } = load("data/world/chunk.js");
  const { VoxelWorld } = load("data/world/world.js");
  const P = loadPresentation();
  const fadeWorld = new World();
  const fadeVoxel = new VoxelWorld();
  fadeWorld.insertResource(VOXEL, fadeVoxel);
  // The player HANDLE from the world above: component storage lives on the DEFINITION, so one process supports
  // one World (ROADMAP §3.9) and a second `spawnPlayer` is refused. The stream only reads the row, and this
  // group puts the position back before it ends.
  fadeWorld.insertResource(LOCAL_PLAYER, localPlayer);
  const positionRow = entityIndex(localPlayer);
  const startX = C.POSITION.x[positionRow];
  // EVERY MOVE THIS GROUP MAKES IS UNDONE IN A `finally`. The row belongs to the world the whole gate runs on,
  // and the group after this one builds its window from it — so an assertion that throws here used to leave the
  // player four chunks away and fail "a window still needs warming" two checks later (measured). The body is
  // deliberately NOT re-indented: the `try` is a safety net, not a new scope.
  try {
  // What LEFT THE SCENE and what was FREED: a fade-out's whole contract is "the mesh stays in the scene until
  // the fade ends, and is out of it (with its geometry freed) the moment it does".
  const leftScene = [];
  const disposedGeoms = [];
  const fadeCache = P.createChunkMeshCache({ add() {}, remove: (mesh) => leftScene.push(mesh) });
  fadeWorld.insertResource(P.CHUNK_MESHES, fadeCache);
  fadeWorld.insertResource(P.CHUNK_MATERIAL, P.createChunkMaterial());
  // Both tiers ON: this group is about the fade mechanics (P1.98/P1.99), not about the shipped defaults.
  fadeWorld.insertResource(FADE_OPTIONS, createFadeOptions(true, true));
  const fadeEdges = createKeyEventLog();
  fadeWorld.insertResource(KEY_EVENTS, fadeEdges);
  let fadeGen = 0;
  const fadeFactory = {
    createGeometry: () => {
      const geom = {
        geometry: { dispose() {}, morphAttributes: {} },
        // ONE look (`specs: []`): the mesh then holds a single material, and the assertions read it directly.
        specs: [],
        apply: () => 5,
        rebuild: () => 5,
        restyle: () => 1,
        dispose() {
          disposedGeoms.push(geom);
        },
      };
      return geom;
    },
    // `shared: true` is what the material CACHE hands out; a fade copy is a clone, and the fake's clone clears
    // the mark (a real clone is not the cached instance either).
    getMaterial: () => fakeChunkMaterial({ shared: true, gen: ++fadeGen }),
  };
  const fadeStream = new ChunkStreamSystem(fadeWorld, fadeFactory, null, L.DEFAULT_LOD);
  const entries = () => [...fadeCache.meshes.values()];
  const materialOf = (e) => (Array.isArray(e.mesh.material) ? e.mesh.material[0] : e.mesh.material);
  const faded = () => entries().filter((e) => materialOf(e).shared === false);

  fadeStream.step();
  const first = entries();
  assert(first.length > 0, "the first step built meshes to fade");
  const copies = first.map(materialOf);
  equal(copies.filter((m) => m.shared !== false).length, 0, "every chunk that just APPEARED draws with its OWN copy of the material");
  equal(
    copies.filter((m) => m.transparent === true && m.opacity === 0).length,
    copies.length,
    "…starting fully invisible, not popping in",
  );

  // The DELTA is what ramps it (so a 30fps and a 60fps frame reach the same opacity after the same ms)…
  fadeStream.step(0);
  equal(copies.filter((m) => m.opacity === 0).length, copies.length, "a step with no time in it does not move the fade");
  fadeStream.step(FADE_IN_MS / 2);
  assert(copies.every((m) => Math.abs(m.opacity - 0.5) < 1e-6), "half the time is half the opacity");
  fadeStream.step(FADE_IN_MS);
  // Read the meshes AGAIN: a finished fade does not edit its copies, it puts the SHARED material back on the
  // mesh and frees them — so the copies above are now dead objects and the entries are what changed.
  const finished = first.map(materialOf);
  assert(
    finished.every((m) => m.shared === true && m.transparent === false && m.opacity === 1),
    "…and at FADE_IN_MS the SHARED material is back, at full opacity",
  );
  assert(copies.every((m) => fakeDisposed.includes(m)), "…and every copy the fade made was freed");

  // AN EDIT IS INSTANT, EVEN MID-FADE (P1.18i). The chunk the player is watching must change NOW: `rebuild`
  // resolves the shared material (and the fade in flight is dropped) instead of restarting a fade, which would
  // leave the block they just dug invisible for another FADE_IN_MS.
  const victim = entries().find((e) => e.step === 1 && e.cy >= 0 && materialOf(e).shared === false);
  assert(victim !== undefined, "a chunk is mid-fade to edit");
  const victimCopy = materialOf(victim);
  const bx = victim.cx * CHUNK_SIZE + 1;
  const by = victim.cy * CHUNK_SIZE + 1;
  const bz = victim.cz * CHUNK_SIZE + 1;
  assert(by < WORLD_MAX_Y, "the target block is inside the world's Y range");
  equal(fadeVoxel.setBlock(bx, by, bz, AIR), true, "the gate edits a block inside the chunk that is mid-fade");
  fadeStream.step();
  assert(
    materialOf(victim).shared === true && materialOf(victim).transparent === false,
    "an EDIT is instant: the chunk comes back on the SHARED material instead of fading again",
  );
  // The cut-short fade is dropped by the NEXT step's guard — that is the design: `advanceFades` notices a mesh
  // that no longer holds its copies and ends that fade, so no other path (edit, restyle, pack reload) has to
  // remember to end one. The copy is off screen in the meantime (the mesh already holds the shared material).
  fadeStream.step();
  assert(fakeDisposed.includes(victimCopy), "…and the cut-short fade freed its copy");
  assert(materialOf(victim).shared === true, "…without the edited chunk ever going translucent again");

  // J OFF (P1.98): the switch ends every fade in flight at once, or the chunks that are mid-fade would stay
  // translucent for ever — with the effect off nothing would ever finish them.
  for (let i = 0; i < 400 && fadeStream.pendingCount() > 0; i++) fadeStream.step(0);
  assert(faded().length > 0, "the window filled up with chunks that are mid-fade");
  publishKeyEdge(fadeEdges, { code: "KeyJ", down: true, repeat: false });
  fadeStream.step();
  equal(faded().length, 0, "J OFF ends every fade at once: every chunk is on the shared material");
  assert(entries().every((e) => materialOf(e).opacity === 1), "…at full opacity");

  // …and a chunk that APPEARS with the fade off is drawn at once: moving the window must build new chunks that
  // never go translucent (the effect is what the key switches, not the building).
  const beforeMove = new Set(fadeCache.meshes.keys());
  C.POSITION.x[positionRow] += 10 * CHUNK_SIZE;
  fadeStream.step();
  const appearedOff = [...fadeCache.meshes.keys()].filter((k) => !beforeMove.has(k));
  assert(appearedOff.length > 0, `moving the window built new chunks (${appearedOff.length})`);
  equal(
    appearedOff.filter((k) => materialOf(fadeCache.meshes.get(k)).shared !== true).length,
    0,
    "with the fade OFF a chunk that appears is drawn with the shared material immediately",
  );

  // J ON again: the same move must now make the new chunks fade, so the key really is the switch and not a
  // one-way door.
  publishKeyEdge(fadeEdges, { code: "KeyJ", down: true, repeat: false });
  fadeStream.step();
  const beforeMove2 = new Set(fadeCache.meshes.keys());
  C.POSITION.x[positionRow] += 10 * CHUNK_SIZE;
  fadeStream.step();
  const appearedOn = [...fadeCache.meshes.keys()].filter((k) => !beforeMove2.has(k));
  assert(appearedOn.length > 0, `moving again built new chunks (${appearedOn.length})`);
  const freshCopies = appearedOn.map((k) => materialOf(fadeCache.meshes.get(k)));
  equal(freshCopies.filter((m) => m.shared !== false).length, 0, "with the fade back ON the new chunks hold their own copies");
  equal(
    freshCopies.filter((m) => m.transparent === true && m.opacity === 0).length,
    freshCopies.length,
    "…and start invisible, exactly like the first fill did",
  );
  // ===== FADE OUT (P1.99) =====
  // The other half of the same complaint. A chunk that left the streaming window used to vanish on the frame it
  // left; it now leaves the CACHE at once (nothing may treat it as loaded) while its MESH stays in the scene,
  // ramped 1 → 0, and is taken down when the fade ends. Two chunks of movement, so the window really moves
  // (the fine window is coarse-aligned) and only a handful of meshes retire — a mass unload is capped by
  // FADE_OUT_MAX and removes the rest at once, which is asserted separately below.
  //
  // The window IS filled first (`step(0)`, so nothing moves): the meshes only exist for the columns the budget
  // reached, and a move can only retire what is there. Then a few BIG steps drain what the earlier moves left in
  // flight — which also empties the OUT-fade budget: the cap exists for a mass unload, and a saturated cap makes
  // a leaving mesh be removed at once instead of fading (this group moved the window twice before this point).
  for (let i = 0; i < 400 && fadeStream.pendingCount() > 0; i++) fadeStream.step(0);
  for (let i = 0; i < 4; i++) fadeStream.step(1000);
  const settled = new Map(fadeCache.meshes);
  C.POSITION.x[positionRow] += 2 * CHUNK_SIZE;
  fadeStream.step(0);
  const ghosts = [...settled.entries()].filter(([k]) => !fadeCache.meshes.has(k)).map(([, e]) => e);
  assert(ghosts.length > 0, `the move retired chunks from the window (${ghosts.length})`);
  const ghostCopies = ghosts.map(materialOf);
  equal(
    ghostCopies.filter((m) => m.shared === false && m.transparent === true && m.opacity === 1).length,
    ghostCopies.length,
    "a chunk that LEAVES starts its fade at full opacity instead of vanishing",
  );
  equal(
    ghosts.filter((g) => leftScene.includes(g.mesh)).length,
    0,
    "…and its mesh is still in the scene while it fades",
  );
  fadeStream.step(FADE_OUT_MS / 2);
  assert(ghostCopies.every((m) => Math.abs(m.opacity - 0.5) < 1e-6), "half the fade-out time is half the way down");
  fadeStream.step(FADE_OUT_MS);
  equal(
    ghosts.filter((g) => leftScene.includes(g.mesh)).length,
    ghosts.length,
    "…and at FADE_OUT_MS every leaving mesh is out of the scene",
  );
  assert(ghosts.every((g) => disposedGeoms.includes(g.geom)), "…with its geometry freed");
  assert(ghostCopies.every((m) => fakeDisposed.includes(m)), "…and the copies the fade made freed");

  // …and a chunk that COMES BACK while its ghost is still fading out must not be drawn twice: the dying mesh
  // goes the moment its key is built again. (Without this the chunk would be in the scene twice for the rest of
  // the fade — once faded to wherever it got, and with the PREVIOUS chain's look after a pack reload.)
  fadeStream.step(1000);
  const beforeBack = new Map(fadeCache.meshes);
  C.POSITION.x[positionRow] += 2 * CHUNK_SIZE;
  fadeStream.step(0);
  const leftKeys = [...beforeBack.keys()].filter((k) => !fadeCache.meshes.has(k));
  assert(leftKeys.length > 0, `chunks left the window (${leftKeys.length})`);
  C.POSITION.x[positionRow] -= 2 * CHUNK_SIZE;
  fadeStream.step(0);
  const backKeys = leftKeys.filter((k) => fadeCache.meshes.has(k));
  assert(backKeys.length > 0, `chunks came back while their ghosts were still fading (${backKeys.length})`);
  equal(
    backKeys.filter((k) => leftScene.includes(beforeBack.get(k).mesh)).length,
    backKeys.length,
    "a returning chunk's ghost is taken down instead of being drawn beside the new mesh",
  );

  // J OFF: with the effect switched off a chunk that leaves is removed at once, exactly as it always was (the
  // key switches the EFFECT, not the streaming) — and the meshes that were fading out are taken down now.
  publishKeyEdge(fadeEdges, { code: "KeyJ", down: true, repeat: false });
  fadeStream.step(1000);
  const beforeOffMove = new Map(fadeCache.meshes);
  C.POSITION.x[positionRow] += 2 * CHUNK_SIZE;
  fadeStream.step(0);
  const goneOff = [...beforeOffMove.entries()].filter(([k]) => !fadeCache.meshes.has(k));
  assert(goneOff.length > 0, `the move retired chunks with the fade off (${goneOff.length})`);
  equal(
    goneOff.filter(([, e]) => leftScene.includes(e.mesh)).length,
    goneOff.length,
    "with the fade OFF a chunk that leaves is removed at once, as it always was",
  );
  // Put the shared player back where this group found it: the row belongs to the world the whole gate runs on.
  } finally {
    C.POSITION.x[positionRow] = startX;
    C.PREV_POSITION.x[positionRow] = startX;
  }
});

check("the far ring keeps a READY RESERVE under the fine ring (P2.00): the seam is a swap, never a hole", () => {
  // THE MEASURED COMPLAINT this exists for: at the fine ring's edge the sky FLASHED as the window moved. The two
  // rings TILE (the far ring owns exactly what the fine ring does not), so a column leaving the fine ring was a
  // brand new far column: it had no coarse mesh at all, and there was nothing behind the fine mesh while the far
  // budget caught up. The appearance fades only shortened that hole (P1.98/P1.99 — the user's own verdict:
  // the sky still flashed, just for less time).
  //
  // How the reference implementations avoid it (see lod.ts `isFarBuildColumn`): the coarse level is always
  // THERE, covering the fine one, and the renderer only chooses which level to draw — Voxy mips every section up
  // four levels and descends rather than leaving a gap, Cubyz draws a parent node until all 8 of its children
  // are meshed, DH keeps the LOD image under the vanilla one and blends the two by distance. This engine's
  // version of that is the smallest one that works: the far ring BUILDS the coarse chunks under the fine ring
  // and DRAWS them only while the fine chunks that cover them are not all there yet. The gate must hold to:
  //   * the DRAWN ring is unchanged (it still tiles with the fine ring) and the build set is a superset of it;
  //   * with the window warm, every coarse chunk under the fine ring is INVISIBLE, and every drawn one visible;
  //   * moving the window, the column that leaves the fine ring ALREADY has its coarse mesh (it was the reserve)
  //     and is VISIBLE in the same step — no frame with nothing behind the fine mesh;
  //   * the column that enters the fine ring keeps its coarse chunk up until the fine chunks that replace it are
  //     built AND opaque, and only then hides.
  const L = load("data/world/lod.js");
  // A TINY ladder: the mechanism is geometry and bookkeeping, and the shipped one is ~7000 coarse keys. Two
  // rungs of `reach` 2: the fine ring covers two fine chunks each way and rung 2 covers the cells around it,
  // its hole being exactly that fine window. The ranges are built around the origin; for THIS policy they are
  // the same wherever the window sits (a 2-cell hole and a 6-cell coverage, always), so the offsets below are
  // the ones the stream computes around the player.
  const policy = { tiers: 2, reach: 2 };
  const T2 = L.lodLadder(policy, 32, 0, 0)[1];
  const STEP = T2.step;
  const HOLE = T2.hole;
  const REACH = T2.reach;
  equal(STEP, 2, "rung 2 is the 2-chunk ring…");
  equal(REACH, 2, "…whose annulus is `reach` of its own cells wide…");
  equal(T2.x.hi - T2.x.lo, 6, "…so its coverage is 6 cells across…");
  equal(HOLE, 2, "…with the fine window as its 2-cell-wide hole");
  const { ChunkStreamSystem } = load("plugins/render/systems/chunk-stream.js");
  const { CHUNK_SIZE } = load("data/world/chunk.js");
  const { VoxelWorld, nearestWrap } = load("data/world/world.js");
  const P = loadPresentation();

  // 1. THE SETS, as data (no stream needed): the drawn annulus is exactly the coarse columns the finer rung does
  //    not cover, every drawn column is BUILT, and the reserve is the hole itself.
  let built = 0;
  let reserved = 0;
  for (let cx = T2.x.lo; cx < T2.x.hi; cx++) {
    for (let cz = T2.z.lo; cz < T2.z.hi; cz++) {
      const drawn = L.inTierAnnulus(T2, cx, cz);
      const covered = L.inTierHole(T2, cx, cz);
      assert(!(drawn && covered), "a coarse column is never both DRAWN and in the hole (the tiling)");
      if (L.inTierCoverage(T2, cx, cz)) {
        built++;
        if (covered) reserved++;
      }
      if (drawn) assert(L.inTierCoverage(T2, cx, cz), "every DRAWN coarse column is in the build set");
    }
  }
  assert(reserved > 0, `the reserve really covers coarse columns the finer rung owns (${reserved})`);
  assert(built > reserved, "…and the build set is a superset of the drawn ring, not all of it");

  const reserveWorld = new World();
  const reserveVoxel = new VoxelWorld();
  reserveWorld.insertResource(VOXEL, reserveVoxel);
  reserveWorld.insertResource(LOCAL_PLAYER, localPlayer);
  const positionRow = entityIndex(localPlayer);
  const startX = C.POSITION.x[positionRow];
  const reserveCache = P.createChunkMeshCache({ add() {}, remove() {} });
  reserveWorld.insertResource(P.CHUNK_MESHES, reserveCache);
  reserveWorld.insertResource(P.CHUNK_MATERIAL, P.createChunkMaterial());
  reserveWorld.insertResource(FADE_OPTIONS, createFadeOptions());
  reserveWorld.insertResource(KEY_EVENTS, createKeyEventLog());
  let gen = 0;
  const reserveFactory = {
    createGeometry: () => ({
      geometry: { dispose() {}, morphAttributes: {} },
      specs: [],
      apply: () => 5,
      rebuild: () => 5,
      restyle: () => 1,
      dispose() {},
    }),
    getMaterial: () => fakeChunkMaterial({ shared: true, gen: ++gen }),
  };
  const stream = new ChunkStreamSystem(reserveWorld, reserveFactory, null, policy);
  // COARSE entries only (a key with the step prefix): the fine meshes live in the same cache and are always
  // drawn, so comparing THEIR columns against the COARSE player column means nothing.
  const coarse = () => [...reserveCache.meshes.entries()].filter(([key]) => key.includes(":"));
  const period = worldChunksX() / STEP; // the torus in THIS tier's columns
  /** Where a coarse entry sits relative to the player's coarse column — the same nearest-copy arithmetic the
   *  system uses (`nearestWrap`), because a key is a WRAPPED column and comparing it raw is meaningless. */
  const reachOf = (e, ccx, ccz) => [
    nearestWrap(e.cx, ccx, period) - ccx,
    nearestWrap(e.cz, ccz, period) - ccz,
  ];

  try {
    // 2. FILL EVERYTHING: the fine window first (what a world entry does), then the whole build set, which now
    //    includes the reserve the fine ring covers.
    for (let i = 0; i < 400 && stream.pendingCount() > 0; i++) stream.step(1000);
    // The LAST built chunks are still mid-fade when that loop exits (a chunk built in step N finishes in N+1),
    // and the reserve stays visible under a translucent fine chunk — so let those fades finish first.
    stream.step(1000);
    stream.step(1000);
    const farPending = () => {
      let n = 0;
      for (const key of stream.farWanted) if (!reserveCache.meshes.has(key) && !reserveCache.empty.has(key)) n++;
      return n;
    };
    for (let i = 0; i < 2000 && farPending() > 0; i++) stream.step(0);
    equal(farPending(), 0, "the whole far build set is built (the drawn ring AND the reserve)");
    equal(stream.pendingCount(), 0, "…and the fine window is decided");

    // 3. WITH THE FINE RING THERE, THE RESERVE IS INVISIBLE — the state a player stands in. The coarse chunk
    //    under them exists but must not be drawn: it is a conservative 2×2-block surface that would show
    //    through the real chunks.
    const ccx = Math.floor(stream.lastPcx / STEP);
    const ccz = Math.floor(stream.lastPcz / STEP);
    const inWindow = coarse().filter(([, e]) => {
      const [dx, dz] = reachOf(e, ccx, ccz);
      return L.inTierHole(T2, dx, dz);
    });
    assert(inWindow.length > 0, `the reserve really has meshes in the cache (${inWindow.length})`);
    equal(inWindow.filter(([, e]) => e.mesh.visible).length, 0, "…and NONE of them is drawn while the fine chunks are there");
    const drawnBefore = coarse().filter(([, e]) => {
      const [dx, dz] = reachOf(e, ccx, ccz);
      return L.inTierAnnulus(T2, dx, dz);
    });
    assert(drawnBefore.length > 0, `the drawn ring has meshes (${drawnBefore.length})`);
    equal(drawnBefore.filter(([, e]) => !e.mesh.visible).length, 0, "…while everything outside the fine ring is drawn");

    // 4. THE HANDOVER (the bug itself): move the window ONE COARSE COLUMN and look at the column that leaves the
    //    fine ring. Its coarse mesh must ALREADY exist — it was the reserve, so this move asked for nothing new —
    //    and it must be VISIBLE in that same step: that is what "no frame with nothing behind the fine mesh"
    //    means, and it is the whole point of the reserve.
    const beforeMove = new Set(reserveCache.meshes.keys());
    const leavingEntries = coarse().filter(([, e]) => {
      const [dx, dz] = reachOf(e, ccx, ccz);
      // The cells on the TRAILING edge of the fine ring: in the rung's hole before the move, its annulus after.
      return dx === T2.x.holeLo && dz >= T2.z.holeLo && dz < T2.z.holeHi;
    });
    assert(leavingEntries.length > 0, `the trailing column had coarse meshes (${leavingEntries.length})`);
    for (const [key, e] of leavingEntries) {
      assert(beforeMove.has(key), "…and they were the RESERVE: built before this move asked for anything");
      assert(e.mesh.visible === false, "…invisible while the fine ring was still there");
    }
    C.POSITION.x[positionRow] += STEP * CHUNK_SIZE; // one coarse column
    stream.step(0);
    const ccxAfter = Math.floor(stream.lastPcx / STEP);
    equal(ccxAfter, ccx + 1, "the window really moved one coarse column");
    equal(
      leavingEntries.filter(([, e]) => !e.mesh.visible).length,
      0,
      "the leaving column is DRAWN in the same step it left the fine ring (no sky, nothing was built for it)",
    );

    // 5. AND THE OTHER DIRECTION: the column the fine ring just claimed keeps its coarse chunk on screen until the
    //    fine chunks that replace it are built — and opaque, because a translucent fine chunk over nothing is the
    //    sky showing through it — and only then is it hidden.
    const enteredEntries = coarse().filter(([, e]) => {
      const [dx, dz] = reachOf(e, ccxAfter, ccz);
      // The cells on the LEADING edge: the annulus of the old window, inside the hole of the new one.
      return dx === T2.x.holeHi - 1 && dz >= T2.z.holeLo && dz < T2.z.holeHi;
    });
    assert(enteredEntries.length > 0, `the column the fine ring claimed has coarse meshes (${enteredEntries.length})`);
    equal(
      enteredEntries.filter(([, e]) => !e.mesh.visible).length,
      0,
      "…and it is STILL DRAWN while its fine chunks are not built yet",
    );
    for (let i = 0; i < 400 && stream.pendingCount() > 0; i++) stream.step(1000);
    stream.step(1000); // the swap waits for OPAQUE, not just present: let the last built chunks' fades finish
    stream.step(1000);
    equal(stream.pendingCount(), 0, "the fine chunks that replace it are all built");
    equal(
      enteredEntries.filter(([, e]) => e.mesh.visible).length,
      0,
      "…and the coarse chunk is hidden only now, once the fine ones are there AND opaque",
    );
  } finally {
    C.POSITION.x[positionRow] = startX;
    C.PREV_POSITION.x[positionRow] = startX;
  }
});

check("the appearance fade is ONE uniform SETTING (P2.01 → P2.05): every chunk fades, whatever rung it is", () => {
  // The fade began as one effect over both rings (P1.98/P1.99), was split per ring when P2.00's reserve made them
  // different questions (P2.01), narrowed to the outermost rung (P2.04) and is UNIFORM again by request: a chunk
  // either APPEARED or it LEFT, and which rung it belongs to is an implementation detail of the window. `chunks`
  // is the retired second switch — it must still be accepted from an older file and must no longer change
  // anything, which is asserted below.
  const L = load("data/world/lod.js");
  const { ChunkStreamSystem } = load("plugins/render/systems/chunk-stream.js");
  const { VoxelWorld } = load("data/world/world.js");
  const P = loadPresentation();

  // 1. THE DEFAULTS, and the file's own rule (absent or unusable = the sane default): the fade is ON unless the
  //    file says `false`, and the retired switch keeps its own (unused) default.
  const dflt = createFadeOptions();
  assert(dflt.lod === true && dflt.chunks === false, "the shipped defaults are fade ON / retired switch OFF");
  for (const junk of [undefined, null, "yes", 1, 0, {}, [], NaN]) {
    const o = createFadeOptions(junk, junk);
    assert(o.lod === true, `an unusable fade value means ON (${String(junk)})`);
    assert(o.chunks === false, `…and an unusable retired value keeps its default (${String(junk)})`);
  }
  const literal = createFadeOptions(false, true);
  assert(literal.lod === false && literal.chunks === true, "…and a real false/true is taken literally");

  // 2. THE COMMAND writes the resource, one option at a time, and only at the BARRIER (a UI callback may not
  //    assign state the tick reads — the same rule the frame cap and vsync follow).
  const plain = new World();
  const options = createFadeOptions(true, false);
  plain.insertResource(FADE_OPTIONS, options);
  plain.start(); // the barrier lives behind start() — the panel's click rides the ui lane
  plain.commands.send(SetFadeOption, { which: "lod", on: false });
  equal(options.lod, true, "nothing changes before the barrier");
  plain.renderUi(); // the barrier + the ui lane: the command applies here
  equal(options.lod, false, "the command turns the fade off");
  plain.commands.send(SetFadeOption, { which: "chunks", on: true });
  plain.renderUi();
  equal(options.lod, false, "…and the retired switch cannot turn it back on");
  equal(options.chunks, true, "(its own value still travels, for an older file's sake)");

  // 3. THE STREAM OBEYS IT, live and for EVERY rung: with the fade ON a chunk of ANY rung appears on its own
  //    material copy; with it OFF every one of them appears on the SHARED material.
  const world = new World();
  const voxel = new VoxelWorld();
  world.insertResource(VOXEL, voxel);
  world.insertResource(LOCAL_PLAYER, localPlayer);
  const cache = P.createChunkMeshCache({ add() {}, remove() {} });
  world.insertResource(P.CHUNK_MESHES, cache);
  world.insertResource(P.CHUNK_MATERIAL, P.createChunkMaterial());
  world.insertResource(KEY_EVENTS, createKeyEventLog());
  const settings = createFadeOptions(); // the SHIPPED defaults
  world.insertResource(FADE_OPTIONS, settings);
  world.start();
  let gen = 0;
  const factory = {
    createGeometry: () => ({
      geometry: { dispose() {}, morphAttributes: {} },
      specs: [],
      apply: () => 5,
      rebuild: () => 5,
      restyle: () => 1,
      dispose() {},
    }),
    getMaterial: () => fakeChunkMaterial({ shared: true, gen: ++gen }),
  };
  // A tiny ladder (THREE rungs of reach 2): the setting is about WHETHER a chunk fades, not about ring geometry —
  // and three rungs is the smallest ladder that would expose a per-rung rule if one came back.
  const stream = new ChunkStreamSystem(world, factory, null, { tiers: 3, reach: 2 });
  const materialOf = (e) => (Array.isArray(e.mesh.material) ? e.mesh.material[0] : e.mesh.material);
  const freshOf = (step, since) =>
    [...cache.meshes.entries()].filter(([key, e]) => e.step === step && !since.has(key)).map(([, e]) => e);
  const keysNow = () => new Set(cache.meshes.keys());

  stream.step();
  const fineFirst = freshOf(1, new Set());
  assert(fineFirst.length > 0, "the first step built the fine ring");
  equal(
    fineFirst.filter((e) => materialOf(e).shared !== false).length,
    0,
    "with the fade ON (the shipped default) a REAL chunk gets its own copy to fade with — no per-ring rule",
  );
  // BOTH coarse rungs, over as many steps as they need (the far budget is 2 chunks a frame, and the inner rung is
  // built first) — and BOTH must take a copy: the rule is uniform now (P2.05).
  const coarse = { 2: [], 4: [] };
  for (let i = 0; i < 80 && (coarse[2].length === 0 || coarse[4].length === 0); i++) {
    const before = keysNow();
    stream.step();
    for (const step of [2, 4]) coarse[step] = coarse[step].concat(freshOf(step, before).map((e) => materialOf(e).shared));
  }
  assert(coarse[2].length > 0 && coarse[4].length > 0, `both coarse rungs appeared (${coarse[2].length}/${coarse[4].length})`);
  equal(coarse[4].filter((s) => s !== false).length, 0, "the OUTERMOST rung fades in like everything else");
  equal(coarse[2].filter((s) => s !== false).length, 0, "…and so does a rung INSIDE it (the P2.04 restriction is gone)");

  // …and the switch really is LIVE for every one of them: turn it off through the command and the chunks that
  // appear from then on are on the SHARED material, whatever rung they belong to.
  world.commands.send(SetFadeOption, { which: "lod", on: false });
  world.renderUi();
  equal(settings.lod, false, "the fade is off now");
  // The window is DRAINED by the loop above, so fresh chunks of every kind need a MOVE: walking a couple of
  // chunks sideways retires a strip and brings a new one in — which is also exactly when the setting matters.
  const row = entityIndex(localPlayer);
  const startX = C.POSITION.x[row];
  const startZ = C.POSITION.z[row];
  C.POSITION.x[row] = startX + 64;
  try {
    let fineAfter = [];
    let outerAfter = [];
    for (let i = 0; i < 200 && (fineAfter.length === 0 || outerAfter.length === 0); i++) {
      const before = keysNow();
      stream.step();
      // The material is read AT COLLECTION TIME: a fade lasts 220 ms and this loop keeps stepping until the
      // outermost rung has produced a chunk too, by which point the first fine ones would have finished fading
      // and hold the shared material again — asserting later would fail on a correct engine.
      fineAfter = fineAfter.concat(freshOf(1, before).map((e) => materialOf(e).shared));
      outerAfter = outerAfter.concat(freshOf(4, before).map((e) => materialOf(e).shared));
    }
    assert(fineAfter.length > 0, `more real chunks appeared (${fineAfter.length})`);
    equal(
      fineAfter.filter((s) => s !== true).length,
      0,
      "with the fade OFF a real chunk appears on the SHARED material",
    );
    assert(outerAfter.length > 0, `more outermost-rung chunks appeared (${outerAfter.length})`);
    equal(
      outerAfter.filter((s) => s !== true).length,
      0,
      "…and with the LOD fade OFF even the outermost rung appears on the shared material",
    );
  } finally {
    C.POSITION.x[row] = startX;
    C.POSITION.z[row] = startZ;
    C.PREV_POSITION.x[row] = startX;
    C.PREV_POSITION.z[row] = startZ;
  }
});

check("the world's XZ LAP is a setting (P2.02): the noise, the torus and the rings all follow it", () => {
  // The lap was a hard-coded 32 chunks = 1024 blocks. It is a CHOICE now because it is the number that decides how
  // far a distance LOD may reach: a rung at radius R is unambiguous only while `R < lap/2`, or its far edge starts
  // showing the terrain that is closer the other way round (`lodTierFits`). Five or six rungs — what a
  // "planet-like" world wants — need 8192/16384 blocks, so the lap has to move for them.
  // Raw `fs` for the source assertions: `readSource`/`stripComments` are declared further down the file, so they
  // are in their TDZ here.
  const readSrc = (rel) => require("node:fs").readFileSync(path.join(ROOT, rel), "utf8");
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const T = load("data/world/terrain.js");
  const L = load("data/world/lod.js");
  const { CHUNK_SIZE } = load("data/world/chunk.js");

  // 1. THE LEGAL DOMAIN, as data: clamp, snap onto the step, and an unusable value means the default lap.
  equal(sanitizeWorldChunks(undefined), WORLD_CHUNKS_MIN, "an unusable size is the smallest legal lap");
  equal(sanitizeWorldChunks(NaN), WORLD_CHUNKS_MIN, "…and so is NaN");
  equal(sanitizeWorldChunks(1), WORLD_CHUNKS_MIN, "a tiny size is CLAMPED up (the two rings need room)");
  equal(sanitizeWorldChunks(99999), WORLD_CHUNKS_MAX, "…and a huge one clamped down");
  equal(sanitizeWorldChunks(33), WORLD_CHUNKS_MIN, "a value off the grid SNAPS onto it (33 rounds down to 32)");
  equal(sanitizeWorldChunks(48), 48, "…and a legal multiple of the step is taken as it is");
  equal(sanitizeWorldChunks(50), 48, "…rounding to the NEAREST legal value");
  for (const preset of WORLD_SIZE_PRESETS) {
    equal(sanitizeWorldChunks(preset), preset, `the preset ${preset} is a legal size`);
    equal(preset % WORLD_CHUNKS_STEP, 0, "…on the grid every legal size shares");
  }
  // THE RUNGS MUST STILL FIT: a rung is unambiguous only while its outer radius stays inside the LAP's half
  // (`lodTierFits`), and that single rule replaced the old hard-coded `worldSizeFitsLod`. Asserted as DATA: the
  // smallest legal lap still holds the fine ring plus one coarse rung, and the rule really refuses a rung that
  // would reach past the half-lap.
  const smallLap = L.lodLadder(L.DEFAULT_LOD, WORLD_CHUNKS_MIN, 0, 0);
  assert(smallLap.length >= 2, `the smallest legal lap still holds more than the fine ring (${smallLap.length})`);
  for (const tier of smallLap) {
    assert(L.lodTierFits(tier, WORLD_CHUNKS_MIN), `…and every rung the ladder kept fits (step ${tier.step})`);
    const reachBlocks = Math.max(-tier.x.lo, tier.x.hi) * tier.step * CHUNK_SIZE;
    assert(reachBlocks <= (WORLD_CHUNKS_MIN * CHUNK_SIZE) / 2, `…measured in blocks too (${reachBlocks})`);
  }
  // …and the rule really refuses a rung that would reach past the half-lap: the second rung of a policy whose
  // reach is the whole smallest lap.
  const tooFar = L.lodLadder({ tiers: 2, reach: 32 }, WORLD_CHUNKS_MIN, 0, 0);
  equal(tooFar.length, 1, "a policy whose second rung would reach past the half-lap is cut to the fine ring");
  assert(
    !L.lodTierFits({ step: 2, hole: 0, reach: 32 }, WORLD_CHUNKS_MIN),
    "…which is exactly what `lodTierFits` says about it",
  );

  // 2. THE FIELD FOLLOWS THE LAP, AND THE LAP REALLY MOVES. This is the load-bearing one: the noise's lattice
  //    index is taken modulo the lap, so EVERY octave's cell size must divide it (the coarsest is 512 blocks —
  //    which is why a legal size is a multiple of 16 chunks). A size off that grid puts a cliff at the seam:
  //    invisible in code, obvious in game.
  const before = { x: worldChunksX(), z: worldChunksZ() };
  try {
    equal(setWorldChunks(64), true, "setting a new size reports that it CHANGED");
    equal(worldChunksX(), 64, "…and the period in force is the new one");
    equal(worldPeriodBlocks(), 2048, "…which is 2048 blocks around");
    equal(T.terrainPeriod(), 2048, "the noise's lap follows the world (one number, two readers)");
    let wrapped = 0;
    let differs = 0;
    for (let i = 0; i < 256; i++) {
      const x = (i * 53) % 2048;
      const z = (i * 97) % 2048;
      const h = T.terrainHeight(x, z);
      if (h === T.terrainHeight(x + 2048, z) && h === T.terrainHeight(x, z + 2048)) wrapped++;
      // …and the field is NOT periodic over the OLD lap any more: a "size change" that did not really move would
      // leave the world exactly as it was, which is the failure nobody would notice by eye.
      if (h !== T.terrainHeight((x + 1024) % 2048, z)) differs++;
    }
    equal(wrapped, 256, "the field is exactly periodic over the NEW lap");
    assert(differs > 0, `…and no longer over the old one (${differs} of 256 columns differ)`);
    // The wrap is a REAL torus at the new size too, and `VoxelWorld.reset` (what the entry driver calls) really
    // throws the old world away: a chunk key is a WRAPPED identity, so "column 5" is a different place in a
    // different lap and keeping it would pepper the new world with the old one's blocks.
    const voxel = new VoxelWorld();
    voxel.ensureChunk(63, 4, 0);
    assert(voxel.getChunk(63, 4, 0) !== null, "the chunk is there before the reset");
    equal(
      voxel.getBlock(63 * CHUNK_SIZE, 100, 0),
      voxel.getBlock(-CHUNK_SIZE, 100, 0),
      "block (-32, ·, 0) IS block (2016, ·, 0) on a 64-chunk lap",
    );
    voxel.reset();
    equal(voxel.getChunk(63, 4, 0), null, "…and gone after it (the old world cannot leak into the new one)");
  } finally {
    setWorldChunks(before.x, before.z); // EVERY later group assumes the default lap
  }
  equal(worldChunksX(), 32, "the lap is back to the default for the rest of the gate");
  equal(setWorldChunks(32, 32), false, "…and setting the size it already has reports NO change (a free re-entry)");

  // 3. THE RENDER HALF: a size change throws every mesh and every "decided" answer away, or the new world would
  //    be drawn with the old lap's geometry. Driven on a real stream — and `pendingCount` must see work again
  //    afterwards, because that is what puts the loading screen up for the new world instead of showing stale
  //    terrain for a frame.
  const P = loadPresentation();
  const { ChunkStreamSystem } = load("plugins/render/systems/chunk-stream.js");
  const world = new World();
  world.insertResource(VOXEL, new VoxelWorld());
  world.insertResource(LOCAL_PLAYER, localPlayer);
  const cache = P.createChunkMeshCache({ add() {}, remove() {} });
  world.insertResource(P.CHUNK_MESHES, cache);
  world.insertResource(P.CHUNK_MATERIAL, P.createChunkMaterial());
  world.insertResource(FADE_OPTIONS, createFadeOptions());
  world.insertResource(KEY_EVENTS, createKeyEventLog());
  // A fake mesher that always produces faces: the real one answers 0 for a uniform chunk, and this section is
  // about the cache being emptied, not about what the terrain happens to be there.
  let gen = 0;
  const factory = {
    createGeometry: () => ({
      geometry: { dispose() {}, morphAttributes: {} },
      specs: [],
      apply: () => 5,
      rebuild: () => 5,
      restyle: () => 1,
      dispose() {},
    }),
    getMaterial: () => fakeChunkMaterial({ shared: true, gen: ++gen }),
  };
  const stream = new ChunkStreamSystem(world, factory);
  stream.step();
  assert(cache.meshes.size > 0, `the stream built meshes (${cache.meshes.size})`);
  stream.resetForNewWorld();
  equal(cache.meshes.size, 0, "a world-size change leaves no mesh behind");
  equal(stream.pendingCount() > 0, true, "…and the window counts as WORK again, so the entry shows its screen");

  // 4. THE WIRING, as source text (the shape the fades and the diagnostic log are checked with): the entry
  //    APPLIES the size before it asks anything, and the value travels root -> resource -> command -> file.
  const entry = strip(readSrc("src/boot/drivers/world-entry.ts"));
  assert(
    /if \(setWorldChunks\(wanted\.chunksX, wanted\.chunksZ\)\)/.test(entry) &&
      /resource\(VOXEL\)\.reset\(\)/.test(entry) &&
      /resetForNewWorld\(\)/.test(entry),
    "the world entry sets the lap and resets the voxel map AND the meshes when it changed",
  );
  assert(
    entry.indexOf("setWorldChunks(") < entry.indexOf("needsWarmUp("),
    "…BEFORE it asks whether the window needs warming (the answer must be yes for a new lap)",
  );
  const mainSrc = strip(readSrc("src/boot/main.ts"));
  assert(
    /const worldSize: WorldSizeState = createWorldSize\(readSettings\(\)\.worldXZ\);/.test(mainSrc) &&
      /world\.insertResource\(WORLD_SIZE, worldSize\)/.test(mainSrc),
    "the composition root loads the lap from the settings file into the resource the driver reads",
  );
  assert(
    /world\.commands\.send\(SetWorldSize, \{ chunksX: chunks \}\)/.test(mainSrc) &&
      /saveSettings\(\{ worldXZ: chunks \}\)/.test(mainSrc) &&
      /s\.worldXZ = justSet\.worldXZ \?\? worldSize\.chunksX;/.test(mainSrc),
    "a choice goes through the COMMAND, is HANDED to the save, and is persisted",
  );
  assert(
    /worldXZ: deps\.world\.resource\(WORLD_SIZE\)\.chunksX,/.test(strip(readSrc("src/boot/drivers/startup.ts"))),
    "the boot settings check carries it in its schema",
  );
  const genView = strip(readSrc("src/plugins/ui/views/mainmenu.ts"));
  assert(
    /main\.genSize\.\$\{preset\}/.test(genView) && /SOURCE_WORLD_SIZE/.test(genView),
    "the world-type panel offers the presets AND a slider bound to the value in force",
  );
  for (const lang of ["zh", "en", "ja"]) {
    const dict = JSON.parse(
      require("node:fs").readFileSync(
        path.join(ROOT, "packs", "VoxelEngineNWWebrp", "assets", "voxel", "lang", `${lang}.json`),
        "utf8",
      ),
    );
    for (const key of ["main.xzTitle", "main.xzHint"]) {
      assert(typeof dict[key] === "string" && dict[key].length > 0, `${key} is translated (${lang})`);
    }
  }
});

check("LOD is a LADDER, not two rings (P2.03): the rungs tile, nest, and each one reserves the next", () => {
  // The window used to be exactly two rings. It is a LADDER now: rung 1 is the fine ring, rung L has
  // `step = 2^(L-1)` and reaches the same number of its OWN columns out, and every rung's hole is exactly the
  // coverage of the rung inside it — which is what makes each rung the next finer rung's READY RESERVE (P2.00),
  // generalised. HOW MANY rungs exist is the LAP's business (`lodLadder`), so a default 1024-block world shows
  // two and a 16384-block one shows six. This group asserts the ladder as DATA and then drives a real 3-rung
  // stream through a handover at TWO different rungs, because "it works at step 2" was never the question.
  const L = load("data/world/lod.js");
  const { ChunkStreamSystem } = load("plugins/render/systems/chunk-stream.js");
  const { CHUNK_SIZE } = load("data/world/chunk.js");
  const { VoxelWorld } = load("data/world/world.js");
  const P = loadPresentation();

  // 1. THE LADDER AS A FUNCTION OF THE LAP. The five presets are the sizes the world-type panel offers, and the
  //    rung count per size is the promise the entry driver logs; the cap is the policy's.
  const rungs = WORLD_SIZE_PRESETS.map((preset) => L.lodLadder(L.DEFAULT_LOD, preset, 0, 0).length);
  equal(rungs.join(","), "2,3,4,5,6", "each preset lap holds one more rung than the one below it");
  equal(L.lodLadder(L.DEFAULT_LOD, WORLD_CHUNKS_MIN * 16, 0, 0).length, L.DEFAULT_LOD.tiers, "…up to the cap");
  equal(L.lodLadder({ tiers: 2, reach: 6 }, WORLD_CHUNKS_MAX, 0, 0).length, 2, "a shallower policy is capped too");
  for (const [lap, tiers] of [
    [31, 2],
    [32, 2],
    [64, 3],
    [128, 4],
    [256, 5],
    [512, 6],
  ]) {
    equal(L.lodLadder(L.DEFAULT_LOD, lap, 0, 0).length, tiers, `a ${lap}-chunk lap holds ${tiers} rung(s)`);
  }
  // …and the count does NOT depend on where the window sits: a rung that appeared and vanished as the player
  // walked would rebuild the outer ring every few steps. The fit rule carries the half-cell wobble for that.
  for (const lap of WORLD_SIZE_PRESETS) {
    const counts = new Set();
    for (const c of [0, 1, 3, 7, 15, 31, 63, 100, 255]) {
      counts.add(L.lodLadder(L.DEFAULT_LOD, lap, c * 32, c * 32 + 32).length);
    }
    equal(counts.size, 1, `a ${lap}-chunk lap holds the same number of rungs wherever the window is`);
  }

  // 2. EVERY RUNG, as data (the window's centre on the origin, where the two axes are identical): the step
  //    doubles, the hole IS the inner rung's coverage (in BLOCKS, the only unit two rungs agree on), the
  //    annulus is `reach` cells wide, and the radii grow.
  const LADDER = L.lodLadder(L.DEFAULT_LOD, WORLD_CHUNKS_MAX, 0, 0);
  equal(LADDER.length, L.DEFAULT_LOD.tiers, `the whole shipped ladder is there (${LADDER.length})`);
  equal(LADDER[0].reach, L.DEFAULT_LOD.reach, "rung 1 IS the fine ring: the policy's reach…");
  equal(LADDER[0].hole, 0, "…and no hole at all");
  equal(LADDER[0].x.lo, -L.DEFAULT_LOD.reach, "…covering the window symmetrically");
  let lastRadius = 0;
  for (let i = 0; i < LADDER.length; i++) {
    const tier = LADDER[i];
    equal(tier.step, 2 ** i, `rung ${i + 1} has step ${2 ** i}`);
    equal(tier.reach, L.DEFAULT_LOD.reach, "…whose annulus is `reach` of its own cells wide");
    for (const axis of ["x", "z"]) {
      const span = tier[axis];
      if (i === 0) {
        equal(span.holeHi - span.holeLo, 0, "the fine ring has no reserve at all");
        equal(span.hi - span.lo, 2 * tier.reach, "…and its coverage is `reach` cells each way");
        continue;
      }
      // The ANNULUS, per side: `reach` cells, one fewer where the tiling crop took a cell away (the rung inside
      // gives up whatever the next rung's grid cuts in half).
      const low = span.holeLo - span.lo;
      const high = span.hi - span.holeHi;
      assert(
        (low === tier.reach || low === tier.reach - 1) && (high === tier.reach || high === tier.reach - 1),
        `${axis}: the annulus is ${tier.reach} cells wide, ±1 for the crop (it is ${low}/${high})`,
      );
    }
    equal(
      tier.hole,
      Math.max(tier.x.holeHi - tier.x.holeLo, tier.z.holeHi - tier.z.holeLo),
      "the reported hole is the wider axis' (the lap test answers for the widest part of the rung)",
    );
    if (i > 0) {
      const innerX = LADDER[i - 1].x;
      const innerZ = LADDER[i - 1].z;
      const innerStep = LADDER[i - 1].step;
      equal(
        (tier.x.holeHi - tier.x.holeLo) * tier.step,
        (innerX.hi - innerX.lo) * innerStep,
        `rung ${i + 1} x: its hole IS rung ${i}'s coverage, in fine chunks`,
      );
      equal(
        (tier.z.holeHi - tier.z.holeLo) * tier.step,
        (innerZ.hi - innerZ.lo) * innerStep,
        `rung ${i + 1} z: its hole IS rung ${i}'s coverage, in fine chunks`,
      );
    }
    const radius = Math.max(-tier.x.lo, tier.x.hi) * tier.step * 32;
    assert(radius > lastRadius, `rung ${i + 1} reaches further out than the one inside it (${radius} blocks)`);
    lastRadius = radius;
  }
  equal(lastRadius, 7168, "the outermost rung reaches 7 × 1024 = 7168 blocks (224 chunks), exactly");
  assert(L.lodTierFits(LADDER[LADDER.length - 1], WORLD_CHUNKS_MAX), "…which is just inside the biggest lap's half");
  assert(!L.lodTierFits({ step: 64, hole: 0, reach: 8 }, WORLD_CHUNKS_MAX), "…and one rung further would not be");

  // 3. THE RUNGS TILE — asserted over the REAL sets the stream builds (`wantedKeys`/`farKeys`), for every
  //    parity of the player column, for a window whose two axes sit on DIFFERENT alignments (which makes a
  //    rung's coverage a rectangle), and for a policy that crops. Two rings used to be checked (`tile()` in the
  //    LOD group); this is the general statement: inside the outermost reach, every FINE column is claimed by
  //    exactly ONE rung — no see-through gap, no z-fighting overlap, which is what a symmetric range left at
  //    every boundary (the P1.94 bug, generalised).
  const claimOf = () => {
    let overlaps = 0;
    const owner = new Map();
    const claim = (x, z) => {
      const k = `${x},${z}`;
      if (owner.has(k)) overlaps++;
      owner.set(k, 1);
    };
    return { owner, claim, overlaps: () => overlaps };
  };
  for (const policy of [
    { tiers: 2, reach: 2 },
    { tiers: 6, reach: 4 },
    { tiers: 6, reach: 5 },
    { tiers: 4, reach: 3 },
  ]) {
    for (const [rawX, rawZ] of [[0, 0], [1, 0], [2, 2], [3, 7], [7, 3], [8, 8], [100, 101], [101, 100], [251, 252]]) {
      const baseX = L.fineBase(policy, rawX);
      const baseZ = L.fineBase(policy, rawZ);
      const ladder = L.lodLadder(policy, WORLD_CHUNKS_MAX, baseX * 32, baseZ * 32);
      const outer = ladder[ladder.length - 1];
      const ccx = Math.floor(baseX / outer.step);
      const ccz = Math.floor(baseZ / outer.step);
      const t = claimOf();
      const first = ladder[0];
      for (let dx = first.x.lo; dx < first.x.hi; dx++) {
        for (let dz = first.z.lo; dz < first.z.hi; dz++) t.claim(baseX + dx, baseZ + dz);
      }
      for (let i = 1; i < ladder.length; i++) {
        const tier = ladder[i];
        const tx = Math.floor(baseX / tier.step);
        const tz = Math.floor(baseZ / tier.step);
        for (let cx = tier.x.lo; cx < tier.x.hi; cx++) {
          for (let cz = tier.z.lo; cz < tier.z.hi; cz++) {
            if (!L.inTierAnnulus(tier, cx, cz)) continue;
            for (let dx = 0; dx < tier.step; dx++) {
              for (let dz = 0; dz < tier.step; dz++) {
                t.claim((tx + cx) * tier.step + dx, (tz + cz) * tier.step + dz);
              }
            }
          }
        }
      }
      let gaps = 0;
      const x0 = (ccx + outer.x.lo) * outer.step;
      const x1 = (ccx + outer.x.hi) * outer.step;
      const z0 = (ccz + outer.z.lo) * outer.step;
      const z1 = (ccz + outer.z.hi) * outer.step;
      for (let x = x0; x < x1; x++) {
        for (let z = z0; z < z1; z++) if (!t.owner.has(`${x},${z}`)) gaps++;
      }
      equal(gaps, 0, `reach ${policy.reach} at ${rawX},${rawZ}: no fine column is drawn by NEITHER rung`);
      equal(t.overlaps(), 0, `reach ${policy.reach} at ${rawX},${rawZ}: none is drawn by BOTH rungs`);
      equal(t.owner.size, (x1 - x0) * (z1 - z0), `reach ${policy.reach} at ${rawX},${rawZ}: the union is exact`);
    }
  }
  equal(L.tierOfStep(LADDER, 4)?.step, 4, "a step names its rung…");
  equal(L.tierOfStep(LADDER, 3), null, "…and a step no rung has names nothing");
  assert(
    L.LOD_TIER_TINT.length >= L.DEFAULT_LOD.tiers &&
      new Set(LADDER.map((tier) => L.tierTint(tier.step))).size === LADDER.length,
    "the debug view has a colour per rung the shipped ladder can have",
  );

  // 4. A REAL 3-RUNG STREAM. The lap is 64 chunks so rung 3 fits (`2·4 < 32`), and the policy is the smallest
  //    one the check can drive: rung 1 = fine columns [-2,2), rung 2 = step 2 (hole 1), rung 3 = step 4
  //    (hole 1 = rung 2's whole coverage, in blocks).
  const policy = { tiers: 3, reach: 2 };
  const world = new World();
  const voxel = new VoxelWorld();
  world.insertResource(VOXEL, voxel);
  world.insertResource(LOCAL_PLAYER, localPlayer);
  const positionRow = entityIndex(localPlayer);
  const startX = C.POSITION.x[positionRow];
  const startZ = C.POSITION.z[positionRow];
  const cache = P.createChunkMeshCache({ add() {}, remove() {} });
  world.insertResource(P.CHUNK_MESHES, cache);
  world.insertResource(P.CHUNK_MATERIAL, P.createChunkMaterial());
  world.insertResource(FADE_OPTIONS, createFadeOptions());
  world.insertResource(KEY_EVENTS, createKeyEventLog());
  world.start();
  let gen = 0;
  const factory = {
    createGeometry: () => ({
      geometry: { dispose() {}, morphAttributes: {} },
      specs: [],
      apply: () => 5,
      rebuild: () => 5,
      restyle: () => 1,
      dispose() {},
    }),
    getMaterial: () => fakeChunkMaterial({ shared: true, gen: ++gen }),
  };
  const before = { x: worldChunksX(), z: worldChunksZ() };
  try {
    setWorldChunks(64);
    const stream = new ChunkStreamSystem(world, factory, null, policy);
    // Fill the whole window: every rung's COVERAGE (annulus + hole), over the whole Y range. The FIRST step is
    // the one that builds the ladder and the key sets, so it is taken before anything is asserted about them.
    stream.step(1000);
    for (let i = 0; i < 400 && stream.pendingCount() > 0; i++) stream.step(1000);
    equal(stream.lodTiers, 3, "the stream really runs three rungs on a 64-chunk lap");
    const columns = worldChunksX(); // X and Z share the lap
    const wrap = (step, v) => {
      const period = columns / step;
      return ((v % period) + period) % period;
    };
    // THE LADDER, REBUILT WHERE THE WINDOW IS — exactly what the stream does when the window moves: the cells
    // are aligned to the WORLD, so WHICH of them cover the window changes as the player walks.
    const ladderNow = () => L.lodLadder(policy, columns, stream.lastPcx * CHUNK_SIZE, stream.lastPcz * CHUNK_SIZE);
    const ccOf = (step) => [Math.floor(stream.lastPcx / step), Math.floor(stream.lastPcz / step)];
    const decidedColumns = (step) => {
      const out = new Set();
      const prefix = step === 1 ? "" : `${step}:`;
      for (const key of [...cache.meshes.keys(), ...cache.empty.keys()]) {
        if (!key.startsWith(prefix)) continue;
        const parts = key.slice(prefix.length).split(",");
        out.add(`${parts[0]},${parts[2]}`);
      }
      return out;
    };
    const farPending = () => {
      let n = 0;
      for (const key of stream.farWanted) if (!cache.meshes.has(key) && !cache.empty.has(key)) n++;
      return n;
    };
    const KEY_Y = 8; // CHUNK_Y_COUNT: the world's Y split is not what this group is about
    for (let i = 0; i < 4000 && farPending() > 0; i++) stream.step(0);
    equal(farPending(), 0, "every rung's build set is BUILT (the drawn annulus AND the reserve)");
    // The far builds ran with a ZERO delta (the window fill above), so their fades-in never advanced — and a
    // rung's reserve must stay drawn while the rung inside it is still translucent. Two real-delta steps let
    // them finish, which is the state a player is in a moment after the world appears.
    stream.step(1000);
    stream.step(1000);
    for (let i = 1; i < ladderNow().length; i++) {
      const tier = ladderNow()[i];
      const [ccx, ccz] = ccOf(tier.step);
      const decided = decidedColumns(tier.step);
      assert(columns / tier.step > tier.x.hi - tier.x.lo, `rung ${i + 1}'s coverage cannot wrap onto itself`);
      let built = 0;
      for (let cx = tier.x.lo; cx < tier.x.hi; cx++) {
        for (let cz = tier.z.lo; cz < tier.z.hi; cz++) {
          if (!L.inTierCoverage(tier, cx, cz)) continue;
          const key = `${wrap(tier.step, ccx + cx)},${wrap(tier.step, ccz + cz)}`;
          assert(decided.has(key), `rung ${i + 1} decided its cell ${cx},${cz} (the reserve included)`);
          built++;
        }
      }
      equal(built, (tier.x.hi - tier.x.lo) * (tier.z.hi - tier.z.lo), `rung ${i + 1} covers its whole rectangle`);
    }

    // 5. WITH THE WINDOW WARM, EVERY RUNG'S RESERVE IS INVISIBLE AND ITS ANNULUS DRAWN — the state a player
    //    stands in, checked per rung rather than only for step 2 (P2.00 asserted it for the shipped ring only).
    /** The mesh keys of the cells a predicate picks out of a rung, at the window's current position. */
    const cellKeys = (tier, predicate) => {
      const [ccx, ccz] = ccOf(tier.step);
      const keys = [];
      for (let cx = tier.x.lo; cx < tier.x.hi; cx++) {
        for (let cz = tier.z.lo; cz < tier.z.hi; cz++) {
          if (!predicate(tier, cx, cz)) continue;
          for (let cy = 0; cy < KEY_Y; cy++) {
            const key = `${tier.step}:${wrap(tier.step, ccx + cx)},${cy},${wrap(tier.step, ccz + cz)}`;
            if (cache.meshes.has(key)) keys.push(key);
          }
        }
      }
      return keys;
    };
    for (let i = 1; i < ladderNow().length; i++) {
      const tier = ladderNow()[i];
      const drawn = cellKeys(tier, L.inTierAnnulus);
      const reserve = cellKeys(tier, L.inTierHole);
      assert(reserve.length > 0, `rung ${i + 1} really keeps a reserve (${reserve.length} meshes)`);
      equal(
        reserve.filter((key) => cache.meshes.get(key).mesh.visible).length,
        0,
        `rung ${i + 1}: NONE of its reserve is drawn while the finer rungs are there`,
      );
      assert(drawn.length > 0, `rung ${i + 1} draws its annulus (${drawn.length} meshes)`);
      equal(
        drawn.filter((key) => !cache.meshes.get(key).mesh.visible).length,
        0,
        `rung ${i + 1}: …and everything outside its hole is drawn`,
      );
    }

    // 6. THE HANDOVER AT *TWO* RUNGS. Move one whole cell of rung 2 (2 fine chunks), then one whole cell of
    //    rung 3 (4 fine chunks). For each: the cells its hole GIVES UP were the RESERVE (already built, hidden)
    //    and are DRAWN in the very step they leave the hole (no frame with nothing behind the fine mesh), and
    //    the cells its hole CLAIMS stay drawn until the finer chunks that replace them are built AND opaque.
    //    That is P2.00's property, per rung — and rung 3's finer rung is rung 2, so it drives the
    //    coarser-than-step-2 path `finerColumnDecided` had never been through.
    /** The ABSOLUTE cells of a rung's hole: the two frames differ between positions, so the comparison has to be
     *  made in world cells rather than in either one's offsets. */
    const holeCells = (tier) => {
      const [ccx, ccz] = ccOf(tier.step);
      const out = [];
      for (let cx = tier.x.holeLo; cx < tier.x.holeHi; cx++) {
        for (let cz = tier.z.holeLo; cz < tier.z.holeHi; cz++) out.push(`${ccx + cx},${ccz + cz}`);
      }
      return out;
    };
    const keysOfCells = (tier, cells) => {
      const keys = [];
      for (const cell of cells) {
        const [ax, az] = cell.split(",").map(Number);
        for (let cy = 0; cy < KEY_Y; cy++) {
          const key = `${tier.step}:${wrap(tier.step, ax)},${cy},${wrap(tier.step, az)}`;
          if (cache.meshes.has(key)) keys.push(key);
        }
      }
      return keys;
    };
    for (const index of [1, 2]) {
      const before = ladderNow()[index];
      const beforeCell = Math.floor(stream.lastPcx / before.step); // READ NOW: `ccOf` would answer post-move
      const holeBefore = holeCells(before);
      const built = new Set(cache.meshes.keys());
      const reserve = keysOfCells(before, holeBefore);
      assert(reserve.length > 0, `rung ${index + 1}: its hole has meshes (${reserve.length})`);
      for (const key of reserve) {
        assert(built.has(key), `rung ${index + 1}: …and they were the RESERVE, built before the move`);
        assert(cache.meshes.get(key).mesh.visible === false, `rung ${index + 1}: …invisible while they covered it`);
      }
      C.POSITION.x[positionRow] += before.step * CHUNK_SIZE; // one cell of THIS rung
      stream.step(0);
      const after = ladderNow()[index];
      equal(
        Math.floor(stream.lastPcx / after.step),
        beforeCell + 1,
        `rung ${index + 1}: the window moved one of its cells`,
      );
      const holeAfterCells = holeCells(after);
      const holeAfter = new Set(holeAfterCells);
      const leaving = holeBefore.filter((cell) => !holeAfter.has(cell));
      const entering = holeAfterCells.filter((cell) => !holeBefore.includes(cell));
      assert(leaving.length > 0, `rung ${index + 1}: the move retires cells from its hole (${leaving.length})`);
      assert(entering.length > 0, `rung ${index + 1}: …and claims others (${entering.length})`);
      equal(
        keysOfCells(before, leaving).filter((key) => !cache.meshes.get(key).mesh.visible).length,
        0,
        `rung ${index + 1}: the cells that LEFT the hole are DRAWN in that same step (no hole behind them)`,
      );
      equal(
        keysOfCells(after, entering).filter((key) => !cache.meshes.get(key).mesh.visible).length,
        0,
        `rung ${index + 1}: …and the ones it CLAIMED are still drawn while the finer chunks are not there`,
      );
      for (let i = 0; i < 400 && (stream.pendingCount() > 0 || farPending() > 0); i++) stream.step(1000);
      stream.step(1000); // the swap waits for OPAQUE, not just present: let the finer fades finish
      stream.step(1000);
      const now = ladderNow()[index];
      const stillHole = holeCells(now).filter((cell) => !holeBefore.includes(cell));
      equal(
        keysOfCells(now, stillHole).filter((key) => cache.meshes.get(key).mesh.visible).length,
        0,
        `rung ${index + 1}: …and hidden only once the finer chunks are there AND opaque`,
      );
    }
  } finally {
    C.POSITION.x[positionRow] = startX;
    C.POSITION.z[positionRow] = startZ;
    C.PREV_POSITION.x[positionRow] = startX;
    C.PREV_POSITION.z[positionRow] = startZ;
    setWorldChunks(before.x, before.z); // every later group assumes the default lap
  }
});

check("the chunk stream can say whether a window still needs warming", () => {
  // The world-entry screen is only honest if it covers real work, and a RE-entry into a window that is
  // still built has none: `needsWarmUp` is what keeps that from being a one-frame flash of the screen.
  // Driven on a stub voxel whose chunks are all AIR (getChunk -> null), so no mesh is ever built and
  // the mesher's material �?which needs a DOM �?is never touched.
  const { ChunkStreamSystem } = load("plugins/render/systems/chunk-stream.js");
  const P = loadPresentation();
  const streamWorld = new World();
  streamWorld.insertResource(VOXEL, {
    ensureChunk() {},
    getChunk: () => null,
    isSolid: () => false,
    takeDirty: () => [],
  takeStale: () => [], // P1.49ab: the pack reload's budgeted queue
  markAllStale: () => 0,
  });
  // The player HANDLE from the world above: resources are per World, and the POSITION column is shared
  // per definition (a second World may not INSERT a component �?the one-World rule �?but the chunk
  // stream only reads the row).
  streamWorld.insertResource(LOCAL_PLAYER, localPlayer);
  // The mesh CACHE is the CHUNK_MESHES resource, not a private field, so the gate inserts a stub one
  // (a plain object stands in for the parent THREE.Group). That seam is the point of the change: this
  // system is driven here with no GPU at all.
  const meshCache = P.createChunkMeshCache({ add() {}, remove() {} });
  streamWorld.insertResource(P.CHUNK_MESHES, meshCache);
  // The shared chunk material is a RESOURCE too, so it is inserted here �?a stub with a null material,
  // which is never reached because this world is all AIR and builds no mesh at all.
  streamWorld.insertResource(P.CHUNK_MATERIAL, P.createChunkMaterial());
  streamWorld.insertResource(FADE_OPTIONS, createFadeOptions());
  streamWorld.insertResource(KEY_EVENTS, createKeyEventLog());
  const stream = new ChunkStreamSystem(streamWorld);

  assert(stream.needsWarmUp(1, 3), "a window that has never been built needs warming");
  stream.prime(1, 3);
  // What `warmUp` does, without the per-batch yields: a sync loop the gate can run.
  for (let i = 0; i < 500 && stream.pendingCount() > 0; i++) stream.step();
  equal(stream.pendingCount(), 0, "every chunk in the window is decided");
  // …and WHERE the decision is remembered is the resource: the cache is the world's, not the system's.
  equal(meshCache.meshes.size, 0, "an all-air world builds no mesh");
  assert(meshCache.empty.size > 0, "the 'no geometry' answers were written into the world's cache");
  equal(stream.needsWarmUp(1, 3), false, "…so a re-entry into THIS window shows no screen");
  assert(stream.needsWarmUp(900, 900), "a window somewhere else still needs one");
  // …AND WITH LOD ON IT MUST STILL BE ABLE TO ANSWER (P2.03). The ladder and the window's offsets are built for
  // a POSITION now (the rungs' cells are aligned to the world, the ranges covering the window are not), and the
  // entry asks this question BEFORE anything has stepped — a query that read the empty ladder would answer
  // "nothing to build" for a cold world, which is a world entered with no loading screen and no primed chunks
  // (`prime` lives inside the branch this gates).
  const lodStream = new ChunkStreamSystem(streamWorld, undefined, null, { tiers: 2, reach: 2 });
  // A COLD column — one the stub cache above never touched (its window wrapped around column 0) and one the
  // ladder's own window does not wrap onto: the answer must be "yes" before any step has run, which is the whole
  // point — the ladder and the offsets have to be built BY the question.
  assert(lodStream.needsWarmUp(528, 528), "a COLD window with LOD on needs warming before anything has stepped");
  equal(lodStream.lodTiers, 2, "…and answering it built the ladder");
  for (let i = 0; i < 500 && lodStream.pendingCount() > 0; i++) lodStream.step();
  equal(lodStream.pendingCount(), 0, "…and the window at the player (which the first step re-centred on) is decided");
  equal(lodStream.needsWarmUp(1, 3), false, "…so a re-entry there shows no screen");
  assert(lodStream.lodTiers >= 2, `…and the ladder is still there (${lodStream.lodTiers} rungs)`);
  // (read directly: the section's `readSource`/`stripComments` helpers are defined further down)
  // The entry driver lives in boot/drivers/ (P1.18e), so this reads THAT file: it asks the question
  // about the position it is entering.
  const mainSrc = require("node:fs").readFileSync(path.join(ROOT, "src", "boot", "drivers", "world-entry.ts"), "utf8");
  assert(
    /needsWarmUp\(deps\.spawn\.x, deps\.spawn\.z\)/.test(mainSrc),
    "…and the entry driver asks exactly that question, about the position it is entering",
  );
});

// ===== 5. the UI widget layer =====
console.log("\n--- the UI widget layer: theme, prefabs, migrated surfaces ---");

const readSource = (rel) => require("node:fs").readFileSync(path.join(ROOT, rel), "utf8");
const countOf = (s, re) => (s.match(re) || []).length;
/** Comments document what was removed ("the reconciler replaced onLangChange"), so a source-text
 *  assertion has to look at CODE —otherwise the note explaining the migration fails the migration. */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

check("the theme is the ONLY place a colour literal lives", () => {
  const theme = readSource("src/data/assets/theme.ts");
  assert(countOf(theme, /#[0-9a-fA-F]{3,8}\b/g) > 0, "the theme defines the colours");
  for (const rel of [
    "src/plugins/ui/components.ts",
    "src/data/globals/actions.ts",
    "src/plugins/ui/systems/reconcile.ts",
    // …and every MIGRATED surface, which is what makes the rule worth having: the menus used to carry
    // 45 + 21 literals between them.
    "src/plugins/ui/views/hud.ts",
    "src/plugins/ui/views/menu.ts",
    "src/plugins/ui/views/mainmenu.ts",
    // …and the three UI systems the surfaces migrated INTO: a colour literal there would be just as
    // wrong as one in a view (they write widget data; the theme owns every colour).
    "src/plugins/ui-debug/systems/picker.ts",
    "src/plugins/ui-toast/systems/toast.ts",
    "src/plugins/ui-keybind/systems/keybind.ts",
  ]) {
    equal(
      countOf(stripComments(readSource(rel)), /#[0-9a-fA-F]{3,8}\b|rgba?\(/g),
      0,
      `${rel} must not carry a colour literal`,
    );
  }
  // and the composition root must actually register it, or the reconciler throws at boot
  assert(/insertResource\(UI_THEME/.test(readSource("src/boot/main.ts")), "main.ts registers UI_THEME");
});

check("every recipe resolves to a style, and state changes it", () => {
  const { recipeStyle, defaultUiTheme } = load("data/assets/theme.js");
  const theme = defaultUiTheme();
  const recipes = [
    "text.label",
    "loading.root",
    "loading.title",
    "loading.status",
    "loading.track",
    "loading.segment",
    "loading.note",
    "loading.noteText",
    "hud.crosshair",
    "hud.crosshairH",
    "hud.crosshairV",
    "hud.toast",
    "debug.panel",
    "debug.line",
    "picker.panel",
    "picker.row",
    "picker.title",
    "picker.item",
    // The menu/settings/keyboard/inventory roles. `recipeStyle` has no default branch, so a role that
    // is declared in the union but missing from the table would return undefined and land in cssText
    // as the string "undefined" —this list is what makes that loud.
    "menu.root",
    "menu.backdrop",
    "menu.backdropImage",
    "menu.panel",
    "menu.title",
    "menu.subTitle",
    "menu.btn",
    "menu.stack",
    "settings.panel",
    "settings.panelWide",
    "settings.panelXl",
    "settings.title",
    "settings.label",
    "settings.value",
    "settings.range",
    "settings.columns",
    "settings.column",
    "settings.columnLabel",
    "settings.pageFill",
    "settings.btn",
    "settings.btnSolid",
    "settings.btnRow",
    "settings.choice",
    "settings.scrollArea",
    "settings.row",
    "settings.rowName",
    "settings.rowMeta",
    "settings.optRow",
    "settings.rowCtl",
    "settings.rowBtn",
    "settings.rowChoice",
    "settings.list",
    "settings.catcher",
    "settings.empty",
    "kb.board",
    "kb.hint",
    "kb.flex",
    "kb.keys",
    "kb.side",
    "kb.sideTitle",
    "kb.chips",
    "kb.chip",
    "kb.row",
    "kb.key",
    "kb.keycap",
    "kb.keyLegend",
    "kb.bottom",
    "kb.title",
    "kb.tower",
    "kb.mouse",
    "kb.numpad",
    "inv.hotbar",
    "inv.panel",
    "inv.inner",
    "inv.grid",
    "inv.title",
    "inv.cell",
    "inv.slot",
    "inv.icon",
    "inv.count",
  ];
  for (const recipe of recipes) {
    assert(recipeStyle(recipe, { selected: false }, theme).length > 8, `${recipe} produced no style`);
  }
  assert(
    recipeStyle("picker.item", { selected: true }, theme) !==
      recipeStyle("picker.item", { selected: false }, theme),
    "selection must change the item's style",
  );
  // The loading bar is filled by DATA (`active` per segment), so its role has to answer to that
  // state �?otherwise the loading bar would draw the same face filled and empty.
  assert(
    recipeStyle("loading.segment", { active: true }, theme) !==
      recipeStyle("loading.segment", { active: false }, theme),
    "an engaged segment must look different from an empty one",
  );
});

// ONE widget World for every check in this section: component storage lives on the definition, so a
// second World claiming UI_TREE would throw (see the one-World rule above).
const widgetWorld = new World();
/** The widget layer, for every check in this section (the prefabs, the components, the setters) */
const W = load("plugins/ui/components.js");
// The tree's creation counter is a RESOURCE now (it used to be a module-level `let`, i.e. shared by every
// World): it has to be inserted before the first spawn, exactly as main.ts does.
widgetWorld.insertResource(W.UI_ORDER, W.createUiOrder());
// …and so is the UI layer's PAINT state (element tables + the per-surface "last written" caches), which
// the reconciler and the widget-data systems resolve in their constructors.
const PAINT = load("data/globals/paint.js");
widgetWorld.insertResource(PAINT.UI_PAINT, PAINT.createUiPaint(C.INVENTORY_SLOTS));

check("widget prefabs build the tree the reconciler expects", () => {
  const W = load("plugins/ui/components.js");
  const uiWorld = widgetWorld;
  const panel = W.spawnPanel(uiWorld, null, "picker.panel", { hidden: true });
  const row = W.spawnPanel(uiWorld, panel, "picker.row");
  const label = W.spawnLabel(uiWorld, row, "picker.item", "mode.walk");

  equal(uiWorld.get(panel, W.UI_TREE).parent, 0, "a root's parent is NULL_ENTITY");
  equal(uiWorld.get(label, W.UI_TREE).parent, row, "the label's parent is the row");
  equal(uiWorld.get(label, W.UI_LOOK).recipe, "picker.item", "the recipe is carried through");
  equal(uiWorld.get(label, W.UI_TEXT).key, "mode.walk", "the label text is the i18n KEY");
  equal(uiWorld.get(label, W.UI_TEXT).raw, false, "…not a literal");
  equal(uiWorld.get(panel, W.UI_STATE).hidden, true, "the panel starts hidden");
  // creation order ascends, which is what lets the reconciler append parents before children
  assert(uiWorld.get(panel, W.UI_TREE).order < uiWorld.get(row, W.UI_TREE).order, "parent before row");
  assert(uiWorld.get(row, W.UI_TREE).order < uiWorld.get(label, W.UI_TREE).order, "row before label");
  equal(uiWorld.query(W.UI_TREE).length, 3, "the query the reconciler iterates finds all three");

  // the writers are plain field writes, so a system may call them (iron rule 1)
  W.setUiSelected(uiWorld, label, true);
  equal(uiWorld.get(label, W.UI_STATE).selected, true, "selection is data");
  W.setUiVisible(uiWorld, row, false);
  equal(uiWorld.get(row, W.UI_STATE).hidden, true, "visibility is data, not a marker");
  W.setUiText(uiWorld, label, "42", true);
  equal(uiWorld.get(label, W.UI_TEXT).raw, true, "a raw writer switches to a literal");
  equal(uiWorld.get(label, W.UI_TEXT).key, "42", "…and stores it verbatim");

  // ── A POOL ROW MUST BE SPAWNED **WITH** A TEXT (P1.49ag, shipped broken and reported by hand: "the three
  // language rows show no text"). This is the one mistake a POOL invites and nothing else catches: the rows
  // exist, they are visible, they are clickable — and they are empty, because `spawnButton` attaches UI_TEXT
  // only when it is GIVEN a text and `setUiText` on a widget without that component is a silent no-op. The
  // writer that is supposed to fill the row later therefore does NOTHING, with no error anywhere.
  const noText = W.spawnButton(uiWorld, null, "settings.choice", "check.pool", "0");
  const emptyKey = W.spawnButton(uiWorld, null, "settings.choice", "check.pool", "1", "");
  equal(uiWorld.has(noText, W.UI_TEXT), false, "a button spawned with no text argument has NO UI_TEXT");
  W.setUiText(uiWorld, noText, "lang.zh");
  equal(uiWorld.has(noText, W.UI_TEXT), false, "…so filling it later is a no-op: the silent trap");
  equal(uiWorld.has(emptyKey, W.UI_TEXT), true, "…while an EMPTY key is enough to own the component");
  W.setUiText(uiWorld, emptyKey, "lang.zh");
  equal(uiWorld.get(emptyKey, W.UI_TEXT).key, "lang.zh", "…and the pool row is filled afterwards");
  // …and the probes GO AWAY again: the next group mounts this same world's widgets and finds them by RECIPE
  // (`elOf("settings.choice")`), so a leftover probe would be the first choice button it found, not its own.
  uiWorld.despawn(noText);
  uiWorld.despawn(emptyKey);
});

check("the reconciler writes the DOM from data: no wipe of a recipe, and a scroll list starts at the top", () => {
  // The reconciler writes a few LONGHANDS (background-image, background-color, justify-content) after
  // the recipe's cssText. A longhand write deletes the same property out of the shorthand the recipe
  // used, and for a <button> that means falling back to the browser's own face —which is how every
  // button and choice in the menus turned light grey (white) until the pointer touched it. This runs
  // the real system against a minimal DOM stub and asserts the two halves of the rule.
  const W = load("plugins/ui/components.js");
  const { UiRenderSystem } = load("plugins/ui/systems/reconcile.js");
  const { defaultUiTheme, UI_THEME, recipeStyle } = load("data/assets/theme.js");
  const { createUiActions, onUiAction, UI_ACTIONS } = load("data/globals/actions.js");
  const P = loadPresentation();

  const made = [];
  const mkEl = (tag = "div") => {
    const el = {
      tagName: tag.toUpperCase(),
      children: [],
      parentElement: null,
      dataset: {},
      style: {},
      textContent: "",
      title: "",
      value: "",
      scrollWidth: 0,
      clientWidth: 0,
      scrollTop: 0,
      /** Listeners by type. The delegation check reads these: a widget element must have NONE. */
      listeners: {},
      /** What `<input type=range>` reports on an `input` event �?read off the widget's own element. */
      get valueAsNumber() {
        return Number(this.value);
      },
      appendChild(child) {
        child.parentElement = el;
        this.children.push(child);
        return child;
      },
      remove() {},
      contains(node) {
        let n = node;
        while (n) {
          if (n === el) return true;
          n = n.parentElement;
        }
        return false;
      },
      addEventListener(type, fn) {
        (this.listeners[type] ??= []).push(fn);
      },
    };
    el.style.cssText = "";
    el.style.setProperty = (name, value) => {
      el.style[name] = value;
    };
    made.push(el);
    return el;
  };

  const previousDocument = globalThis.document;
  const mount = mkEl();
  // The document ROOT: the reconciler applies the GLOBAL STYLE to it (the font pair + the root font size),
  // because the config modules do not apply themselves any more. Count the writes �?the point is that it
  // writes what CHANGED and nothing per frame (which is what lets the resize callback go away).
  const root = mkEl();
  let rootVarWrites = 0;
  let rootFontSizeWrites = 0;
  let rootFontSize = "";
  let fontUi = "a-ui";
  let rootPx = 16;
  const rootSetProperty = root.style.setProperty;
  root.style.setProperty = (name, value) => {
    rootVarWrites++;
    rootSetProperty(name, value);
  };
  Object.defineProperty(root.style, "fontSize", {
    get: () => rootFontSize,
    set: (value) => {
      rootFontSize = value;
      rootFontSizeWrites++;
    },
  });
  globalThis.document = {
    createElement: (tag) => mkEl(tag),
    elementFromPoint: () => null,
    documentElement: root,
  };
  try {
    // The SAME World the prefab check used (one World per component definition).
    const world = widgetWorld;
    world.insertResource(UI_THEME, defaultUiTheme());
    world.insertResource(UI_ACTIONS, createUiActions());
    // The mount root is a RESOURCE (ecs/presentation.ts) now, so it is inserted rather than passed:
    // `uiStage` in the real game, this stub element here.
    world.insertResource(P.UI_MOUNT, mount);
    const system = new UiRenderSystem(world, {
      translate: (key) => key,
      fontCss: () => ({ ui: fontUi, mono: "a-mono" }),
      rootFontPx: () => rootPx,
    });

    const plain = W.spawnButton(world, null, "settings.btn", "check.a", "", "label");
    const icon = W.spawnPanel(world, null, "inv.icon", { image: { url: "", scrim: false } });
    const choice = W.spawnButton(world, null, "settings.choice", "check.b", "v", "label", {
      image: { url: "", scrim: false },
    });
    system.step();

    // ── the GLOBAL STYLE is the reconciler's, and it writes it on CHANGE ───────────────────────────
    // The font pair and the root font size used to be applied by ui/fonts.ts and ui/uiscale.ts
    // themselves: a DOM write from outside any system, unconditional per call, and re-run on every
    // resize. They publish the VALUE now and the reconciler diffs it �?which is exactly why the
    // resize callback could be deleted.
    equal(root.style["--font-ui"], "a-ui", "the font pair reaches the document root");
    equal(rootFontSize, "16px", "…and so does the root font size");
    const styleWrites = rootVarWrites + rootFontSizeWrites;
    system.step();
    equal(rootVarWrites + rootFontSizeWrites, styleWrites, "unchanged values are not rewritten every frame");
    fontUi = "b-ui";
    rootPx = 24;
    system.step();
    equal(root.style["--font-ui"], "b-ui", "a font switch lands on the next frame");
    equal(rootFontSize, "24px", "…and a scale change with it");
    equal(rootVarWrites + rootFontSizeWrites, styleWrites + 2, "…writing what changed, and nothing else");
    // A resize is the same story: the value is recomputed from the live window every frame, so nothing
    // has to be notified of it. Only the new number is written.
    rootPx = 32;
    system.step();
    equal(rootFontSize, "32px", "a resize reaches the root without any resize handler");
    equal(rootVarWrites + rootFontSizeWrites, styleWrites + 3, "…as one write");

    const elOf = (recipe) => made.find((el) => el.dataset.uiRecipe === recipe);
    const plainEl = elOf("settings.btn");
    assert(!!plainEl, "the button was mounted");
    // Ask the THEME for the value instead of pinning a literal: P1.49f replaced the solid #444444 chip
    // with a darkened translucent tint (the settings screen has no card behind its options any more),
    // and the RULE under test is that the recipe background survives the longhand writes below - not
    // which colour the palette happens to use.
    const plainBg = /(?:^|;)background:([^;]+)/.exec(recipeStyle("settings.btn", {}, defaultUiTheme()))[1];
    assert(
      plainEl.style.cssText.includes("background:" + plainBg),
      "its recipe background is on the element",
    );
    // The write must not have happened at all for a widget with no image slot. `undefined` is the
    // stub's way of saying "never assigned"; a real element would keep the shorthand's colour.
    equal(plainEl.style.backgroundColor, undefined, "no backgroundColor was written over it");

    const iconEl = elOf("inv.icon");
    equal(iconEl.style.backgroundColor, "", "a widget WITH an image slot does get its tint written");

    // Second half: a tint must survive the next cssText rewrite (a state change rewrites it).
    W.setUiImage(world, choice, "", false, "#123456");
    system.step();
    const choiceEl = elOf("settings.choice");
    equal(choiceEl.style.backgroundColor, "#123456", "the tint is written");
    W.setUiSelected(world, choice, true); // changes the recipe's style -> cssText is rewritten
    system.step();
    // Same rule for the SELECTED face: ask the theme, because P1.49f turned the accent into an alpha
    // tint (rgba) so the frosted backdrop keeps showing through the selected option.
    const selBg = /(?:^|;)background:([^;]+)/.exec(
      recipeStyle("settings.choice", { selected: true }, defaultUiTheme()),
    )[1];
    assert(choiceEl.style.cssText.includes("background:" + selBg), "the selected style was rewritten");
    equal(choiceEl.style.backgroundColor, "#123456", "…and the data tint was re-applied after it");

    // …and the image URL itself, with the theme's scrim on top of it.
    W.setUiImage(world, icon, "data:image/png;base64,AAAA", false);
    system.step();
    assert(/^url\("data:/.test(iconEl.style.backgroundImage), "the icon URL is written as a url()");
    W.setUiImage(world, choice, "data:image/png;base64,AAAA", true);
    system.step();
    assert(
      /^linear-gradient\(/.test(choiceEl.style.backgroundImage),
      "scrim = the theme's gradient in front of the URL",
    );

    // A slider's RANGE has to reach the element, not just its value. The component carries min/max/step
    // and the element used to keep the browser's defaults (0..100, step 1) —which is why a 30..240
    // step-2 slider showed "100" at its far end, moved in ones, and could never reach the value its own
    // label reads as "unlimited".
    const slider = W.spawnSlider(world, null, "settings.range", "check.slider", "", {
      min: 30,
      max: 240,
      step: 2,
      initial: 60,
    });
    system.step();
    const sliderEl = elOf("settings.range");
    assert(!!sliderEl, "the slider was mounted");
    equal(sliderEl.min, "30", "min reached the element");
    equal(sliderEl.max, "240", "…and max");
    equal(sliderEl.step, "2", "…and step");
    equal(sliderEl.value, "60", "…and the value");
    assert(slider, "the slider entity exists");

    // ── a scrollable ROLE starts at the TOP on every visit, and its position is NOT recorded ───────
    // What it must NOT do is what the previous attempt did: write a shared offset into a hidden subtree
    // (a `display:none` box cannot hold one) while marking it "applied", so the list that came back was
    // the one that had been at the top and the two settings panels disagreed. The rule is an EDGE �?the
    // frame a list (or the PANEL around it) becomes visible �?and nothing else touches the position.
    const capPanel = W.spawnPanel(world, null, "settings.panelXl", { hidden: true });
    const capA = W.spawnPanel(world, capPanel, "kb.chips"); // inside a hidden PANEL, itself visible
    const capB = W.spawnPanel(world, null, "kb.chips"); // an independent second instance
    system.step();
    const elA = made.filter((el) => el.dataset.uiRecipe === "kb.chips")[0];
    const elB = made.filter((el) => el.dataset.uiRecipe === "kb.chips")[1];
    assert(!!elA && !!elB, "two instances of the scrollable role are mounted");
    equal(elA.scrollTop, 0, "a list behind a hidden panel starts at the top");

    // Scrolling it �?by any means �?is NOT recorded and NOT undone while the panel stays up: the list
    // the user scrolled stays where the user put it.
    elA.scrollTop = 40;
    elB.scrollTop = 12;
    system.step();
    equal(elA.scrollTop, 40, "a scroll while the panel is up is left alone");
    equal(elB.scrollTop, 12, "…and the two instances do NOT follow each other");

    // A whole PANEL disappears through its own flag, never through the list's: the edge has to see the
    // ancestor, or the next visit keeps the old position.
    W.setUiVisible(world, capPanel, false);
    system.step();
    elA.scrollTop = 40; // what a hidden box may keep, or may be reset to �?either way it is stale
    W.setUiVisible(world, capPanel, true);
    system.step();
    equal(elA.scrollTop, 0, "coming back from a hidden ANCESTOR panel returns the list to the top");
    equal(elB.scrollTop, 12, "…and the other instance is not touched by it");

    // …and it is an EDGE, not a per-frame write: the frame after the reset leaves it alone.
    elA.scrollTop = 7;
    system.step();
    equal(elA.scrollTop, 7, "the reset does not repeat every frame");

    // A recipe the theme does NOT list as scrollable is never touched.
    equal(plainEl.scrollTop, 0, "a non-scrollable recipe keeps its own (untouched) position");
    assert(capA && capB && capPanel, "the list entities exist");

    // ── the DELEGATED events: one listener per TYPE on the mount root, none per widget ─────────────
    // Six listeners used to be attached to every widget at mount time (click, input, mouseenter,
    // mouseleave, mousedown, mouseup) �?six closures each, none of them enumerable from outside. The
    // reconciler listens to the mount root now and finds the widget by walking up from `ev.target`;
    // hover is an ancestor-chain DIFF, because mouseenter/mouseleave do not bubble. Both halves are
    // asserted on the same stub DOM.
    const actions = world.resource(UI_ACTIONS);
    const fired = [];
    onUiAction(actions, "check.delegated", (value) => fired.push(value));
    onUiAction(actions, "check.moved", (value) => fired.push(`moved:${value}`));
    const mark = made.length;
    const btn = W.spawnButton(world, null, "settings.btn", "check.delegated", "v1");
    const btnLabel = W.spawnLabel(world, btn, "settings.btnRow", "check.label");
    const slider2 = W.spawnSlider(world, null, "settings.range", "check.moved", "", {
      min: 0,
      max: 10,
      step: 1,
      initial: 3,
    });
    system.step();
    const [btnEl2, labelEl2, sliderEl2] = made.slice(mark);
    assert(!!btn && !!btnLabel && !!slider2, "the delegated widgets exist");
    assert(!!btnEl2 && !!labelEl2 && !!sliderEl2, "…and were mounted");
    equal(
      made.slice(mark).reduce((n, el) => n + Object.keys(el.listeners).length, 0),
      0,
      "no widget element carries a listener of its own",
    );
    equal(
      Object.keys(mount.listeners).sort().join(","),
      "click,input,mousedown,mouseout,mouseover,mouseup",
      "the mount root owns one listener per delegated type",
    );

    /** Bubble one synthetic event from `target` up to (and including) the mount root. `detail` is the
     *  click COUNT: >= 1 is a real press/release (Chromium's own synthesis from mousedown+mouseup
     *  included), 0 is what TAB+ENTER/SPACE �?and a programmatic `.click()` �?produce. */
    const fire = (type, target, relatedTarget = null, detail = 1) => {
      const ev = { type, target, relatedTarget, detail };
      let node = target;
      while (node) {
        for (const fn of node.listeners[type] ?? []) fn(ev);
        if (node === mount) break;
        node = node.parentElement;
      }
    };

    // A click on a LABEL inside the button resolves to the button (the walk up from ev.target).
    fire("click", labelEl2);
    equal(fired.join(","), "v1", "a click on a child label reaches the button's action");
    // A click on a SLIDER dispatches nothing: it reports through `input` (the test `wire()` made).
    fire("click", sliderEl2);
    equal(fired.join(","), "v1", "a click on a slider is not a click action");
    // …and its `input` carries the value, read off the widget's OWN element.
    sliderEl2.value = "7";
    fire("input", sliderEl2);
    equal(fired.join(","), "v1,moved:7", "a slider reports the value it was moved to");

    // KEYBOARD activation is DROPPED. A widget element is focusable, so TAB then ENTER (or SPACE) fires a
    // `click` with `detail === 0` �?the UI is mouse-driven, and the filter lives on the EVENT, so a real
    // press/release (which carries the click count) is untouched.
    const dispatched = fired.length;
    fire("click", labelEl2, null, 0);
    equal(fired.length, dispatched, "a keyboard-generated click (detail 0) does NOT dispatch");
    fire("click", labelEl2, null, 1);
    equal(fired.length, dispatched + 1, "…while a real press/release still does");
    fire("click", labelEl2, null, 2);
    equal(fired.length, dispatched + 2, "…a double click included");

    // HOVER: entering the label hovers the button above it�?
    const idle = btnEl2.style.cssText;
    fire("mouseover", labelEl2);
    system.step();
    assert(btnEl2.style.cssText !== idle, "hovering a child shades the button above it");
    // …leaving the tree (no mouseover inside it, and the new target is not ours) clears it.
    fire("mouseout", btnEl2, null);
    system.step();
    equal(btnEl2.style.cssText, idle, "leaving the tree takes the shade back");

    // PRESS: down on the label presses the button, and ANY release inside the tree ends it �?the
    // per-widget listener only heard a release on the widget itself, so a press that ended elsewhere
    // stayed pressed until the pointer left and came back.
    fire("mousedown", labelEl2);
    system.step();
    assert(btnEl2.style.cssText !== idle, "pressing the child presses the button");
    fire("mouseup", mount);
    system.step();
    equal(btnEl2.style.cssText, idle, "a release anywhere in the tree ends the press");
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }

  // …and the SOURCE says the same thing: every listener is on the mount root, none on a widget.
  const reconcilerSrc = stripComments(readSource("src/plugins/ui/systems/reconcile.ts"));
  equal(
    countOf(reconcilerSrc, /element\.addEventListener|addEventListener\("mouseenter"|addEventListener\("mouseleave"/g),
    0,
    "the reconciler attaches nothing to a widget element",
  );
  assert(/this\.mountRoot\.addEventListener\("click"/.test(reconcilerSrc), "the click listener is on the mount root");
  assert(/if \(ev\.detail === 0\) return;/.test(reconcilerSrc), "a keyboard-generated click is dropped");
  assert(/addEventListener\("mouseover"/.test(reconcilerSrc) && /diffHover\(/.test(reconcilerSrc),
    "hover is an ancestor-chain diff over the bubbling mouseover");
});

check("a delayed intent is DATA with a deadline, applied by a system �?never a timer", () => {
  // Four `setTimeout`s used to be the only way this process could say "in a moment": closing the backpack
  // relocking the mouse, the lock manager's 1300 ms retry, and the cursor re-asserts after the window
  // regained focus (0/120 ms) or after the menu/Apps key (0/32/80 ms). Each was a timer owned by whichever
  // module wanted it. The DEADLINE is a resource now, which is what makes the timing assertable at all �?
  // the gate drives the clock instead of sleeping through it.
  const R = load("data/globals/resources.js");
  const { DelaySystem, DELAYS_ACCESS } = load("plugins/ui/systems/delays.js");

  let now = 1000;
  const queue = R.createDelayedIntents(() => now);
  equal(queue.pending, 0, "nothing is pending at the start");
  queue.schedule("cursor", 0);
  queue.schedule("cursor", 32);
  queue.schedule("cursor", 80);
  queue.schedule("lockRetry", 1300, "world entered");
  equal(queue.pending, 4, "four intents armed");
  equal(queue.takeDue().map((i) => i.at - 1000).join(","), "0", "a 0 ms intent is due AT its deadline");
  now = 1032;
  equal(queue.takeDue().map((i) => i.kind).join(","), "cursor", "the 32 ms one is due at 32 ms");
  now = 1079;
  equal(queue.takeDue().length, 0, "…and the 80 ms one is not early");
  now = 1080;
  equal(queue.takeDue().length, 1, "…and it is due at 80 ms");
  equal(queue.pending, 1, "the 1300 ms retry is still waiting");
  now = 2300;
  equal(
    queue.takeDue().map((i) => `${i.kind}:${i.arg}`).join(","),
    "lockRetry:world entered",
    "the retry carries the reason it was asked for",
  );
  equal(queue.pending, 0, "the queue drains");

  // A deadline is not early: the comparison is `at <= now`, and not a frame before it.
  let tick = 2000;
  const notYet = R.createDelayedIntents(() => tick);
  notYet.schedule("relock", 100, "inventory E");
  tick = 2099;
  equal(notYet.takeDue().length, 0, "a deadline is not early");
  tick = 2100;
  equal(notYet.takeDue().length, 1, "…and fires the moment it is reached");

  // The cap: the menu/Apps key schedules four re-asserts per press (keydown AND keyup), so the queue must
  // not grow without limit. At the cap the FURTHEST deadline goes �?the urgent re-asserts are the ones
  // that win the cursor race.
  for (let i = 0; i < R.DELAY_QUEUE_CAP + 8; i++) queue.schedule("cursor", 0);
  equal(queue.pending, R.DELAY_QUEUE_CAP, "the queue is capped");
  equal(queue.takeDue().length, R.DELAY_QUEUE_CAP, "…and still delivers every slot it kept");

  // The system applies them through the INJECTED effects, in deadline order, once per step.
  const world = new World();
  const appliedQueue = R.createDelayedIntents(() => now);
  world.insertResource(R.DELAYED_INTENTS, appliedQueue);
  const seen = [];
  const system = new DelaySystem(world, {
    relock: (reason) => seen.push(`relock:${reason}`),
    lockRetry: (source) => seen.push(`retry:${source}`),
    cursor: () => seen.push("cursor"),
    log: () => {},
  });
  system.step();
  equal(seen.length, 0, "an empty queue applies nothing");
  appliedQueue.schedule("relock", 0, "inventory E");
  appliedQueue.schedule("cursor", 0);
  appliedQueue.schedule("lockRetry", 1300, "menu resume");
  system.step();
  equal(seen.join(","), "relock:inventory E,cursor", "only what is due fires, in deadline order");
  equal(system.appliedCount, 2, "…and it is counted");
  now += 1300;
  system.step();
  equal(seen.join(","), "relock:inventory E,cursor,retry:menu resume", "the retry fires past its deadline");
  equal(system.pendingCount, 0, "nothing is left waiting");

  // What it declares is what forces the order in the ui lane: it writes ui.navigation's two targets.
  equal(DELAYS_ACCESS.writesExternal.join(","), "pointerLock,cursor", "it declares the targets it writes");
  // …and the modules that used to own a timer do not any more. THIS is the regression the group exists
  // for: a `setTimeout` returning anywhere on this path puts "when does this happen" back outside the
  // world, where the schedule cannot see it and a paused game still runs it.
  for (const rel of [
    "src/host/browser/pointerlock.ts",
    "src/host/browser/window-guards.ts",
    "src/plugins/ui/systems/delays.ts",
  ]) {
    equal(countOf(stripComments(readSource(rel)), /setTimeout|setInterval/g), 0, `${rel} still owns a timer`);
  }
});

check("the pack page's live listing lists the folder WITHOUT applying it (P1.49ad)", () => {
  // The pack screen follows the folder while it is open (a pack dropped in appears, a deleted one goes), and the
  // whole point is that looking at the list is not a decision: the listing path walks NAMES and COUNTS only —
  // Rust's list_packs opens no file — and it must NEVER install a chain, or opening the page (or adding a file
  // to a pack) would reload the world behind the player's back. Applying stays the reload driver's job.
  const tex = stripComments(readSource("src/data/assets/textures.ts"));
  const fn = tex.slice(tex.indexOf("export function updatePackListing"));
  assert(fn.length > 0, "the listing-only entry exists");
  assert(!/installPacks\(/.test(fn.slice(0, 1400)), "…and it does NOT install a chain (that would APPLY the pack)");
  assert(/resourcepackInfos\.length = 0/.test(fn.slice(0, 1400)), "…it replaces the listing");
  const rust = readSource("src-tauri/src/packs.rs");
  assert(/pub fn listing\(/.test(rust), "the Rust side lists the folders");
  assert(!/fs::read\(/.test(rust.slice(rust.indexOf("pub fn listing("))), "…without opening a single file");
  assert(/fn list_packs\(/.test(readSource("src-tauri/src/lib.rs")), "…and it is exposed as its own command");
  const boot = stripComments(readSource("src/boot/main.ts"));
  const reload = stripComments(readSource("src/boot/drivers/pack-reload.ts"));
  assert(/packReload\.maybePollListing\(\)/.test(boot), "the loop asks the driver for a listing each frame");
  assert(/settings !== "pack"/.test(reload), "…and the driver polls only while that settings page is up");
  assert(/notifyConfigChange\("packs"\)/.test(reload), "…announcing a change so the open page re-renders");
});

check("the icon cache has a synchronous reader, and both readers agree on the key", () => {
  // The inventory draws the icon IMMEDIATELY when it is already baked; that is what keeps a stack move
  // from painting one frame of the placeholder. It can only do that if the cache is readable without a
  // promise —and only correctly if the peek builds the same key the bake wrote.
  const icons = load("host/browser/blockicons.js");
  const P = loadPresentation();
  // The bake's state is a RESOURCE (ecs/presentation.ts::ICON_BAKE): the two readers operate on it, so
  // they can be driven here with no GPU and no browser �?the renderer is created on the first real bake.
  const bake = P.createIconBake();
  const gen = load("data/assets/textures.js").packChainGeneration();
  equal(icons.iconCacheKey("stone", 40), `${gen}|stone@40`, "the key is <chain generation>|type@size");
  equal(icons.iconCacheKey("stone", 40.4), `${gen}|stone@40`, "…with the size rounded");
  equal(icons.iconCacheKey("stone", 20), `${gen}|stone@32`, "…and clamped up to MIN_SIZE");
  equal(icons.iconCacheKey("stone", 1000), `${gen}|stone@256`, "…and down to MAX_SIZE");
  // A NEW CHAIN MUST INVALIDATE WHAT THE OLD ONE PRODUCED (P1.49ac). Two independent halves, and BOTH are silent
  // when missing: the KEY has to carry the chain generation (so a bake that was in flight when the chain changed
  // cannot land on the new one — same key, older pixels — and a stale hit is impossible), and the reload driver
  // has to clear the CONSUMERS' memory, because `ui.inventory` redraws a slot only when its signature changes
  // and that signature holds no icon (so a cleared cache alone is never read again).
  assert(/chainGeneration \+= 1/.test(stripComments(readSource("src/data/assets/textures.ts"))),
    "installing a chain bumps the generation");
  assert(/`\$\{packChainGeneration\(\)\}/.test(stripComments(readSource("src/host/browser/blockicons.ts"))),
    "…and the icon key is built from it");
  const reloadDriver = stripComments(readSource("src/boot/drivers/pack-reload.ts"));
  assert(/inventoryPaint\.drawn\.fill\("\\u0000"\)/.test(reloadDriver),
    "the reload clears the inventory's reconcile memory (or the slot is never drawn again)");
  assert(/notifyConfigChange\("packs"\)/.test(reloadDriver),
    "…and tells the surfaces that LIST the chain (the settings panel's pack rows)");
  equal(icons.clampIconSize(40.4), 40, "the bake size comes from the same function");
  // Nothing is baked in this process, so this is a pure miss that never touches the GPU.
  equal(icons.peekBlockIcon(bake, "stone", 40), null, "an unbaked icon peeks as null");
  equal(icons.peekBlockIcon(bake, "stone", 1000), null, "…and a clamped request misses too");
  // The two must not be able to drift apart.
  const source = readSource("src/host/browser/blockicons.ts");
  assert(/iconCacheKey\(type, size\)/.test(source), "the bake keys through iconCacheKey");
  assert(/cache\.get\(iconCacheKey\(type, sizePx\)\)/.test(source), "peekBlockIcon reads that same key");
  // Item 1 of the presentation-state pass: the bake's completion may NOT write a component. It used to
  // backfill the slot's UI_IMAGE from a `.then` continuation, i.e. a component write with no lane around
  // it (and a frame could be painted from it at any point). The system asks for the bake and reads the
  // cache on its next run instead.
  const invSource = stripComments(readSource("src/plugins/ui-inventory/systems/inventory.ts"));
  assert(!/\.then\(/.test(invSource), "the inventory draws the icon from the cache, not from a promise");
  // Since P1.18b the icon baker is INJECTED (a plugin may not import `host/`), so the check is
  // two-sided: the system asks through its IconSource, and the composition root hands it the real one.
  // A missing wire would not crash �?it would silently ship placeholder icons �?so it is asserted.
  assert(/this\.icons\.request\(/.test(invSource), "…and asks for a bake when the cache misses");
  assert(/request: requestBlockIcon/.test(stripComments(readSource("src/boot/main.ts"))),
    "…with the real baker wired in by the composition root");
  assert(!/getBlockIcon/.test(invSource), "the promise-shaped reader is gone, not merely unused");
});

check("a bound widget takes its value from its source, not from whoever built it", () => {
  // The main menu and the pause menu each build a settings panel, so each used to hold its OWN copy of
  // the frame cap; the two drifted apart and neither was guaranteed to match the value in force. A
  // binding makes the shared state the only owner. This runs the real resolver, no DOM involved.
  const W = load("plugins/ui/components.js");
  const B = load("plugins/ui/systems/bindings.js");
  const S = load("data/globals/sources.js");
  const world = widgetWorld;
  const sources = S.createUiSources();
  world.insertResource(S.UI_SOURCES, sources);
  let cap = 0;
  S.onUiSource(sources, "fpsCap", () => (cap === 0 ? 240 : cap));

  const slider = W.spawnSlider(
    world,
    null,
    "settings.range",
    "check.cap",
    "",
    { min: 30, max: 240, step: 2, initial: 240 },
    "fpsCap",
  );
  const value = () => world.get(slider, W.UI_INPUT).value;
  const system = new B.UiBindingSystem(world, () => {});

  system.step();
  equal(value(), 240, "'unlimited' arrives as the top of the slider's own range");
  cap = 61;
  system.step();
  // The exact tie-break is not the contract �?lands ON the slider's grid, inside its range" is, and
  // that is what keeps the component and the element saying the same number.
  const snapped = value();
  assert(
    (snapped - 30) % 2 === 0 && snapped >= 30 && snapped <= 240,
    `a source value lands on the slider's grid and in its range (got ${snapped})`,
  );
  cap = 1000;
  system.step();
  equal(value(), 240, "…and is clamped to the range");
  cap = -5;
  system.step();
  equal(value(), 30, "…from below too");
  equal(system.boundCount, 1, "the resolver sees the bound widget");

  // An unregistered source is a LOUD no-op: the widget keeps its value, the log says so —once.
  const orphan = W.spawnSlider(
    world,
    null,
    "settings.range",
    "check.orphan",
    "",
    { min: 0, max: 10, step: 1, initial: 5 },
    "nope",
  );
  const logs = [];
  const reported = new B.UiBindingSystem(world, (line) => logs.push(line));
  reported.step();
  equal(world.get(orphan, W.UI_INPUT).value, 5, "an orphan binding leaves the value alone");
  equal(logs.length, 1, "…and reports the missing source");
  reported.step();
  equal(logs.length, 1, "…once, not every frame");
  equal(reported.boundCount, 2, "both bound widgets are seen");

  // The range is the widget's own business (presentation), and the resolver respects it.
  equal(W.snapToRange(63, { min: 30, max: 240, step: 2 }), 64, "snap: rounds onto the grid");
  equal(W.snapToRange(29, { min: 30, max: 240, step: 2 }), 30, "snap: clamps up");
  equal(W.snapToRange(999, { min: 30, max: 240, step: 2 }), 240, "snap: clamps down");
  equal(W.snapToRange(Number.NaN, { min: 30, max: 240, step: 2 }), 30, "snap: a NaN is not propagated");
});

check("the migrated surfaces carry no styling and no DOM of their own", () => {
  // The HUD surface, where even a language subscription is gone (its text is all keys).
  for (const rel of ["src/plugins/ui/views/hud.ts"]) {
    const code = stripComments(readSource(rel));
    equal(countOf(code, /#[0-9a-fA-F]{3,8}\b/g), 0, `${rel} still has a colour literal`);
    equal(countOf(code, /style\.cssText|document\.createElement/g), 0, `${rel} still builds DOM`);
    equal(countOf(code, /onLangChange/g), 0, `${rel} still subscribes to language changes`);
  }
  // The UI SYSTEMS the views migrated into: no DOM, no styling, and —the point of the migration —no
  // `document.addEventListener` (only the device layer listens) and no private timer for "how long".
  for (const rel of ["src/plugins/ui-debug/systems/picker.ts", "src/plugins/ui-toast/systems/toast.ts", "src/plugins/ui-keybind/systems/keybind.ts", "src/plugins/ui/systems/delays.ts"]) {
    const code = stripComments(readSource(rel));
    equal(countOf(code, /#[0-9a-fA-F]{3,8}\b|rgba?\(/g), 0, `${rel} still has a colour literal`);
    equal(countOf(code, /document\.|createElement|style\.cssText/g), 0, `${rel} still touches the DOM`);
    equal(countOf(code, /setTimeout|setInterval/g), 0, `${rel} still owns a timer`);
    equal(countOf(code, /onLangChange|onBindsChange/g), 0, `${rel} still subscribes to a change`);
  }
  // The menus and the settings panel. `onLangChange` is ALLOWED here: a label composed from a VALUE
  // ("FPS 60", "1.25x") cannot be a key, so those few still have to be re-pushed on a language switch.
  // Everything a key can express is re-derived by the reconciler instead.
  for (const rel of ["src/plugins/ui/views/menu.ts", "src/plugins/ui/views/mainmenu.ts", "src/plugins/ui-inventory/views/inventory.ts"]) {
    const code = stripComments(readSource(rel));
    equal(countOf(code, /document\.createElement\(/g), 0, `${rel} still creates an element by hand`);
    equal(countOf(code, /style\.cssText/g), 0, `${rel} still writes an inline style string`);
    equal(countOf(code, /\.textContent\s*=/g), 0, `${rel} still writes text into an element`);
    equal(countOf(code, /\.style\.background|\.style\.outline/g), 0, `${rel} still styles on hover`);
    // `style.display` is allowed ONLY on the drag rubber band (a pointer overlay, not widget
    // structure): anywhere else it would mean a surface is using CSS as its own state again.
    const displayUsers = [...code.matchAll(/([A-Za-z_$][\w$]*)\.style\.display/g)].map((m) => m[1]);
    assert(
      displayUsers.every((name) => name === "svg"),
      `${rel} uses display as state (${displayUsers.join(", ") || "none"})`,
    );
  }
  // …and they compose the prefabs instead
  assert(/spawnPanel\(/.test(readSource("src/plugins/ui/views/hud.ts")), "hud composes panels");
  assert(/spawnLabel\(/.test(readSource("src/plugins/ui-debug/systems/picker.ts")), "the picker composes its own labels");
  assert(/setUiVisible\(/.test(readSource("src/plugins/ui-debug/systems/picker.ts")), "…and shows/hides them as data");
  assert(/spawnButton\(/.test(readSource("src/plugins/ui/views/menu.ts")), "the settings panel composes buttons");
  assert(/spawnGridKey\(/.test(readSource("src/plugins/ui-keybind/views/keybind.ts")), "the visual keyboard composes keycaps (in the plugin that owns the page)");
  assert(/onUiAction\(/.test(readSource("src/plugins/ui/views/mainmenu.ts")), "the main menu dispatches actions");
  assert(/spawnButton\(/.test(readSource("src/plugins/ui-inventory/views/inventory.ts")), "the inventory VIEW composes slot buttons");
  assert(/setUiImage\(/.test(readSource("src/plugins/ui-inventory/systems/inventory.ts")), "…and the SYSTEM fills icon slots as data");
  equal(countOf(stripComments(readSource("src/plugins/ui-inventory/views/inventory.ts")), /setUiImage|setUiText|setUiTip|setUiSelected/g), 0,
    "the view writes no widget data any more (that is the system's job)");
});

// ===== the three UI systems the views migrated into =====

check("the F3+F4 picker is a system: key edges in, widget data and a mode change out", () => {
  // It used to be a class in ui/gamemode.ts with its own document listeners and private fields.
  const P = load("plugins/ui-debug/systems/picker.js");
  const world = widgetWorld;
  world.insertResource(PICKER_STATE, createPickerState());
  world.insertResource(KEY_EVENTS, createKeyEventLog());
  const panel = P.spawnPickerPanel(world);
  const debug = W.spawnPanel(world, null, "debug.panel", { hidden: true });
  let mode = "walk";
  const applied = [];
  /** Is a world running? false is the main menu / the loading screen, where this chord must do nothing. */
  let inWorld = true;
  const picker = new P.UiPickerSystem(world, {
    panel: panel.panel,
    items: panel.items,
    debugPanel: debug,
    readMode: () => mode,
    applyMode: (m) => {
      applied.push(m);
      mode = m;
    },
    inWorld: () => inWorld,
    inventoryOn: () => true,
    log: () => {},
  });
  const edges = world.resource(KEY_EVENTS);
  const visible = () => !world.get(panel.panel, W.UI_STATE).hidden;
  const selected = () => panel.items.map((it) => world.get(it, W.UI_STATE).selected);
  const edge = (code, down, repeat = false) => {
    publishKeyEdge(edges, { code, down, repeat });
    picker.step();
  };

  // 1. F3 alone is the DEBUG TOGGLE —not the picker. The debug panel's own widget state is the answer,
  //    so there is no `debugVisible` boolean to drift out of sync with it.
  edge("F3", true);
  equal(visible(), false, "F3 alone does not open the picker");
  equal(world.get(debug, W.UI_STATE).hidden, false, "…it shows the F3 panel");
  edge("F3", false);
  edge("F3", true);
  equal(world.get(debug, W.UI_STATE).hidden, true, "…and F3 again hides it");

  // 2. F3+F4 opens the picker on the mode in force (read through the injected reader, not a private copy).
  edge("F4", true);
  equal(visible(), true, "F3+F4 opens the picker");
  equal(selected().indexOf(true), 0, "…with the mode in force selected (walk)");

  // 3. F4 cycles while it is open; auto-repeat does not (a held F4 used to cycle at the OS repeat rate).
  const before = world.get(debug, W.UI_STATE).hidden;
  edge("F4", true, true);
  equal(selected().indexOf(true), 0, "an auto-repeat F4 does not cycle");
  edge("F4", true);
  equal(selected().indexOf(true), 1, "a fresh F4 cycles the selection");

  // 4. Releasing F3 applies the selection —through the injected mode setter, which main.ts wires to the
  //    SetMode command (deferred to the next barrier like every other outside write).
  edge("F3", false);
  equal(applied.join(","), "fly", "F3 release applies the mode");
  equal(visible(), false, "…and closes the picker");
  // The edge log is read-once-PER-CONSUMER (a cursor each: ui.navigation reads the same edges), so what
  // matters is that the consumer does not act twice on one edge.
  const appliedAfter = applied.length;
  picker.step();
  equal(applied.length, appliedAfter, "a frame with no new edges does nothing (the cursor holds)");

  // 5. …and a repeat edge never reaches the chord at all.
  edge("F3", true, true);
  equal(world.get(debug, W.UI_STATE).hidden, before, "auto-repeat does not re-toggle the F3 panel");

  // 6. OUTSIDE A WORLD none of it fires. F3 and F3+F4 are GAMEPLAY chords: at the main menu (and on the
  //    loading screen) they used to open the F3 panel �?with stale text, because its numbers come from
  //    the render lane, which does not run there �?and to switch the movement mode through SetMode, i.e.
  //    write a COMPONENT from a menu. The edges are still consumed, so nothing is replayed on entry.
  inWorld = false;
  const modeBefore = mode;
  const appliedBefore = applied.length;
  edge("F3", true);
  equal(world.get(debug, W.UI_STATE).hidden, true, "F3 does not open the F3 panel outside a world");
  edge("F4", true);
  equal(visible(), false, "F3+F4 does not open the picker outside a world");
  edge("F4", true);
  edge("F3", false);
  equal(applied.length, appliedBefore, "…and no mode change is sent");
  equal(mode, modeBefore, "…so the player's mode is untouched");
  // A panel left open by a game session is taken down when the session ends.
  inWorld = true;
  edge("F3", true); // the chord is F3+F4 in either order, and F3 alone only toggles the F3 panel
  edge("F4", true);
  equal(visible(), true, "the picker opens again in a world");
  inWorld = false;
  picker.step();
  equal(visible(), false, "leaving the world closes the picker");
  equal(world.resource(PICKER_STATE).open, false, "…and clears its state (nothing is left held)");
  equal(world.resource(PICKER_STATE).f3, false, "…including the chord keys");
  inWorld = true;
  picker.step();
  equal(visible(), false, "…so entering a world again does not resurrect the panel");
});

check("the GAMEPLAY widgets are visible only while a world runs (the crosshair and the hotbar)", () => {
  // Both were spawned VISIBLE during wiring and nothing ever wrote their flag, so they were on screen in
  // every mode: at the main menu (through its translucent backdrop), on the loading screen, and over the
  // PAUSE menu �?where the hotbar's z-index (31) is above that menu's whole root (30), so it drew on top
  // of the panel �?with its slots still clickable (a menu click could select a slot, a SetMode-free but
  // still component-writing command). `ui.hud` owns that flag and derives it from `inWorld()`.
  const H = load("plugins/ui/systems/hud.js");
  const world = widgetWorld;
  const crosshair = W.spawnPanel(world, null, "hud.crosshair"); // spawned visible, like the real ones
  const hotbar = W.spawnPanel(world, null, "inv.hotbar");
  let inWorld = true;
  let inventoryOn = true;
  world.insertResource(load("data/globals/ui-hud.js").UI_HUD_PAINTED, new Map());
  const hud = new H.UiHudSystem(world, {
    // The STATIC form (`roots`): these widgets were spawned during wiring, so the host only ADOPTS them —
    // it never builds or despawns them. The dynamic form is the next check.
    log: () => {},
    elements: () => [
      { id: "crosshair", order: 10, roots: [crosshair], gate: () => inWorld },
      { id: "hotbar", order: 20, roots: [hotbar], gate: () => inWorld && inventoryOn },
    ],
  });
  const shown = (e) => world.get(e, W.UI_STATE).hidden === false;

  equal(shown(crosshair) && shown(hotbar), true, "the widgets start visible (that is the spawn default)");
  hud.step();
  equal(shown(crosshair) && shown(hotbar), true, "…and stay so while a world runs");

  inWorld = false;
  hud.step();
  equal(shown(crosshair), false, "no world: the crosshair comes down");
  equal(shown(hotbar), false, "…and so does the hotbar");
  hud.step();
  equal(shown(hotbar), false, "a frame with no change writes nothing (idempotent)");

  inWorld = true;
  hud.step();
  equal(shown(crosshair) && shown(hotbar), true, "entering a world brings both back");

  // The system is registered in the ui lane with a declared access set, ahead of every other writer �?
  // "what may the lane show at all" comes first �?and the composition root hands it the two roots.
  const main = stripComments(readSource("src/boot/main.ts"));
  assert(/name: "ui\.hud"/.test(main) || /[\s\S]*/.test(readSource("src/plugins/ui/index.ts")), "the composition root registers ui.hud");
  const crossSrc = stripComments(readSource("src/plugins/ui-crosshair/index.ts"));
  assert(/build: \(mount\) => \[spawnCrosshair\(mount\.world\)\]/.test(crossSrc),
    "…which BUILDS the crosshair when the element is mounted (not at wiring)");
  const invPlugin = stripComments(readSource("src/plugins/ui-inventory/index.ts"));
  assert(/api\.contribute\(SLOT_UI_HUD, \[hotbar\]\)/.test(invPlugin),
    "…and the HOTBAR is the inventory plugin's OWN element (that is what makes F11 a real despawn)");
  assert(!/id: "hotbar"/.test(main), "…so the core's table no longer declares it");
  assert(!/id: "crosshair"/.test(main), "the CORE table declares no HUD element of its own any more (P1.48)");
  assert(/gate: \(\) => deps\.inWorld\(\)/.test(crossSrc), "…each gated on the one definition of \"a world is running\"");
  // The toast is deliberately NOT part of this: a main-menu message is a documented case.
  assert(!/toast/.test(stripComments(readSource("src/plugins/ui/systems/hud.ts"))), "ui.hud leaves the toast alone");
});

check("an ORDER GAP is a place, not a system (P1.42)", () => {
  // The ui lane's four `ui.slot.*` anchors were no-op SYSTEMS (reads: [UI_STATE], run: () => {}) whose only job
  // was to give an optional surface a stable slot between two systems that must not name each other. A gap is
  // that concept, without the pretence: no access, no run, and the EDGE is what splits the batch.
  const ran = [];
  const s = new Schedule();
  s.add({ name: "a", stage: "fixed", writesExternal: ["x"], run: () => ran.push("a") });
  s.add({ name: "slot", stage: "fixed", gap: true, after: ["a"], before: ["b"] });
  s.add({ name: "b", stage: "fixed", writesExternal: ["y"], run: () => ran.push("b") });
  s.resolve();
  equal(JSON.stringify(s.batchesOf("fixed").map((b) => b.map((d) => d.name))),
    JSON.stringify([["a"], ["slot"], ["b"]]),
    "a gap splits a batch even between two writers that share NO data (the edge alone does the work)");
  s.run("fixed", { world: { structuralVersion: 0 } });
  equal(ran.join(","), "a,b", "…and the gap itself never runs");
  // Alone in its batch a gap prints as its own name; SHARING one it is marked — the marker is what tells a
  // reader "this name is a place, not a worker" when a batch lists several.
  const free = new Schedule();
  free.add({ name: "a", stage: "fixed", writesExternal: ["x"], run: () => {} });
  free.add({ name: "slot", stage: "fixed", gap: true });
  free.resolve();
  equal(JSON.stringify(free.batchesOf("fixed").map((b) => b.map((d) => d.name))),
    JSON.stringify([["a", "slot"]]), "a gap with no edges shares a batch (by itself it orders nothing)");
  assert(/\(a ~ slot\*\)/.test(free.report().join("\n")), "…and the report marks it with a `*` there");
  // A def with NEITHER a run nor the gap flag is refused: "forgot the run" must not look like a deliberate gap.
  const typo = new Schedule();
  typo.add({ name: "nope", stage: "fixed" });
  let threw = false;
  try {
    typo.resolve();
  } catch {
    threw = true;
  }
  equal(threw, true, "a system with no run() and no gap flag is REJECTED at resolve");
});

check("the HUD host MOUNTS and TAKES DOWN its elements at a BARRIER (P1.34)", () => {
  // THE DEBT THE ELEMENT TABLE LEFT OPEN: an element could only be SHOWN or HIDDEN. Its widgets had to be
  // spawned by the contributing view during wiring, so a plugin installed at runtime could not add one, and an
  // uninstalled one left its widgets on screen with nobody to write them. The host owns the lifetime now:
  // `build` runs inside a barrier, `dispose` runs there too, and the widgets are DESPAWNED — the whole
  // subtree, because a despawn does not cascade.
  const H = load("plugins/ui/systems/hud.js");
  const world = widgetWorld;
  // The SHARED paint resource (the check above inserted it): cleared, because its entries are that check's
  // mounts and this host would otherwise adopt them as already mounted.
  world.resource(load("data/globals/ui-hud.js").UI_HUD_PAINTED).clear();
  const lines = [];
  let inWorld = true;
  let elements = [];
  const hud = new H.UiHudSystem(world, { elements: () => elements, log: (l) => lines.push(l) });
  const built = []; // every root a build returned, with the child it also spawned
  const disposed = [];
  const element = (id, order, extra = {}) => ({
    id,
    order,
    gate: () => inWorld,
    build: ({ world: w }) => {
      const root = W.spawnPanel(w, null, "hud.crosshair", { hidden: true });
      const child = W.spawnPanel(w, root, "hud.crosshairH");
      built.push({ root, child });
      return [root];
    },
    ...extra,
  });
  const alive = (e) => world.has(e, W.UI_STATE);
  const shown = (e) => world.get(e, W.UI_STATE)?.hidden === false;

  elements = [element("crosshair", 10, { dispose: () => disposed.push("crosshair") })];
  hud.step();
  equal(built.length, 0, "a system may not spawn: the mount is DEFERRED to the barrier");
  world.commands.flush();
  equal(built.length, 1, "…and the barrier builds it");
  equal(alive(built[0].root), true, "the element's widgets exist");
  hud.step();
  equal(shown(built[0].root), true, "…and its OWN gate decides whether they are visible");
  equal(lines[0], "HUD element mounted crosshair", "the mount is logged");

  // HOT-UNPLUG: the element is gone from the table (its plugin was uninstalled) and its widgets must go too.
  // This is the residue trap — a frozen crosshair nobody can write any more — closed for every element.
  elements = [];
  hud.step();
  equal(alive(built[0].root), true, "the despawn is deferred too (a system may not change structure)");
  world.commands.flush();
  equal(disposed.length, 1, "…the barrier disposes of the element");
  equal(alive(built[0].root), false, "…and despawns its root");
  equal(alive(built[0].child), false, "…with the whole SUBTREE (a despawn does not cascade)");
  hud.step();
  world.commands.flush();
  equal(disposed.length, 1, "…once: a frame with no change despawns nothing");

  // HOT-PLUG IT BACK: a NEW element object with the same id is built again — the host keys on the ID (the table
  // is rebuilt from the registry every frame), so a re-install is a fresh mount, not a remembered one.
  elements = [element("crosshair", 10, { dispose: () => disposed.push("crosshair2") })];
  hud.step();
  world.commands.flush();
  equal(built.length, 2, "installing it again BUILDS it again");
  equal(alive(built[1].root), true, "…with live widgets");

  // A build that throws is logged once and NOT retried (the page host learned this the hard way: an unrecorded
  // mount is retried every frame, forever).
  let attempts = 0;
  elements = [
    { id: "broken", order: 1, gate: () => true, build: () => { attempts++; throw new Error("no widgets"); } },
  ];
  hud.step();
  world.commands.flush();
  hud.step();
  world.commands.flush();
  equal(attempts, 1, "a build that fails is attempted ONCE");
  assert(lines.some((l) => /HUD element FAILED broken: no widgets/.test(l)), "…and says so");

  // The STATIC form still works: an element whose view spawned its widgets during wiring is ADOPTED.
  const adopted = W.spawnPanel(world, null, "inv.hotbar", { hidden: true });
  elements = [{ id: "hotbar", order: 20, roots: [adopted], gate: () => inWorld }];
  hud.step();
  equal(shown(adopted), true, "pre-spawned `roots` are painted without a build");
  equal(built.length, 2, "…and the host spawns nothing itself");
  equal(alive(adopted), true, "…and leaves them alive (adopted, not built)");
});

check("ESC CLOSES the settings box in one step, and its root rung is not a no-op", () => {
  // The reported bug: on the settings LIST, ESC wrote "settings" over "settings" (a no-op), and from a
  // sub-page it wrote null (skipping the list). The ladder is ONE function now (stepBackSettings), shared
  // by ESC, both menus' goBack() and the settings Back buttons.
  const N = load("plugins/ui/systems/navigation.js");
  const world = widgetWorld;
  world.insertResource(UI_MODAL, createUiModalState());
  // The hotbar keys select a slot on the LOCAL player (ui.navigation owns them now, not the inventory
  // view), so this system resolves that handle at construction.
  world.insertResource(LOCAL_PLAYER, localPlayer);
  const edges = world.resource(KEY_EVENTS); // inserted by the picker check above
  const mkPanel = (recipe) => W.spawnPanel(world, null, recipe, { hidden: true });
  const ids = ["settings", "lang", "pack", "keybind"];
  const trees = {
    pauseRoot: mkPanel("menu.root"),
    pauseMain: mkPanel("settings.panel"),
    pausePanels: Object.fromEntries([...ids, "root"].map((id) => [id, mkPanel("settings.panel")])),
    mainRoot: mkPanel("menu.backdrop"),
    mainMain: mkPanel("menu.panel"),
    genPanel: mkPanel("menu.panel"),
    mainPanels: Object.fromEntries([...ids, "root"].map((id) => [id, mkPanel("settings.panel")])),
    inventoryPanel: mkPanel("inv.panel"),
    // The DROPDOWNS (P1.49m): one list, so the painter is exercised - not just the ESC rung.
    pauseLists: [{ id: "pause.uiScale", entity: mkPanel("settings.list") }],
    // TWO entries under ONE id: the popup and its click catcher (P1.49q) - the real registration shape.
    mainLists: [
      { id: "main.uiScale", entity: mkPanel("settings.list") },
      { id: "main.uiScale", entity: mkPanel("settings.catcher") },
    ],
  };
  const effects = [];
  /** "Is a world running?" �?the ESC/inventory gate. false is the LOADING-SCREEN state (the startup and
   *  a world being built behind the screen), where neither the pause menu nor the backpack may open. */
  let inWorld = false;
  const nav = new N.UiNavigationSystem(world, {
    trees,
    inventoryCode: () => "KeyE",
    capturing: () => false,
    inWorld: () => inWorld,
    inventoryOn: () => true,
    prepareUnlock: () => effects.push("prepareUnlock"),
    releaseCapture: () => effects.push("release"),
    relock: (r) => effects.push(`relock:${r}`),
    relockSoon: (r) => effects.push(`relockSoon:${r}`),
    applyCursor: () => {},
    log: () => {},
  });
  const ui = world.resource(UI_MODAL);
  const esc = () => {
    publishKeyEdge(edges, { code: "Escape", down: true, repeat: false });
    nav.step();
  };
  const shown = (e) => world.get(e, W.UI_STATE).hidden === false;

  // ── main menu: sub-page -> settings LIST -> main panel -> stays ──
  Object.assign(ui, { mainMenu: true, menu: false, inventory: false, settings: "lang", gen: false });
  nav.step();
  assert(shown(trees.mainPanels.lang), "the language sub-panel is up");
  assert(shown(trees.mainPanels.root), "and it is inside the settings BOX (P1.49)");
  esc();
  equal(ui.settings, null, "ESC closes the settings box in ONE step (P1.49: there is no list rung to land on)");
  assert(!shown(trees.mainPanels.root) && !shown(trees.mainPanels.lang), "and the box is DOWN again, with its section");
  // A DROPDOWN is the most LOCAL rung (P1.49m): ESC closes an open list first, and the box only on the
  // next press. The list is painted from the same field, so this is one fact, not two.
  Object.assign(ui, { mainMenu: true, menu: false, settings: "settings", settingsList: "main.uiScale" });
  nav.step();
  assert(shown(trees.mainLists[0].entity), "the open row list is painted while settingsList names it");
  assert(shown(trees.mainLists[1].entity), "?and its CLICK CATCHER, registered under the same id");
  assert(!shown(trees.pauseLists[0].entity), "?and the other menu is list is not");
  esc();
  equal(ui.settingsList, null, "ESC closes the DROPDOWN first");
  equal(ui.settings, "settings", "?leaving the section it was opened in up");
  nav.step();
  assert(!shown(trees.mainLists[0].entity), "?and the list is DOWN again");
  esc();
  equal(ui.settings, null, "?and the NEXT ESC closes the box");
  esc();
  equal(ui.settings, null, "…and ESC again leaves the settings");
  assert(shown(trees.mainMain), "…back on the main menu's own panel");
  esc();
  equal(ui.mainMenu, true, "ESC at the root of the main menu does nothing (it never leaves)");

  // ── pause menu: the same ladder, then it closes and relocks ──
  Object.assign(ui, { mainMenu: false, menu: true, inventory: false, settings: "settings", gen: false });
  nav.step();
  effects.length = 0;
  esc();
  equal(ui.settings, null, "ESC on the settings LIST returns to the pause menu (this used to be a no-op)");
  assert(shown(trees.pauseMain), "…and the pause menu's main panel is painted");
  ui.settings = "pack";
  nav.step();
  esc();
  equal(ui.settings, null, "ESC from the packs section closes the box too (P1.49)");
  equal(ui.settings, null, "…then out of the settings");
  effects.length = 0;
  esc();
  equal(ui.menu, false, "…then the pause menu itself closes");
  assert(effects.includes("relock:ESC closes menu"), "…and the mouse is relocked");

  // ── the backpack closes, and in game ESC opens the pause menu (releasing + centring) ──
  Object.assign(ui, { mainMenu: false, menu: false, inventory: true, settings: null, gen: false });
  nav.step();
  effects.length = 0;
  esc();
  equal(ui.inventory, false, "ESC closes the backpack");
  assert(effects.some((e) => e.startsWith("relockSoon")), "…and relocks on the next event-loop turn");
  inWorld = true;
  effects.length = 0;
  esc();
  equal(ui.menu, true, "ESC in game opens the pause menu");
  equal(effects.join(","), "prepareUnlock,release", "…releasing the mouse (the crosshair centring is the model's job now, not a navigation effect)");

  // ── …but NOT while a loading screen is up: the startup and a world entry spend seconds in the
  // `load` mode with no modal open and no world running, and both of these used to fire there (ESC
  // opened the pause menu OVER the loading screen, E opened the backpack behind it). ──
  inWorld = false;
  Object.assign(ui, { mainMenu: false, menu: false, inventory: false, settings: null, gen: false });
  nav.step();
  effects.length = 0;
  publishKeyEdge(edges, { code: "KeyE", down: true, repeat: false });
  nav.step();
  equal(ui.inventory, false, "E does not open the backpack while a loading screen is up");
  esc();
  equal(ui.menu, false, "…and ESC does not open the pause menu there");
  equal(effects.join(","), "", "…with no pointer-lock effects at all (nothing to release yet)");
  // The step-back ladder still works in every modal state: the gate is only on those two ACTIONS.
  inWorld = false;
  Object.assign(ui, { mainMenu: true, menu: false, inventory: false, settings: "lang", gen: false });
  nav.step();
  esc();
  equal(ui.settings, null, "the main-menu ladder is unaffected by the gate");

  // …and the composition root has to SUPPLY that answer (a dep that is never injected would read as
  // undefined and refuse everything, which is the same class of miss as the screen that was never
  // activated: the system is only as good as what the wiring hands it).
  // P1.18b/P1.18c moved the systems that need it INTO the plugins, so the injection lives there now and the
  // check follows it. (It used to grep the ROOT for `inWorld,` and passed on the picker's leftover line after
  // ui.navigation had already moved into its plugin — a check that proves nothing about the system it names.)
  assert(
    /inWorld: host\.inWorld/.test(stripComments(readSource("src/plugins/ui/plugin.ts"))),
    "plugins/ui/plugin.ts injects \"is a world running\" into ui.navigation",
  );
  assert(
    /inWorld: host\.inWorld/.test(stripComments(readSource("src/plugins/ui-debug/plugin.ts"))),
    "…and plugins/ui-debug/plugin.ts injects it into the picker",
  );
});

check("the toast is a system: a command arms a wall-clock deadline, the ui lane applies it", () => {
  // `showToast()` used to write two widgets and arm a setTimeout inside the view; the message now
  // outlives its caller, which is what lets the MAIN MENU show one (nothing there reconciles a DOM write).
  const T = load("plugins/ui-toast/systems/toast.js");
  const world = widgetWorld;
  world.insertResource(TOAST, createToastState());
  const panel = W.spawnPanel(world, null, "hud.toast", { hidden: true });
  const body = W.spawnLabel(world, panel, "text.label", "");
  const toast = new T.UiToastSystem(world, panel, body);
  const visible = () => !world.get(panel, W.UI_STATE).hidden;

  equal(visible(), false, "nothing is up before a message is armed");
  const before = performance.now();
  world.commands.send(ShowToast, { key: "toast.multiPlaceholder" });
  world.commands.flush(); // the barrier: what world.render()/renderUi() run at the top of every frame
  const state = world.resource(TOAST);
  assert(state.until > before, "the command arms a deadline in the future");
  equal(state.key, "toast.multiPlaceholder", "…carrying the i18n KEY, not a finished sentence");

  toast.step();
  equal(visible(), true, "the ui lane puts it on screen");
  equal(world.get(body, W.UI_TEXT).key, "toast.multiPlaceholder", "…and the text widget holds the key");
  equal(world.get(body, W.UI_TEXT).raw, false, "…so the reconciler re-translates it on a language switch");

  state.until = performance.now() - 1; // the deadline passed (2.5 s of WALL time: paused or not)
  toast.step();
  equal(visible(), false, "…and the same system takes it down again");

  // A message that carries a VALUE ("cap set to 60") cannot be a key and goes out raw.
  world.commands.send(ShowToast, { key: "FPS 60", raw: true });
  world.commands.flush();
  toast.step();
  equal(visible(), true, "a second message shows again");
  equal(world.get(body, W.UI_TEXT).raw, true, "…as raw text");
  equal(world.get(body, W.UI_TEXT).key, "FPS 60", "…verbatim");
});

check("the key bind panels are derived data, and the drag gesture drives them", () => {
  // The panels used to own copies of the bind table and an imperative renderAllPanels() fan-out —which
  // is exactly how one instance ended up stuck while the other refreshed. Now the DATA is derived every
  // frame from one source, and the drag only publishes what it is doing.
  const K = load("plugins/ui-keybind/systems/keybind.js");
  const G = load("data/globals/keybind-gesture.js");
  const world = widgetWorld;
  const gesture = G.createKeybindGesture();
  world.insertResource(G.KEYBIND_GESTURE, gesture);

  /** One panel INSTANCE, as the pause menu and the main menu each build one. */
  const makePanel = () => {
    const root = W.spawnPanel(world, null, "settings.panel", { hidden: true });
    const chip = W.spawnButton(world, root, "kb.chip", "kb.chip", "forward", "");
    const key = W.spawnGridKey(world, root, "kb.keycap", "", "kb.key", "KeyW");
    const legend = W.spawnLabel(world, key, "kb.keyLegend", "", { raw: true });
    return {
      spec: {
        chips: [{ action: "forward", entity: chip, labelKey: "bind.forward", format: (code) => `F·${code}` }],
        keycaps: [{ code: "KeyW", key, legend, legendText: () => "W" }],
      },
      chip,
      key,
      legend,
    };
  };
  const a = makePanel();
  const b = makePanel();
  G.clearKeybindPanels();
  G.registerKeybindPanel(a.spec);
  G.registerKeybindPanel(b.spec);

  const bound = new Set(["KeyW"]);
  let capturing = null;
  // The rubber band is a WIDGET now: the system writes its UI_LAYOUT (the geometry) and its UI_STATE
  // (shown), and the reconciler paints it. `keycapAt` is the view's hit test, injected.
  const line = W.spawnLayoutBox(world, null, "kb.line", "left:0;top:0;width:0;");
  W.setUiVisible(world, line, false);
  const R = load("data/globals/resources.js");
  const pointer = R.createPointer();
  world.insertResource(R.POINTER, pointer);
  const keycapUnder = new Map([["100,200", a.key]]);
  const system = new K.UiKeybindSystem(world, {
    boundCodes: () => bound,
    capturing: () => capturing,
    bindOf: (action) => (action === "forward" ? "KeyW" : ""),
    line,
    keycapAt: (x, y) => keycapUnder.get(`${x},${y}`) ?? null,
    // The way IN to the bind page, one per settings panel: the view spawns them hidden and THIS system shows
    // them, which is what makes "the plugin is off" mean the tab is unreachable. Empty here — this check is
    // about the derivation, and the entries are asserted where the plugin is.
    entries: [],
  });

  system.step();
  equal(world.get(a.chip, W.UI_TEXT).raw, true, "an unselected chip shows a FORMATTED label");
  equal(world.get(a.chip, W.UI_TEXT).key, "F·KeyW", "…built by the surface, not by the system");
  equal(world.get(a.key, W.UI_STATE).active, true, "a bound keycap is marked active");
  equal(world.get(a.legend, W.UI_TEXT).key, "W", "the legend is the layout print");

  capturing = "forward";
  system.step();
  equal(world.get(a.chip, W.UI_TEXT).raw, false, "the selected chip shows its i18n KEY");
  equal(world.get(a.chip, W.UI_TEXT).key, "bind.forward", "…so a language switch re-translates it");
  equal(world.get(a.chip, W.UI_STATE).selected, true, "…and it is marked selected");
  equal(world.get(b.chip, W.UI_STATE).selected, true, "the SECOND instance agrees (one source, no copies)");
  equal(world.get(b.legend, W.UI_TEXT).key, "W", "…legends included");

  // The drag: the gesture says WHICH chip is being dragged and where the drag was ANCHORED; WHERE THE
  // POINTER IS comes from the POINTER resource (the device layer publishes it �?it owns the mousemove
  // listener), and the system derives the threshold, the hover target and the line's geometry from the two.
  gesture.drag = { action: "forward", button: 0, anchorX: 10, anchorY: 20, moved: false };
  pointer.x = 12;
  pointer.y = 21;
  system.step();
  equal(world.get(line, W.UI_STATE).hidden, true, "within the 6px threshold the gesture is still a click");
  pointer.x = 100;
  pointer.y = 200;
  system.step();
  equal(world.get(line, W.UI_STATE).hidden, false, "past the threshold the rubber band is SHOWN");
  const lineCss = world.get(line, W.UI_LAYOUT).css;
  assert(/left:10px;top:20px;width:201\.246/.test(lineCss), `the geometry is DATA, anchored at the drag's anchor (${lineCss})`);
  assert(/rotate\(63\.4/.test(lineCss), "…and rotated to point at the pointer");
  equal(world.get(a.key, W.UI_STATE).selected, true, "the hovered keycap is lit");

  gesture.drag = null;
  gesture.hover = null;
  system.step();
  equal(world.get(line, W.UI_STATE).hidden, true, "letting go hides the line");
  equal(world.get(a.key, W.UI_STATE).selected, false, "…and clears the highlight");
  G.clearKeybindPanels();
});

// ===== 6. the schedule: declared access, batches, commutativity =====
console.log("\n--- the schedule: access declarations, batches, commutativity ---");

/** Rebuild every registration exactly as boot/main.ts declares it: names, stages, edges, access, owner. */
function registrations() {
  // A registration lives either in the root (the ones not yet moved) or in the plugin that owns it, so the
  //  parser reads both. Same object shape in both places, which is why one regex covers them.
  const source = ["src/boot/main.ts", "src/plugins/diagnostics/index.ts", "src/plugins/player/index.ts",
    "src/plugins/render/index.ts", "src/plugins/ui/index.ts", "src/plugins/ui-debug/index.ts",
    "src/plugins/ui-keybind/index.ts", "src/plugins/ui-toast/index.ts",
    "src/plugins/ui-inventory/index.ts"]
    .map((f) => require("node:fs").readFileSync(path.join(ROOT, f), "utf8"))
    .join("\n");
  // Since P1.18 a registration goes through the plugin registry �?`contributeSystem("<plugin id>", {...})` �?
  // so the owner is captured too and a test can assert every system belongs to a plugin the manifest knows.
  const blocks = [...source.matchAll(/(?:world\.addSystem\(|contributeSystem\("([^"]+)",\s*|api\.system\()\{([\s\S]*?)\n\s*\}\);/g)]
    .map((m) => ({ owner: m[1] ?? "boot", body: m[2] }));
  if (blocks.length === 0) throw new Error("no system registration blocks found in boot/main.ts");
  const list = (text, key) => {
    const m = new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`).exec(text);
    if (!m) return undefined;
    return m[1].split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
  };
  const ACCESS = {
    SNAPSHOT_ACCESS: load("plugins/player/systems/snapshot.js").SNAPSHOT_ACCESS,
    CONTROLLER_ACCESS: load("plugins/player/systems/controller.js").CONTROLLER_ACCESS,
    MOVEMENT_ACCESS: load("plugins/player/systems/movement.js").MOVEMENT_ACCESS,
    COLLISION_ACCESS: load("plugins/player/systems/collision.js").COLLISION_ACCESS,
    INTERACTION_ACCESS: load("plugins/player/systems/interaction.js").INTERACTION_ACCESS,
    INPUT_ACCESS: load("plugins/player/systems/input.js").INPUT_ACCESS,
    CHUNK_STREAM_ACCESS: load("plugins/render/systems/chunk-stream.js").CHUNK_STREAM_ACCESS,
    DIAGNOSTICS_ACCESS: load("plugins/render/systems/diagnostics.js").DIAGNOSTICS_ACCESS,
    CAMERA_VIEW_ACCESS: load("plugins/render/systems/camera.js").CAMERA_VIEW_ACCESS,
    OUTLINE_ACCESS: load("plugins/render/systems/outline.js").OUTLINE_ACCESS,
    // M0 of the GPU route: the sampler probe. It declares the renderer and its own buffers, so it needs no
    // component — but the table is how the gate PARSES a registration, so it has to be here either way.
    LOD_PROBE_ACCESS: load("plugins/render/systems/lod-gpu-probe.js").LOD_PROBE_ACCESS,
    // M1: the PRODUCTION sampler. It reads the chunk cache (the far key set is its work list, which is also why the
    // schedule must place it after `chunk.stream`) and writes its own buffers.
    LOD_SAMPLE_ACCESS: load("plugins/render/systems/lod-gpu-sampler.js").LOD_SAMPLE_ACCESS,
MESH_PROBE_ACCESS: load("plugins/render/systems/lod-gpu-mesher-probe.js").MESH_PROBE_ACCESS,
    // ui/inventory.ts is NOT compiled by this gate (it imports the renderer), so its declared access is
    // read out of the SOURCE and mapped onto the real component objects: the schedule then sees exactly
    // what the file declares, and the source-text assertion below keeps the two honest.
    // The inventory reconcile is a SYSTEM now (ecs/ui/inventory.ts), so its declared access is loaded like
    // every other one. It used to be a method on the VIEW, which the gate could only read as source text
    // (the view imports the renderer and is not compiled here).
    INVENTORY_VIEW_ACCESS: load("plugins/ui-inventory/systems/inventory.js").INVENTORY_VIEW_ACCESS,
    UI_RENDER_ACCESS: load("plugins/ui/systems/reconcile.js").UI_RENDER_ACCESS,
    UI_BINDING_ACCESS: load("plugins/ui/systems/bindings.js").UI_BINDING_ACCESS,
    UI_PAGES_ACCESS: load("plugins/ui/systems/ui-pages.js").UI_PAGES_ACCESS,
    UI_LOADING_ACCESS: load("plugins/ui/systems/loading.js").UI_LOADING_ACCESS,
    UI_HUD_ACCESS: load("plugins/ui/systems/hud.js").UI_HUD_ACCESS,
    UI_PICKER_ACCESS: load("plugins/ui-debug/systems/picker.js").UI_PICKER_ACCESS,
    UI_TOAST_ACCESS: load("plugins/ui-toast/systems/toast.js").UI_TOAST_ACCESS,
    UI_KEYBIND_ACCESS: load("plugins/ui-keybind/systems/keybind.js").UI_KEYBIND_ACCESS,
    UI_NAVIGATION_ACCESS: load("plugins/ui/systems/navigation.js").UI_NAVIGATION_ACCESS,
    DELAYS_ACCESS: load("plugins/ui/systems/delays.js").DELAYS_ACCESS,
  };
  return blocks.map(({ owner, body: block }) => {
    const accessName = /\.\.\.([A-Z_]+_ACCESS)/.exec(block)?.[1];
    if (accessName && !ACCESS[accessName]) throw new Error(`unknown access constant ${accessName}`);
    return {
      owner,
      name: /name:\s*"([^"]+)"/.exec(block)[1],
      stage: /stage:\s*"([^"]+)"/.exec(block)[1],
      after: list(block, "after"),
      before: list(block, "before"),
      ...(accessName
        ? ACCESS[accessName]
        : {
            readsExternal: list(block, "readsExternal"),
            // A GAP is declared by a flag the parser has to CARRY (P1.42): without it the gate's model of the
            // schedule would keep treating the four `ui.slot.*` anchors as no-op systems, i.e. the report and
            // the batches it asserts would be about a schedule the game does not run.
            gap: block.includes("gap: true"),
            writesExternal: list(block, "writesExternal"),
          }),
    };
  });
}

function buildSchedule(defs, mutate) {
  const schedule = new Schedule();
  for (const def of defs) schedule.add({ ...def, run: () => {} });
  if (mutate) mutate(defs);
  schedule.resolve();
  return schedule;
}

check("the real schedule resolves into the batches the docs claim", () => {
  const schedule = buildSchedule(registrations());
  for (const line of schedule.report()) console.log("          " + line);
  const names = (stage) => schedule.batchesOf(stage).map((b) => b.map((d) => d.name));
  const expectedFixed = [
    // input drains the device events of the last frame ALONE in batch 0: it writes the VIEW the
    // controller settles and reads the ORIENTATION/POSITION the later systems write, so the conflict
    // rule orders it ahead of all of them (the edge to motion.snapshot is the declared pessimisation
    // documented in input.ts / main.ts —they commute, and it keeps the pair below intact).
    ["player.input"],
    ["motion.snapshot", "player.controller"],
    ["player.movement"],
    ["player.collision"],
    ["player.interaction"],
  ];
  // The block target wireframe joins the render producers' batch: it shares no component with them and
  // writes a target of its own (`blockOutline`), so any order among the four is correct �?and the draw,
  // which reads the scene they fill, stays in the batch after it.
  const expectedRender = [
    // `lod.gpu.probe` (M0 of the GPU route) joins them: it declares the renderer and its own scratch buffers —
    // no component, so it conflicts with nobody and the schedule keeps the batch together. `lod.gpu.meshProbe`
    // (M2a) is the same shape one milestone further along: it reads the renderer and the voxel data, writes its
    // own buffers, and shares no declared target with anything else in the lane.
    ["diagnostics", "cameraView.render", "chunk.stream", "block.outline", "lod.gpu.probe", "lod.gpu.meshProbe"],
    // `lod.gpu.sample` (M1) READS the far key set `chunk.stream` writes, so the conflict rule puts it in the batch
    // AFTER that one — and nothing orders it against the draw (it fills its own buffers, which the draw never reads),
    // so the two share this batch and either order is correct.
    ["lod.gpu.sample", "renderer.draw"],
  ];
  // The ui lane: every widget-data WRITER, then the reconciler that reads all of it. The writers are a
  // chain rather than a pair because the conflict model is per COMPONENT, not per entity —the
  // inventory, the picker, the toast and the bind panels write UI_STATE/UI_TEXT on DIFFERENT entities,
  // and the schedule cannot see that, so the order has to be declared.
  const expectedUi = [
    // The GAMEPLAY gate shares the first batch with the binding resolver: they touch DISJOINT components
    // (UI_STATE vs UI_INPUT), so the schedule says they may run in either order �?and it is right.
    // The PAGE HOST (P1.29) declares no component access — it diffs page data and defers the spawn to a
    // command — so it conflicts with nobody and lands in the first batch, next to the two systems it cannot
    // interfere with. It is declared FIRST in the lane, which is the order inside the batch.
    ["ui.pages", "ui.hud", "ui.bindings"],
    ["ui.loading"],
    ["ui.slot.bag"],
    ["ui.inventory"],
    ["ui.slot.debug"],
    ["ui.picker"],
    ["ui.slot.toast"],
    ["ui.toast"],
    ["ui.slot.keybind"],
    ["ui.keybind"],
    ["ui.navigation"],
    // The delayed intents are applied right after the systems that decide them and before the frame is
    // painted. It writes ui.navigation's two targets (`pointerLock` / `cursor`), so the conflict rule
    // FORCES the edge �?and `before: ["ui.widgets"]` is what keeps the reconciler the last system.
    ["ui.delays"],
    ["ui.widgets"],
  ];
  equal(JSON.stringify(names("fixed")), JSON.stringify(expectedFixed), "fixed batches");
  equal(JSON.stringify(names("render")), JSON.stringify(expectedRender), "render batches");
  equal(JSON.stringify(names("ui")), JSON.stringify(expectedUi), "ui batches");
});

check("renderUi() pumps the barrier + the ui lane ONLY, and render() still ends with it", () => {
  // The stopped-loop pump. Replayed on a real World: three lanes that record that they ran, so the
  // assertion covers both halves —the ui lane DOES run with no loop, and the fixed/render lanes do
  // NOT (running the render lane here would draw the world over the main-menu panorama).
  const pumped = new World();
  const ran = [];
  const Cmd = defineCommand("check-pump", () => ran.push("command"));
  pumped.addSystem({ name: "check.fixed", stage: "fixed", run: () => ran.push("fixed") });
  pumped.addSystem({ name: "check.render", stage: "render", run: () => ran.push("render") });
  pumped.addSystem({ name: "check.ui", stage: "ui", run: () => ran.push("ui") });
  pumped.start();

  pumped.commands.send(Cmd, 1);
  pumped.renderUi();
  equal(ran.join("+"), "command+ui", "the barrier ran first, then the ui lane, and nothing else");

  ran.length = 0;
  pumped.commands.send(Cmd, 1);
  pumped.render(0.5, 0.016);
  equal(ran.join("+"), "command+render+ui", "render() runs render then ui, after the same barrier");
});

check("every system that writes the DOM is in the ui lane", () => {
  // The invariant behind the regression this lane was split for: a DOM writer left in the render
  // lane stops reconciling the moment stopLoop() runs, which today is the main menu. A `dom.` target
  // is the discriminator �?framebuffer" is a canvas, not DOM.
  const dom = registrations().filter((def) =>
    (def.writesExternal ?? []).some((target) => target.startsWith("dom.")),
  );
  equal(dom.map((def) => def.name).join(","), "ui.widgets", "the systems that write DOM");
  for (const def of dom) {
    equal(def.stage, "ui", `"${def.name}" reconciles the DOM from the ui lane`);
  }
});

check("diagnostics declares every external target it actually touches", () => {
  // A system's declaration IS the scheduler's model of it, so a missing target is the one mistake the
  // conflict rule structurally cannot catch. This one used to claim only `perfSampler` while it also
  // read the input queues, the block world and the GPU timestamp, and wrote the debug log.
  const { DIAGNOSTICS_ACCESS } = load("plugins/render/systems/diagnostics.js");
  for (const target of ["inputDiagnosticQueues", "voxelBlocks", "gpuTimestamps"]) {
    assert(DIAGNOSTICS_ACCESS.readsExternal.includes(target), `readsExternal declares "${target}"`);
  }
  for (const target of ["perfSampler", "debugLog"]) {
    assert(DIAGNOSTICS_ACCESS.writesExternal.includes(target), `writesExternal declares "${target}"`);
  }
  // …and the FPS cap is NOT an external read any more: it is a resource, so the schedule does not
  // model it and listing it here would be a lie in the other direction.
  assert(!DIAGNOSTICS_ACCESS.readsExternal.includes("fpsCap"), "the frame cap is a resource now");
  // THE GPU TIMESTAMP IS SAMPLED, NOT PER FRAME (P1.88): with the display-rate limit lifted the lane draws
  // 500-650 frames a second, and a timestamp resolve per frame is a GPU sync point per frame for a number
  // printed once a second. It is throttled, and the FAST cadence is gated on the panel being visible — while the
  // hidden case still drains at `GPU_IDLE_SAMPLE_MS`, because the `FRAME` line now prints `gpu=` whether or not
  // F3 is up and an unresolved pool is what the old "Maximum number of queries exceeded" warning was about.
  const diag = stripComments(readSource("src/plugins/render/systems/diagnostics.ts"));
  assert(/const GPU_SAMPLE_MS = 250/.test(diag), "the GPU timestamp query has a sampling interval");
  assert(/panelVisible \? GPU_SAMPLE_MS : GPU_IDLE_SAMPLE_MS/.test(diag),
    "…the fast one only while the F3 panel is on screen, and a slow drain even when it is not");
  // THE PREDICATE IS `hidden === false` (P1.91 — measured bug). The HUD spawns the panel `hidden: true`
  // and ui.picker toggles that field, so `hidden !== false` is TRUE WHILE IT IS UP: the sampler was
  // skipped exactly when the panel was visible and the F3 `GPU:` number froze, while every other line
  // kept updating. ONE predicate, asked by the sampler gate AND the text writer, so they cannot drift.
  assert(/f3Visible\(\): boolean \{\s*return this\.world\.get\(this\.f3\.panel, UI_STATE\)\?\.hidden === false;/.test(diag),
    "the F3 panel's visibility is `hidden === false`, read through ONE helper");
  assert(/const panelVisible = this\.f3Visible\(\)/.test(diag) &&
    /if \(!this\.f3Visible\(\)\) return;/.test(diag),
    "…and both the sampler gate and the text writer ask that helper");
  assert(!/\?\.hidden !== false/.test(diag), "the inverted form is gone (it skipped the resolve while VISIBLE)");
});

check("the frame cap is world state AND a persisted setting", () => {
  // It used to be a closure variable in main.ts: read by the frame gate every frame (so it is world
  // state), and written by the settings panel —but never persisted, so it silently reset to
  // "unlimited" on every launch while the slider still SHOWED "unlimited", as if it had never changed.
  const R = load("data/globals/resources.js");
  equal(R.createFrameCap().cap, 0, "no value means unlimited");
  equal(R.createFrameCap(60).cap, 60, "a real cap survives");
  equal(R.createFrameCap(59.6).cap, 60, "…rounded");
  equal(R.createFrameCap(-5).cap, 0, "a negative cap from a hand-edited settings.json is refused");
  equal(R.createFrameCap(Number.NaN).cap, 0, "…and so is a non-number");
  // The cap's DOMAIN is part of the value's contract. A stored cap the slider cannot express makes the
  // label and the slider disagree �?a hand-edited `fpsCap: 1` showed "1 FPS" above a slider parked at
  // 30, and the first drag silently replaced it �?so the sanitiser clamps and snaps into it.
  equal(R.CAP_MIN, 30, "the domain's floor");
  equal(R.CAP_MAX, 240, "…its top, which means unlimited");
  equal(R.createFrameCap(1).cap, 30, "below the floor becomes the floor");
  equal(R.createFrameCap(29).cap, 30, "…including one step under it");
  equal(R.createFrameCap(30).cap, 30, "the floor itself survives");
  equal(R.createFrameCap(240).cap, 0, "the top means unlimited");
  equal(R.createFrameCap(241).cap, 0, "…and anything above it");
  equal(R.createFrameCap(9999).cap, 0, "…no matter how far above");
  equal(R.createFrameCap(59).cap, 60, "an off-grid value snaps to the nearest step");
  equal(R.createFrameCap(239).cap, 0, "…and rounding UP onto the top is unlimited too");
  equal(R.createFrameCap(Number.POSITIVE_INFINITY).cap, 0, "an infinite cap is refused like a NaN");
  // THE INVARIANT the label and the slider rely on: whatever goes in, what comes out is exactly what
  // the slider shows for it �?`snapToRange` with the slider's own domain must be a NO-OP.
  const range = { min: R.CAP_MIN, max: R.CAP_MAX, step: R.CAP_STEP };
  const { snapToRange } = load("plugins/ui/components.js");
  for (const input of [-10, 0, 0.4, 1, 29, 30, 31, 32, 58, 59, 60, 61, 119, 120, 238, 239, 240, 241, 300, 1e6,
    Number.NaN, Number.POSITIVE_INFINITY, -Number.POSITIVE_INFINITY]) {
    const cap = R.sanitizeFrameCap(input);
    const shown = cap === 0 ? R.CAP_MAX : cap; // the binding maps 0 to the slider's top
    assert(snapToRange(shown, range) === shown, `a stored cap is representable by the slider (${input} -> ${cap})`);
    assert(cap === 0 || (cap >= R.CAP_MIN && cap < R.CAP_MAX), `a stored cap is in the domain or unlimited (${input} -> ${cap})`);
  }
  // …and the DOMAIN is declared ONCE: the settings panel IMPORTS it instead of restating the numbers.
  const menuCapSrc = stripComments(readSource("src/plugins/ui/views/menu.ts"));
  equal(countOf(menuCapSrc, /const CAP_MIN\s*=|const CAP_MAX\s*=/g), 0, "the panel does not restate the cap domain");
  assert(/min:\s*CAP_MIN[\s\S]{0,120}max:\s*CAP_MAX[\s\S]{0,120}step:\s*CAP_STEP/.test(menuCapSrc),
    "…it uses the resource's constants for the slider's whole domain");

  // The RUNTIME write goes through a command (the frame gate reads the resource every frame, so it is
  // world state and cannot be assigned by a UI callback), and it sanitises exactly like the loader.
  const capWorld = new World();
  capWorld.insertResource(R.FPS_CAP, R.createFrameCap(0));
  const { SetFpsCap } = load("data/globals/commands.js");
  capWorld.commands.send(SetFpsCap, { cap: 90 });
  equal(capWorld.resource(R.FPS_CAP).cap, 0, "the command is deferred: nothing changes before a barrier");
  capWorld.commands.flush();
  equal(capWorld.resource(R.FPS_CAP).cap, 90, "the barrier applies it");
  capWorld.commands.send(SetFpsCap, { cap: -3 });
  capWorld.commands.flush();
  equal(capWorld.resource(R.FPS_CAP).cap, 0, "a nonsense cap is refused at runtime too");
  capWorld.commands.send(SetFpsCap, { cap: Number.NaN });
  capWorld.commands.flush();
  equal(capWorld.resource(R.FPS_CAP).cap, 0, "…and a NaN from a slider cannot brick the frame gate");

  const main = stripComments(readSource("src/boot/main.ts"));
  assert(/insertResource\(FPS_CAP/.test(main), "the composition root provides the resource");
  assert(/createFrameCap\(\s*Number\(readSettings\(\)\.fpsCap/.test(main), "…loading it at boot");
  assert(/s\.fpsCap\s*=/.test(main), "…and writing it back");
  assert(/commands\.send\(SetFpsCap/.test(main), "onFpsCap sends the command instead of assigning");
  assert(
    /saveSettings\(\{ cap \}\)/.test(main),
    "…and persists the value it was handed (the command is deferred, so saving the resource here would write the previous cap)",
  );
  // The cap LABEL is a push, and the number it shows arrives through that same command at the next
  // barrier: the drag handler must hand it the value it just sent. Re-reading the resource printed the
  // PREVIOUS drag step, and nothing else refreshes the label �?the reported "the FPS number is not
  // accurate while sliding".
  const menuSrc = stripComments(readSource("src/plugins/ui/views/menu.ts"));
  assert(/renderCap\(cap\)/.test(menuSrc), "the cap label is handed the value the drag just sent");
  assert(/const renderCap = \(justSet\?: number\)/.test(menuSrc), "…and reads the resource only when it has none");
  equal(countOf(main, /\blet fpsCap\b|\bfpsCap = cap\b/g), 0, "no closure variable left behind");
  // The gate reads the resource, and diagnostics reads it too —from the World, not from a callback.
  assert(/pacingTargetHz\(frameCap\.cap, frameCap\.vsync, frameCap\.refreshHz\)/.test(main),
    "the frame gate reads the resource through the pacing");
  assert(
    /world\.resource\(FPS_CAP\)/.test(readSource("src/plugins/render/systems/diagnostics.ts")),
    "diagnostics reads the resource",
  );

  // ===== THE VERTICAL-SYNC SWITCH IS A PACE, NOT A LAUNCH ARGUMENT (P1.86) =====
  // It used to be `--disable-gpu-vsync` on the WebView2 command line: a file, a "restart to apply" hint and a
  // button that could not do what it said. The launch arguments now lift Chromium's display-rate limit
  // UNCONDITIONALLY and this value decides the rate — so the arithmetic below is the whole feature.
  equal(R.createFrameCap().vsync, true, "vertical sync is ON by default (run at the panel's rate)");
  equal(R.createFrameCap(0, false).vsync, false, "…and a stored false survives");
  equal(R.createFrameCap(0, "yes").vsync, true, "a hand-edited non-boolean is refused");
  // The refresh rate comes from the PLATFORM in milli-Hz, and a broken answer must reach the pacing as
  // "unknown" (0) rather than as a number.
  equal(R.refreshHzFromMilliHz(59_940), 59.94, "DWM's ratio survives as 59.94Hz, not as 60");
  equal(R.refreshHzFromMilliHz(60_000), 60, "…and a real 60Hz panel as 60");
  equal(R.refreshHzFromMilliHz(144_000), 144, "a high-refresh panel is understood");
  equal(R.refreshHzFromMilliHz(0), 0, "no answer is 'unknown'");
  equal(R.refreshHzFromMilliHz(-1), 0, "…and so is a nonsense one");
  equal(R.refreshHzFromMilliHz(10_000), 0, "…including a rate no display has");
  // THE TARGET: sync + cap against the display.
  equal(R.pacingTargetHz(0, true, 59.94), 59.94, "synced and uncapped locks to the measured refresh");
  equal(R.pacingTargetHz(0, false, 59.94), 0, "unsynced and uncapped paces nothing at all");
  equal(R.pacingTargetHz(30, true, 59.94), 30, "a cap below the refresh is honoured while synced");
  equal(R.pacingTargetHz(240, true, 59.94), 59.94,
    "a cap ABOVE the refresh means the refresh: drawing frames the panel cannot show buys nothing");
  equal(R.pacingTargetHz(240, false, 59.94), 240, "…but an unsynced cap really is the cap");
  equal(R.pacingTargetHz(0, true, 0), 60,
    "an unknown display rate falls back to 60 — never to 'uncapped', which would invert the label");
  equal(R.pacingTargetHz(30, true, 0), 30, "…and a cap under that fallback still wins");
  // THE ARITHMETIC: one drawn frame per budget, and an uncapped target draws on every vblank.
  // 60 vblanks of a 400Hz rAF = 150ms of real time = 9 frames at 60fps (and NOT 60, which is what the loop
  // would draw if the pacing were missing — the whole reason the gate exists).
  let acc = 0;
  let drawn = 0;
  for (let i = 0; i < 60; i++) {
    const p = R.paceFrame(acc, 1 / 400, R.pacingTargetHz(0, true, 60)); // rAF at 400Hz, locked to a 60Hz panel
    acc = p.acc;
    if (p.draw) drawn++;
  }
  equal(drawn, 9, "a 400Hz rAF draws 9 frames in 60 vblanks, not 60");
  equal(R.paceFrame(0, 1 / 60, 0).draw, true, "an uncapped target draws every vblank");
  equal(R.paceFrame(0, 0.001, 60).draw, false, "a 60fps target skips a 1ms vblank");
  equal(R.paceFrame(0, 1 / 30, 30).draw, true, "…and draws the one that completes its budget");
  // The RUNTIME switch: a command (the loop reads the resource every frame), and the file is written by the
  // caller — exactly the cap's split.
  const vsyncWorld = new World();
  vsyncWorld.insertResource(R.FPS_CAP, R.createFrameCap(0, true));
  const { SetVsync } = load("data/globals/commands.js");
  vsyncWorld.commands.send(SetVsync, { vsync: false });
  equal(vsyncWorld.resource(R.FPS_CAP).vsync, true, "the command is deferred: nothing changes before a barrier");
  vsyncWorld.commands.flush();
  equal(vsyncWorld.resource(R.FPS_CAP).vsync, false, "the barrier applies it — on the NEXT frame, not at the next launch");
  assert(/s\.vsync = justSet\.vsync \?\? world\.resource\(FPS_CAP\)\.vsync/.test(main),
    "…and the setting is persisted like the cap — HANDED the value, for the same deferred-command reason");
  assert(/saveSettings\(\{ vsync: on \}\)/.test(main), "…and the switch hands it");
  assert(/commands\.send\(SetVsync/.test(main), "…through the command, not by assigning the resource");
  assert(/vsync: deps\.world\.resource\(FPS_CAP\)\.vsync/.test(
    stripComments(readSource("src/boot/drivers/startup.ts"))),
    "the settings check knows the key (so a hand-edited value is repaired, not silently kept)");
  // NO RESTART ANYWHERE: the hint is gone from the surface, and the launch arguments no longer depend on a
  // file — they lift the display-rate limit for good.
  const menuNow = stripComments(readSource("src/plugins/ui/views/menu.ts"));
  assert(!/restartHint/.test(menuNow) && /settings\.vsyncHint/.test(menuNow),
    "the row explains what sync MEANS instead of asking for a restart");
  assert(/isVsyncOn: cb\.isVsyncOn/.test(stripComments(readSource("src/plugins/ui/views/mainmenu.ts"))) &&
    /isVsyncOn: cb\.isVsyncOn/.test(menuNow), "both settings panels drive the runtime switch");
  const gameRs = readSource("src-tauri/src/game.rs");
  // **NO EXTRA LAUNCH FLAGS (P1.90, by request: «把那个解锁flag的弄掉…就用浏览器那个默认的垂直同步»).** Both
  // experiments are taken back out: the browser's own frame-rate limit and vblank wait are the default, and
  // they are the smoothest thing this stack can do. The host's BASE list is still published (P1.81: it must be,
  // or the config's absent copy would apply), but nothing is appended to it.
  assert(!/EXTRA_BROWSER_ARGS/.test(gameRs), "no launch argument is appended to the host's list any more");
  assert(/publish_browser_args\(crate::platform::browser_args_base\(\)\)/.test(gameRs),
    "…the host's base list is still published unconditionally");
  assert(!/disable-frame-rate-limit|disable-gpu-vsync/.test(stripComments(gameRs)),
    "…and neither frame-rate/vsync experiment is left in the tree (the comment that documents them is not code)");
  // …EXCEPT THE ONE FLAG THAT CHOOSES THE GPU (P2.07, by request). `powerPreference: "high-performance"` is a
  // request INSIDE the WebView; on a hybrid laptop Windows decides for the WebView2 PROCESS and defaults to the
  // power-saving adapter, so the engine ran on the integrated GPU with the discrete one idle. Chromium's own
  // switch, in the host's base list (published unconditionally, so it needs no config and no relaunch logic).
  const webviewRs = stripComments(readSource("src-tauri/src/platform/windows/webview.rs"));
  assert(/BROWSER_ARGS_BASE: &str = "[\s\S]*?--force_high_performance_gpu/.test(webviewRs),
    "the host's base argument list forces the high-performance GPU (the discrete card is otherwise idle)");
  assert(/--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection/.test(webviewRs),
    "…and the list is still the COMPLETE one (a non-empty value replaces wry's default, which is why it is spelled out)");
  assert(/pacingTargetHz\(frameCap\.cap, frameCap\.vsync, frameCap\.refreshHz\)/.test(
    stripComments(readSource("src/boot/main.ts"))),
    "the cap and the switch still pace the loop (a cap below the refresh is exact: it skips whole refreshes)");
  assert(!/vsync_path|read_vsync_disabled|write_vsync_disabled/.test(gameRs),
    "…and the vsync switch FILE stays gone: nothing about the frame rate needs a relaunch");
  assert(!/vsync_path|read_vsync_disabled|write_vsync_disabled/.test(gameRs),
    "…and the vsync switch FILE is gone: nothing about the frame rate needs a relaunch");
  assert(/pub fn apply_browser_args\(\)/.test(gameRs), "…so the arguments no longer depend on the game root");
  assert(/fn display_refresh\(\)/.test(readSource("src-tauri/src/lib.rs")),
    "the display's refresh rate is a command of its own (a fullscreen switch can change monitor)");
  assert(/displayRefreshMilliHz/.test(readSource("src/data/globals/shell.ts")) &&
    /display_refresh_milli_hz/.test(readSource("src-tauri/src/lib.rs")),
    "…and it arrives with the preload snapshot too");
});

check("the loop is ONE rAF chain whose body the MODE picks", () => {
  // "Is the game loop running" used to be the implicit consequence of which of stopLoop()/startLoop()
  // ran last —and stopLoop() started the UI pump as a side effect that startLoop() then undid. Then the
  // ui pump and the panorama became exactly one caller each (setLoopMode). NOW there is nothing to start
  // or stop at all: ONE chain runs for the process lifetime, `setLoopMode` only writes the mode, and the
  // frame body dispatches on it �?so a mode transition cannot half-stop a loop.
  const main = stripComments(readSource("src/boot/main.ts"));
  equal(countOf(main, /function stopLoop|function startLoop/g), 0, "no stopLoop/startLoop pair");
  equal(countOf(main, /\btimerId\b|\bstarted\b/g), 0, "no dead timer handle, no second running flag");
  equal(countOf(main, /function startUiPump|function stopUiPump|function startMenuBgLoop|function stopMenuBgLoop/g), 0,
    "the separate ui pump / panorama loops are gone");
  assert(/function setLoopMode\(/.test(main), "one transition function");
  assert(/function inWorld\(\)/.test(main), "the playing-or-not question is a function of the mode");
  // The MODE is written by the three drivers as well as by the root's own menu paths (P1.18e), so the
  // count spans all of them: what the assertion is about is that EVERY transition names its target.
  const modeCallers =
    main +
    stripComments(readSource("src/boot/drivers/startup.ts")) +
    stripComments(readSource("src/boot/drivers/world-entry.ts")) +
    stripComments(readSource("src/boot/drivers/pack-reload.ts"));
  assert(countOf(modeCallers, /setLoopMode\("/g) >= 4, "the startup, the world entry, its hand-over and the menu all say it");
  // ONE chain: a single requestAnimationFrame (re-arming itself) and no cancelAnimationFrame anywhere.
  equal(countOf(main, /requestAnimationFrame\(/g), 1, "exactly one rAF chain");
  equal(countOf(main, /cancelAnimationFrame\(/g), 0, "the chain is never cancelled or restarted");
  // The body dispatches on the mode, and a menu frame is the ui lane (+ the background), nothing else.
  // The MODE is `LOOP_STATE.mode` now (ecs/resources.ts): the loop body dispatches on world data.
  assert(/if \(loop\.mode === "game"\) renderFrame\(drawnDelta\)/.test(main), "a game frame runs the render lane");
  assert(/else if \(loop\.mode === "menu"\) menuFrame\(\)/.test(main), "a menu frame runs the menu body");
  assert(/function menuFrame\(\)[\s\S]{0,200}world\.renderUi\(\)/.test(main), "…which is the ui lane alone");
  // …and a LOAD frame is the ui lane alone too, because the loading screen is widget data and the
  // renderer does not exist yet. It used to have no body at all ("nothing yet"), which is why the
  // loading screen could not have been painted by the loop before `renderer.init()`.
  assert(/else if \(loop\.mode === "load"\) loadFrame\(\)/.test(main), "a load frame runs the loading screen");
  assert(/function loadFrame\(\)[\s\S]{0,200}world\.renderUi\(\)/.test(main), "…which is the ui lane alone");
  // …and a VBLANK that does not draw still runs the fixed step (P1.86): the display-rate limit is lifted, so
  // rAF fires more often than frames are drawn, and the simulation must not ride the drawing rate. The look,
  // the lane bodies and the frame probe all stay inside the `if (drew)` block, which is what keeps the FRAME
  // line meaning "drawn frames".
  assert(/advanceFixed\(delta\)[\s\S]{0,1200}drew = paceWantsFrame\(delta\)/.test(main),
    "the fixed step runs on EVERY vblank, before the pacing gate");
  assert(/if \(drew\) \{[\s\S]{0,600}input\.frameLook\(\)/.test(main),
    "a skipped vblank does not publish a look intent");
  assert(/if \(drew\) frameProbe\(\)/.test(main), "…and does not enter the FRAME statistics");
  // The FRAME line carries the vblank rate against the drawn rate: `raf=60/s` with `n=60` means the browser
  // is still pinning rAF to the panel, `raf=400/s` with `n=60` means the pacing is doing the work — the one
  // number that tells whether the display-rate limit really came off, and the setting that now depends on it.
  assert(/raf=\$\{probe\.vblanks\}\/s/.test(main), "the FRAME line reports the rAF rate next to the drawn rate");
  assert(/probe\.vblanks\+\+/.test(main), "…counted once per vblank");
  // …and BOTH flows have to be in that mode while their screen is up: the startup starts in it, and a
  // world entry (driven from the MENU) has to switch into it, or every frame in between is a menu frame
  // that draws the panorama behind an opaque screen for nothing.
  const entryForMode = stripComments(readSource("src/boot/drivers/world-entry.ts"));
  assert(/deps\.setLoopMode\("load"\)/.test(entryForMode), "the world entry puts the loop in load mode");
  equal(countOf(main, /loop\.mode = mode;/g), 1, "the mode has exactly one writer (LOOP_STATE.mode)");
  // …and the chain is kicked off once, by calling frame() directly rather than scheduling it. The call
  // lives inside the boot driver now (it is the first thing that happens after the loading screen's
  // first stage), so the assertion has to allow its indentation while still demanding exactly one.
  equal(countOf(stripComments(readSource("src/boot/drivers/startup.ts")), /^\s*deps\.frame\(\);$/gm), 1,
    "the startup driver starts the chain exactly once (the ONE chain itself stays in the root)");
});

check("the startup screen is DATA: a command moves LOADING_STATE, `ui.loading` paints the widgets", () => {
  // The window is now revealed while the GPU is still being initialised, so the process needs a
  // loading screen �?and a loading screen is UI, which in this repo means: a surface writes data and
  // the reconciler paints it. main.ts therefore publishes the stage into a resource (through a
  // command, like every other outside write) and `ui.loading` turns it into widget data, which is also
  // what keeps the loading text translatable and the bar free of per-frame style strings.
  const B = load("plugins/ui/systems/loading.js");
  const { LoadingScreen } = load("plugins/ui/views/loading.js");
  const { LOADING_SEGMENTS } = load("data/globals/resources.js");
  const world = widgetWorld;
  world.insertResource(LOADING_STATE, createLoadingState());
  const screen = new LoadingScreen(world);
  const loading = new B.UiLoadingSystem(world, screen);
  const shown = () => !world.get(screen.rootEntity, W.UI_STATE).hidden;
  const filled = () =>
    screen.segmentEntities.filter((e) => world.get(e, W.UI_STATE).active).length;

  equal(shown(), false, "the startup screen is spawned hidden");
  equal(world.get(screen.rootEntity, W.UI_LOOK).recipe, "loading.root", "…as a widget tree, not a DOM overlay");

  world.commands.send(SetLoadingStage, { active: true, key: "loading.settings", progress: 0 });
  equal(world.resource(LOADING_STATE).active, false, "the command is deferred: no barrier, no change");
  world.commands.flush();
  loading.step();
  equal(shown(), true, "the ui lane puts it on screen");
  equal(world.get(screen.statusEntity, W.UI_TEXT).key, "loading.settings", "the stage line is an i18n KEY");
  equal(world.get(screen.statusEntity, W.UI_TEXT).raw, false, "…so a language switch re-translates it live");
  equal(world.get(screen.percentEntity, W.UI_TEXT).key, "0%", "the percentage is the progress");
  equal(world.get(screen.percentEntity, W.UI_TEXT).raw, true, "…as raw data");
  equal(screen.segmentEntities.length, LOADING_SEGMENTS, "the bar is a fixed row of segments");
  equal(filled(), 0, "…with nothing engaged at 0%");

  world.commands.send(SetLoadingStage, { key: "loading.gpu", progress: 0.5 });
  world.commands.flush();
  loading.step();
  equal(world.get(screen.statusEntity, W.UI_TEXT).key, "loading.gpu", "the next stage renames the line");
  equal(filled(), Math.round(LOADING_SEGMENTS / 2), "half the bar is engaged at 50%");
  equal(world.get(screen.segmentEntities[0], W.UI_LOOK).recipe, "loading.segment", "the bar is widgets, not a width");

  equal(world.get(screen.noteEntity, W.UI_STATE).hidden, true, "no note while nothing needed repairing");
  world.commands.send(SetLoadingStage, { noteKey: "loading.fixed", noteValue: "fpsCap, language" });
  world.commands.flush();
  loading.step();
  equal(world.get(screen.noteEntity, W.UI_STATE).hidden, false, "a repaired setting shows the note");
  equal(world.get(screen.noteLabelEntity, W.UI_TEXT).key, "loading.fixed", "…under a translated label");
  equal(world.get(screen.noteLabelEntity, W.UI_TEXT).raw, false, "…which the reconciler re-derives");
  equal(world.get(screen.noteValueEntity, W.UI_TEXT).key, "fpsCap, language", "…listing the settings by name");
  equal(world.get(screen.noteValueEntity, W.UI_TEXT).raw, true, "…as data no dictionary could hold");

  world.commands.send(SetLoadingStage, { active: false, progress: 1 });
  world.commands.flush();
  loading.step();
  equal(shown(), false, "the screen comes down when the startup is over");
  loading.step();
  equal(world.get(screen.statusEntity, W.UI_TEXT).key, "loading.gpu", "a hidden screen writes nothing (idempotent)");
});

check("the startup reveals the window behind the screen, and entering a world rebuilds it there", () => {
  // The window used to be revealed AFTER `await renderer.init()`, so the GPU handshake, the spawn
  // window's generation and the first ~100 frames of chunk meshing all happened behind a hidden
  // window �?the startup was a black rectangle for as long as it took. The order below is the feature.
  const main = stripComments(readSource("src/boot/main.ts"));
  // The two drivers live in boot/drivers/ (P1.18e), and the shared stage half in drivers/stage.ts. EVERY
  // assertion about "the screen is activated" / "the world is built here" is scoped to ONE of them, because
  // an unscoped `indexOf` finds whichever comes first in the FILE, which is not the one being talked about.
  const startupSrc = stripComments(readSource("src/boot/drivers/startup.ts"));
  const entrySrc = stripComments(readSource("src/boot/drivers/world-entry.ts"));
  const stageSrc = stripComments(readSource("src/boot/drivers/stage.ts"));
  const bootBody = startupSrc.slice(startupSrc.indexOf("const boot = async"), startupSrc.indexOf("return boot;"));
  // The end marker has to be CODE: comments are stripped above, so a `//` marker matches nothing and the
  // slice would silently run to the end of the file (which is how the entry assertions passed while the
  // entry was broken �?the boot driver's own `active: true` was inside the slice).
  const entryBody = entrySrc.slice(entrySrc.indexOf("const enterWorld = async"), entrySrc.indexOf("return enterWorld;"));
  assert(bootBody.length > 0, "the startup driver is in the source");
  assert(entryBody.length > 0, "the world-entry driver is in the source");
  assert(!entryBody.includes("renderer.init"), "…and the slice ends before the startup driver");
  // The flow's stages are DATA now (ecs/boot.ts walks them), so the first stage is found by its own key.
  const firstStage = startupSrc.indexOf('key: "loading.settings"');
  const started = startupSrc.indexOf("deps.frame()");
  const revealed = startupSrc.indexOf("showWindow()");
  const gpu = startupSrc.indexOf("await deps.renderer.init()");
  assert(firstStage > 0, "the startup screen's first stage is announced");
  assert(started > firstStage, "…before the ONE chain is kicked off");
  assert(revealed > started, "…and before the window is revealed");
  assert(gpu > revealed, "the GPU handshake happens AFTER the window is already showing the screen");
  // …and the screen has to be ACTIVATED, or none of the above paints anything: `ui.loading` shows its root
  // only while LOADING_STATE.active is true, and the root is spawned hidden. This shipped BROKEN TWICE �?
  // the startup without the line (a black window with the crosshair and the hotbar on it, the HUD being
  // visible by default) and then the world entry without it, because `boot()`'s final stage sets
  // `active: false` and the entry never set it back. Both drivers are asserted separately now; a
  // source-text assertion is the only kind available, since a driver needs the DOM and a renderer.
  assert(
    /SetLoadingStage, \{ active: true \}/.test(bootBody),
    "the startup ACTIVATES the loading screen",
  );
  // The activation must precede STARTING the flow: the walker announces stage 0 (which pumps the ui lane
  // through the command barrier) before it runs that stage's work, so "screen up" precedes "window shown"
  // by construction �?the source order inside the driver plus the walker's own contract.
  assert(
    bootBody.indexOf("active: true") < bootBody.indexOf("deps.stage.run(\"boot\""),
    "…before the flow is started, so the first visible frame is the screen",
  );
  const walker = stripComments(readSource("src/core/flow/boot.ts"));
  assert(
    walker.indexOf("deps.announce(stage)") < walker.indexOf("await stage.run()"),
    "…and the walker announces every stage before it runs that stage's work",
  );
  assert(
    // Not anchored at the closing brace: the entry clears the startup's settings NOTE in the same
    // command, so its payload carries more than the flag.
    /SetLoadingStage, \{ active: true/.test(entryBody),
    "…and so does the WORLD-ENTRY driver (the startup left active = false)",
  );
  assert(
    entryBody.indexOf("active: true") < entryBody.indexOf("chunkStream.warmUp"),
    "…before the meshing its screen is supposed to cover",
  );
  assert(
    entryBody.indexOf("commands.send(Teleport") < entryBody.indexOf("chunkStream.warmUp"),
    "…and after the Teleport is queued, because the warm-up reads POSITION",
  );
  // Every stage is announced BEFORE its work runs, and each announcement names an i18n key.
  for (const [key, work, where] of [
    ["loading.gpu", "await deps.renderer.init()", startupSrc],
    ["loading.ready", "deps.showMainMenu()", startupSrc],
    ["world.terrain", "chunkStream.prime(", entrySrc],
    ["world.chunks", "chunkStream.warmUp(", entrySrc],
  ]) {
    const at = where.indexOf(`"${key}"`);
    assert(at > 0, `the loading screen announces ${key}`);
    assert(at < where.indexOf(work, at), `${key} is announced before its work runs`);
  }
  assert(/world\.renderUi\(\)/.test(stageSrc), "each stage is reconciled before its paint");
  // The per-stage yield is a MACROTASK, not a second chain: there is still exactly ONE rAF chain, and
  // the yield has to let the compositor present the screen before the blocking work starts.
  assert(/setTimeout\(resolve, 0\)/.test(stageSrc), "the per-stage yield is a timer task");
  equal(countOf(main, /requestAnimationFrame\(/g), 1, "…so the process still owns exactly one rAF chain");

  // ===== the world is built at ENTRY, not at startup =====
  // Building it at boot made the STARTUP pay for a world the user may never enter (the spawn window's
  // generation plus ~100 frames of meshing, ~1.6 s in the measured log) and left "entering a world"
  // with nothing to wait for �?i.e. no honest place for a loading screen. Both halves are asserted:
  // `boot()` must NOT build a world, and the entry driver MUST. (Both bodies were extracted above.)
  equal(countOf(bootBody, /chunkStream\./g), 0, "the startup does not build or mesh the world any more");
  assert(/chunkStream\.prime\(/.test(entryBody), "entering a world generates the spawn window");
  assert(/chunkStream\.warmUp\(deps\.stage\.paint/.test(entryBody), "…and meshes it behind the screen");
  // A re-entry into a window that is still built skips the screen instead of flashing it for one frame.
  assert(
    /if \(deps\.world\.resource\(RENDER_HANDLES\)\.chunkStream\.needsWarmUp\(/.test(entryBody),
    "the entry asks whether there is anything to build before it shows a screen",
  );
  assert(/deps\.setLoopMode\("game"\)/.test(entryBody), "the entry ends by handing the mode over to the game");
  equal(countOf(main, /document\.createElement\(/g), 0, "the composition root builds no element any more");
  equal(countOf(main, /style\.cssText/g), 0, "…and writes no style string");
});

check("the settings FILE is checked at boot, repaired and written back", () => {
  // Each config module already ignores a value it cannot use and falls back �?which silently left the
  // FILE disagreeing with the value in force, unreported, forever. The boot check compares the two.
  const { diffSettings } = load("core/services/settings-diff.js");
  const inForce = {
    language: "en",
    font: "pixel",
    uiScale: "auto",
    windowMode: "windowed",
    fpsCap: 0,
    keybinds: { forward: "KeyW", jump: "Space" },
  };

  const fine = diffSettings({ language: "en", fpsCap: 0 }, inForce);
  equal(fine.fixed.length, 0, "a usable file reports no repair");
  equal(fine.unknown.length, 0, "…and no unknown key");
  equal(fine.merged.fpsCap, 0, "…and is left exactly as it was");

  // A hand-edited cap: the file says 1, the value that took force is 30 (sanitizeFrameCap).
  const cap = diffSettings({ fpsCap: 1 }, { ...inForce, fpsCap: 30 });
  equal(cap.fixed.join(","), "fpsCap", "an unusable value is reported as repaired");
  equal(cap.merged.fpsCap, 30, "…by writing the value that took force");
  equal(diffSettings({ language: "de" }, inForce).merged.language, "en", "a value outside the domain goes to the one in force");
  equal(diffSettings({ windowMode: 5 }, inForce).fixed.join(","), "windowMode", "a wrong TYPE is repaired too");

  const binds = diffSettings({ keybinds: { forward: "KeyQ", jump: "Space" } }, inForce);
  equal(binds.fixed.join(","), "keybinds.forward", "a bind the table refused is repaired per ACTION");
  equal(binds.merged.keybinds.forward, "KeyW", "…to the binding in force");
  equal(binds.merged.keybinds.jump, "Space", "…leaving the valid one alone");

  const future = diffSettings({ fpsCap: 0, futureSetting: 7 }, inForce);
  equal(future.unknown.join(","), "futureSetting", "a key the engine does not know is reported");
  equal(future.merged.futureSetting, 7, "…and KEPT (an older build must not trim a newer file)");
  equal(future.fixed.length, 0, "…and is not a repair");

  const empty = diffSettings({}, inForce);
  equal(empty.fixed.length + empty.unknown.length, 0, "an ABSENT key is not a fault (a first run)");

  // A LIST-valued setting (P1.49aa/P1.49ae, `enabledPacks`): two arrays are never identical by REFERENCE, so the
  // plain `!==` would have called the user is own list unusable and rewritten it from the value in force on
  // every boot. The repair compares element-wise, and a wrong TYPE is still repaired.
  const listSame = diffSettings({ enabledPacks: ["a"] }, { ...inForce, enabledPacks: ["a"] });
  equal(listSame.fixed.join(","), "", "an unchanged pack list is NOT reported as repaired");
  const listDiff = diffSettings({ enabledPacks: ["a", "b"] }, { ...inForce, enabledPacks: ["a"] });
  equal(listDiff.fixed.join(","), "enabledPacks", "a DIFFERENT pack selection is repaired");
  equal(listDiff.merged.enabledPacks.join(","), "a", "?to the selection in force");
  const listBad = diffSettings({ enabledPacks: "a" }, { ...inForce, enabledPacks: ["a"] });
  equal(listBad.fixed.join(","), "enabledPacks", "a pack selection of the wrong TYPE is repaired too");

  // ?and the pack store NORMALISES whatever the file held: only non-empty strings, no duplicates, so a
  // hand-edited `[1, "", " a ", "a"]` cannot take a pack out of the chain twice or crash the filter.
  const Tex = load("data/assets/textures.js");
  equal(Tex.normalizeEnabledPacks([1, "", "  ", "a", "a", "b "]).join(","), "a,b", "the enabled selection is normalised");
  equal(Tex.normalizeEnabledPacks("a").length, 0, "a non-array selection is ignored");
  equal(Tex.normalizeEnabledPacks(undefined).length, 0, "?including an absent one");

  // …and the startup driver actually runs it, before anything it could disagree with is used. The check
  // moved into boot/drivers/startup.ts (P1.18e), where the stage list that REPORTS its outcome lives.
  const main = stripComments(readSource("src/boot/drivers/startup.ts"));
  assert(/readSettingsChecked\(\)/.test(main), "the boot check uses the read that can report a fault");
  assert(/diffSettings\(checked\.settings, inForce\)/.test(main), "…compares the file with the values in force");
  assert(/writeSettings\(report\.merged\)/.test(main), "…and writes the repaired file back");
  assert(/backupSettingsFile\(\)/.test(main), "an UNREADABLE file is backed up before being rebuilt");
  assert(/writeSettings\(\{ \.\.\.inForce \}\)/.test(main), "…and rebuilt from the values in force");
  for (const key of ["language", "font", "uiScale", "windowMode", "fpsCap", "keybinds", "diagLog", "enabledPacks"]) {
    assert(new RegExp(`\\n    ${key}:`).test(main), `the schema lists "${key}"`);
  }
  // The "Diagnostic log" switch (the settings panel's `diagLog` toggle) is a plain boolean in the same
  // file, so a hand-edited `"diagLog": "yes"` is repaired by TYPE like every other unusable value.
  const diag = diffSettings({ diagLog: "yes" }, { ...inForce, diagLog: true });
  equal(diag.fixed.join(","), "diagLog", "the Diagnostic-log switch is repaired like any other setting");
  equal(diag.merged.diagLog, true, "…by writing the value in force");
});

check("the diagnostic probes have ONE switch, and it filters at the log sink", () => {
  // The probe lines (FRAME/LOOK/RAWLAG/RAWMON/STALL/PHYS/SPACE#/MOUSE#/HOOKPROBE/KBCAP/RAWINPUT
  // takeover) are what made the "held key" investigation possible, and several of them fire on ordinary
  // activity (a click writes KBCAP, a capture transition writes the takeover line), so they are the only
  // thing that keeps writing for as long as the app runs. The switch is a settings-panel toggle (default
  // ON) and it filters in `logDebug` �?the ONE place every probe line passes through �?so the event lines
  // (BOOT / SETTINGS / WORLD / LOCK / CURSOR / ESC / ERROR �? are never affected, and a new probe only has
  // to be added to the prefix table.
  const shell = stripComments(readSource("src/host/desktop/shell.ts"));
  // The prefix TABLE is DATA now (`data/globals/probes.ts`); the switch and the one filter point stay here.
  const probes = stripComments(readSource("src/data/globals/probes.ts"));
  assert(/export function setDiagLogEnabled/.test(shell) && /export function isDiagLogEnabled/.test(shell),
    "the switch is a getter/setter pair on the log sink");
  assert(/if \(!state\.diagLogEnabled && isProbeLine\(line\)\) return;/.test(shell),
    "…and logDebug filters the probe lines with it");
  assert(/export function appendDebugLog/.test(shell) && !/isProbeLine/.test(shell.split("export function appendDebugLog")[1].split("export function logDebug")[0]),
    "the error/console channel (appendDebugLog) stays unfiltered");
  // EVERY emitted probe line's OWN first token must be in the table �?not just "the table names a
  // probe". The table used to carry a stale `"LOOK#"` while `player.input` printed `LOOK raw=…`, so with
  // the switch OFF that line kept being written every second (the flood the switch exists to stop) and
  // the old assertion here happily passed, because it only checked the table against ITSELF. Each entry
  // below is a real emitter: the file, a regex matching the literal the code formats, and the prefix the
  // table must therefore contain.
  for (const [file, literal, prefix] of [
    ["src/plugins/player/systems/input.ts", /`LOOK raw=/, "LOOK "],
    ["src/plugins/player/systems/input.ts", /`RAWLAG ev=/, "RAWLAG "],
    ["src/plugins/player/systems/input.ts", /`SPACE#/, "SPACE#"],
    ["src/plugins/player/systems/input.ts", /`MOUSE#/, "MOUSE#"],
    ["src/plugins/render/systems/diagnostics.ts", /`PHYS mode=/, "PHYS "],
    ["src/boot/main.ts", /`FRAME n=/, "FRAME "],
    ["src/boot/main.ts", /`STALL gap=/, "STALL "],
    ["src-tauri/src/rawinput_session.rs", /"RAWMON emits=\{/, "RAWMON "],
    ["src-tauri/src/platform/windows/rawinput.rs", /"HOOKPROBE seen=\{/, "HOOKPROBE "],
    // The key bind gestures fire on ordinary clicks, so they are probes too (a click must not write a
    // line into a log whose switch is off).
    ["src/plugins/input/bind-gesture.ts", /`KBCAP mousedown/, "KBCAP "],
    ["src/plugins/ui-keybind/views/keybind.ts", /`KBCAP click interactive button/, "KBCAP "],
    ["src/plugins/player/systems/input.ts", /"RAWINPUT takeover \(movementX suspended\)"/, "RAWINPUT takeover"],
    ["src/plugins/player/systems/input.ts", /"RAWINPUT hands back to movementX"/, "RAWINPUT hands back"],
  ]) {
    assert(literal.test(readSource(file)), `${file} still emits the ${prefix.trim()} probe as expected`);
    assert(probes.includes(`"${prefix}"`), `the filter table covers the ${prefix.trim()} probe the code emits`);
  }
  // …while the two BOOT lines that start with the same word stay EVENT records: a bare "RAWINPUT "
  // prefix would swallow them, and with the switch off they are the only trace of whether the native
  // channel came up at all.
  assert(!probes.includes('"RAWINPUT "'), "the table does not gate the BOOT RAWINPUT lines by a bare prefix");
  const main = stripComments(readSource("src/boot/main.ts"));
  assert(
    /const diagLogAtBoot = readSettings\(\)\.diagLog !== false;/.test(main) &&
      /setDiagLogEnabled\(diagLogAtBoot\);/.test(main),
    "the composition root loads it (default ON) before anything logs a probe",
  );
  assert(/s\.diagLog = isDiagLogEnabled\(\)/.test(main), "…and persists it with the other settings");
  // …and it RECORDS the state the run booted in, as an EVENT line (its prefix is deliberately not in the
  // probe table): with the switch off, a log with no probe lines is otherwise ambiguous �?"off" and "the
  // probes never registered" look exactly the same to whoever reads it.
  assert(/`DIAGLOG probes [^`]*at boot/.test(main), "the composition root records the switch's boot state");
  assert(!probes.includes('"DIAGLOG '), "…as an event line: its prefix is not in the probe table");
  const menu = stripComments(readSource("src/plugins/ui/views/menu.ts"));
  // P1.49m: the toggle is a ROW now - the NAME on the left (`settings.diagLog`, `settings.vsync`) and the
  // STATE on the right (`settings.on` / `settings.off`), so THOSE are the keys that must be translated.
  assert(/settings\.diagLog/.test(menu) && /settings\.on/.test(menu) && /settings\.off/.test(menu),
    "the shared settings panel renders it as a two-state toggle");
  // THE FADE ROW (P2.01 → P2.05): ONE row now, for every chunk, with the same two-state shape as the cap/vsync,
  // and its value travels the same path — loaded by the root into a resource, changed through a COMMAND, and
  // persisted by HANDING the new value to the save (reading the resource back would write the state the user just
  // left, which is the measured bug both of those already carry a comment about). The retired `chunks` switch
  // keeps its file key and its schema entry (an older settings.json must load and not read as repaired) but has
  // no row and nothing reads it.
  const startup = stripComments(readSource("src/boot/drivers/startup.ts"));
  assert(/settings\.fadeLod/.test(menu), "the settings panel has a row for the fade");
  assert(/\$\{id\}\.fadeLod/.test(menu), "…with its own action id");
  assert(!/addFadeRow|settings\.fadeChunks\b/.test(menu), "…and the per-ring rows are gone (one uniform switch)");
  assert(
    /const fadeOptions = createFadeOptions\(readSettings\(\)\.fadeLod, readSettings\(\)\.fadeChunks\);/.test(main) &&
      /world\.insertResource\(FADE_OPTIONS, fadeOptions\)/.test(main),
    "the composition root loads them from the settings file into the resource the render lane reads",
  );
  assert(
    /world\.commands\.send\(SetFadeOption, \{ which, on \}\)/.test(main) &&
      /saveSettings\(which === "lod" \? \{ fadeLod: on \} : \{ fadeChunks: on \}\)/.test(main),
    "a click goes through the COMMAND and HANDS the value to the save (never reads it back)",
  );
  assert(
    /s\.fadeLod = justSet\.fadeLod \?\? fadeOptions\.lod;/.test(main) &&
      /s\.fadeChunks = justSet\.fadeChunks \?\? fadeOptions\.chunks;/.test(main),
    "…and both are written with every other setting",
  );
  assert(
    /fadeLod: deps\.world\.resource\(FADE_OPTIONS\)\.lod,/.test(startup) &&
      /fadeChunks: deps\.world\.resource\(FADE_OPTIONS\)\.chunks,/.test(startup),
    "the boot settings check carries them in its schema (or the engine's own setting would read as unknown)",
  );
  // The labels have to exist in every shipped dictionary, or a row would show the raw key.
  for (const lang of ["zh", "en", "ja"]) {
    const dict = JSON.parse(
      require("node:fs").readFileSync(
        path.join(ROOT, "packs", "VoxelEngineNWWebrp", "assets", "voxel", "lang", `${lang}.json`),
        "utf8",
      ),
    );
    for (const key of [
      "settings.diagLog",
      "settings.fadeLod",
      "settings.fadeChunks",
      "settings.fadeLodHint",
      "settings.fadeChunksHint",
      "settings.vsync",
      "settings.on",
      "settings.off",
      "settings.vsyncHint",
      "settings.packsOff",
      "settings.packsOn",
      "settings.packsNone",
      "settings.packsRestart",
    ]) {
      assert(typeof dict[key] === "string" && dict[key].length > 0, `${key} is translated (${lang})`);
    }
  }
});

check("the startup screen's copy exists in the shipped dictionaries", () => {
  // The loading screen is the FIRST thing a user sees, and its text is i18n keys like every other
  // surface: a key with no entry would put "loading.gpu" on screen instead of a sentence.
  const dicts = ["zh", "en", "ja"].map((lang) =>
    JSON.parse(
      require("node:fs").readFileSync(
        path.join(ROOT, "packs", "VoxelEngineNWWebrp", "assets", "voxel", "lang", `${lang}.json`),
        "utf8",
      ),
    ),
  );
  const keys = [
    "loading.title",
    "loading.settings",
    "loading.gpu",
    "loading.ready",
    "loading.fixed",
    "loading.unknown",
    "loading.rebuilt",
    // …and the world-entry stages, which the SAME screen shows while the spawn window is built.
    "world.spawn",
    "world.terrain",
    "world.chunks",
    "world.ready",
  ];
  for (const [index, dict] of dicts.entries()) {
    for (const key of keys) {
      assert(typeof dict[key] === "string" && dict[key].length > 0, `${key} is translated (${["zh", "en", "ja"][index]})`);
    }
  }
});

check("configuration is a RESOURCE, and the input state caches no copy of it", () => {
  // Two leftovers of the same shape: state that lived as a module singleton or as a cached field.
  //   * the mutable CONFIG (language, font, UI scale, key map) is world state �?the bind table is asked
  //     every tick and the language every frame �?so it lives in resources with declared readers;
  //   * INPUT_STATE carried a cached `clickLockAllowed`, i.e. a second copy of what UI_MODAL already
  //     answers. A stale copy there let a click capture the mouse behind an open menu.
  const R = load("data/globals/resources.js");
  const main = stripComments(readSource("src/boot/main.ts"));
  for (const [name, make] of [
    ["LOCALE", R.createLocale],
    ["FONT", R.createFont],
    ["UI_SCALE", R.createScale],
    ["KEYMAP", R.createKeyMap],
  ]) {
    assert(typeof make === "function", `${name} has a factory`);
    assert(new RegExp(`insertResource\\(${name},`).test(main), `the composition root inserts ${name}`);
  }
  assert(/loadBinds\(keymap, readSettings\(\)\.keybinds\)/.test(main), "…seeded from settings.json");
  // The language is seeded from settings.json AND validated against the CONTENT plugin's declaration: the
  // i18n module may not import a plugin, so the root hands the set in (see loadLang).
  assert(/loadLang\(\s*locale,\s*readSettings\(\)\.language,\s*registry\.list\(SLOT_LANGUAGES\)/.test(main),
    "…and so is the language — validated against the set the content plugin DECLARED (no literal, P1.36)");
  assert(main.indexOf("loadLang(") > main.indexOf("installPlugins("),
    "…loaded AFTER the install, which is what fills that extension point (the set IS the content plugin's)");

  // The bind table IS the resource: the module seeds its DEFAULTS INTO that object (no private copy).
  const keymap = R.createKeyMap();
  const K = load("plugins/input/keybinds.js");
  K.adoptKeyMap(keymap);
  equal(keymap.codes.get("jump"), "Space", "adopting seeds the defaults into the resource");
  equal(K.getBind("jump"), "Space", "…and the module answers from it");
  K.loadBinds(keymap, { jump: "KeyJ", forward: "not a code" });
  equal(keymap.codes.get("jump"), "KeyJ", "a saved bind lands in the resource");
  equal(keymap.codes.get("forward"), "KeyW", "…while an invalid saved value keeps the default");
  K.setBind("sprint", "KeyJ");
  equal(keymap.codes.get("jump"), "", "rebinding preempts the previous owner of the code");
  equal(K.getBind("sprint"), "KeyJ", "…and the new owner has it");
  // Leave a clean table behind: the module keeps a POINTER to whatever it adopted last.
  K.adoptKeyMap(R.createKeyMap());
  equal(K.getBind("jump"), "Space", "a fresh KEYMAP restores the defaults");

  // No module keeps a private copy of the value any more (a pointer to the resource, not a mirror).
  const keybindsSrc = stripComments(readSource("src/plugins/input/keybinds.ts"));
  assert(/let table: KeyMapState \| null/.test(keybindsSrc), "keybinds.ts holds the resource object");
  equal(countOf(keybindsSrc, /const binds = new Map/g), 0, "…and its private Map is gone");
  for (const [file, needle] of [
    ["src/data/assets/i18n.ts", /let locale: LocaleState \| null/],
    ["src/data/globals/fonts.ts", /let state: FontState \| null/],
    ["src/data/globals/uiscale.ts", /let state: ScaleState \| null/],
  ]) {
    assert(needle.test(stripComments(readSource(file))), `${file} reads the config resource`);
  }
  // …and the readers DECLARE it, or the schedule's model of them is a lie.
  assert(/readsExternal: \["keybinds"\]/.test(stripComments(readSource("src/plugins/player/systems/movement.ts"))),
    "movement declares the bind-table read");
  assert(/"locale"/.test(stripComments(readSource("src/plugins/ui/systems/reconcile.ts"))),
    "the reconciler declares the language read");

  // The GLOBAL STYLE (the font pair + the root font size) is the reconciler's to apply, not the config
  // modules'. They used to fire `applyFont()` / `applyUIScale()` themselves: a DOM write from outside
  // any system, past no barrier, and �?for the root font size �?repeated unconditionally on every resize.
  // The values live with the resources; the write is HERE, diffed against what was last applied.
  const renderSrc = stripComments(readSource("src/plugins/ui/systems/reconcile.ts"));
  const fontsSrc = stripComments(readSource("src/data/globals/fonts.ts"));
  const scaleSrc = stripComments(readSource("src/data/globals/uiscale.ts"));
  const bootSrc = stripComments(readSource("src/boot/main.ts"));
  for (const [file, src] of [["src/data/globals/fonts.ts", fontsSrc], ["src/data/globals/uiscale.ts", scaleSrc]]) {
    // The mount root uiStage is this module's own business (the reconciler is HANDED it). What it may
    // not do any more is apply the DOCUMENT ROOT's style �?that is the reconciler's one DOM write.
    equal(countOf(src, /documentElement|style\.(?:setProperty|fontSize)/g), 0,
      `${file} still applies the global style itself`);
  }
  assert(/export function currentFontCss\(\)/.test(fontsSrc), "fonts.ts exports the VALUE (the css pair)");
  assert(/export function currentRootFontPx\(\)/.test(scaleSrc), "uiscale.ts exports the VALUE (the root size)");
  assert(/readsExternal:\s*\[[^\]]*"font"[^\]]*"uiScale"/.test(renderSrc),
    "…and the reconciler declares reads of both (or its model of itself is a lie)");
  for (const [what, needle] of [
    ["the font pair", /document\.documentElement\.style\.setProperty\("--font-/],
    ["the root font size", /document\.documentElement\.style\.fontSize/],
  ]) {
    assert(needle.test(renderSrc), `the reconciler applies ${what}`);
  }
  equal(countOf(bootSrc, /applyFont\(|applyUIScale\(/g), 0, "the composition root applies neither by hand");

  // The cached click permission is gone from all three places that used to move it around.
  equal(countOf(stripComments(readSource("src/data/globals/resources.ts")), /clickLockAllowed/g), 0,
    "INPUT_STATE has no click-permission field");
  assert(/isModalUi\(this\.ui\)/.test(stripComments(readSource("src/plugins/player/systems/input.ts"))),
    "the input system derives it from UI_MODAL at the moment of the question");
  equal(countOf(stripComments(readSource("src/host/browser/pointerlock.ts")), /clickLockAllowed/g), 0,
    "pointerlock.ts no longer publishes it");

  // Assets are DATA with an owner: the dictionaries, the block registry and the pack chain's background
  // memo are loaded once and never change, but they are no longer invisible module-level `let`s �?each
  // module creates its object at import time (all three can be asked before the World exists) and the
  // composition root INSERTS it, so the cache has a name and a reader that is not that module.
  for (const [name, token] of [
    ["the dictionaries", "I18N_STRINGS"],
    ["the block registry", "BLOCK_REGISTRY"],
    ["the background memo", "MENU_BG_KIND"],
    ["the host state", "SHELL_STATE"],
  ]) {
    assert(new RegExp(`insertResource\\(${token},`).test(main), `${name} are inserted as a resource`);
  }
});

check("the presentation objects are RESOURCES, not constructor dependencies", () => {
  // The three.js scene, the camera, the renderer, the frame-time sampler, the canvas host, the UI mount
  // root and the chunk-mesh cache used to arrive as CONSTRUCTOR ARGUMENTS �?the only shared state in the
  // process with no owner. They are world state, so the world holds them and each system resolves what
  // it uses (ecs/presentation.ts). Both halves are asserted: the root inserts every one, and none of
  // them is handed to a system any more �?that second half is the regression this group exists for.
  const P = loadPresentation();
  const main = stripComments(readSource("src/boot/main.ts"));
  for (const name of [
    "SCENE3D",
    "CAMERA3D",
    "RENDERER3D",
    "PERF_SAMPLER",
    "CANVAS_HOST",
    "UI_MOUNT",
    "CHUNK_MESHES",
  ]) {
    assert(typeof P[name]?.name === "string", `${name} is a resource token`);
    assert(new RegExp(`insertResource\\(${name},`).test(main), `the composition root inserts ${name}`);
  }
  // The consumers resolve them from the World �?the shape every other resource uses.
  for (const [file, token] of [
    ["src/plugins/render/systems/camera.ts", "CAMERA3D"],
    ["src/plugins/render/systems/chunk-stream.ts", "CHUNK_MESHES"],
    ["src/plugins/render/systems/diagnostics.ts", "PERF_SAMPLER"],
    ["src/plugins/render/systems/diagnostics.ts", "RENDERER3D"],
    ["src/plugins/player/systems/input.ts", "RENDERER3D"],
    ["src/plugins/ui/systems/reconcile.ts", "UI_MOUNT"],
  ]) {
    assert(
      new RegExp(`resource\\(${token}\\)`).test(stripComments(readSource(file))),
      `${file} resolves ${token}`,
    );
  }
  // …and the constructor signatures lost their presentation arguments. The systems are constructed by the
  // PLUGIN factories since P1.18b, so the signatures are checked against the root PLUS those files.
  const construction = [
    main,
    stripComments(readSource("src/plugins/player/index.ts")),
    stripComments(readSource("src/plugins/render/index.ts")),
    stripComments(readSource("src/plugins/diagnostics/index.ts")),
    stripComments(readSource("src/plugins/ui/index.ts")),
  ].join("\n");
  for (const [what, needle] of [
    ["the camera view", /new CameraViewSystem\(w\.world\)/],
    // The mesher, the WORKER POOL, the FAR RING's policy and the GPU SAMPLER (M1) are capabilities injected by the
    // root/plugin, not presentation objects (the pool creates Workers — a `host/` object a plugin may not import;
    // the LOD policy is plain data; the sampler is the plugin's own system, handed in through `LodGridSource`).
    // None of them is a resource, which is what this check is about.
    ["the chunk stream", /new ChunkStreamSystem\(\s*w\.world,\s*w\.mesh,\s*w\.pool \?\? null,\s*w\.lod === undefined \? DEFAULT_LOD : w\.lod,\s*lodSampler\.source,?\s*\)/],
    ["the device layer", /new PlayerInputSystem\(w\.world, w\.log, w\.inWorld, w\.mouse\)/],
    ["the reconciler", /export function createRenderSystem\(\.\.\.args: ConstructorParameters/],
  ]) {
    assert(needle.test(construction), `${what} takes no presentation object any more`);
  }
  const diagDeps = /new DiagnosticsSystem\(([^)]*)\)/.exec(readSource("src/plugins/diagnostics/index.ts"));
  assert(diagDeps !== null, "diagnostics is constructed");
  equal(diagDeps[1].trim(), "world", "diagnostics takes NOTHING but the world (a view callback and another "
    + "system's queues used to be constructor arguments �?they are resources now)");
  // The CANVAS SIZE belongs to the FRAME, not to a lane: a MENU frame and a LOAD frame run the ui lane
  // alone, so a size applied by `renderer.draw` was applied only in a game �?resize at the main menu and the
  // panorama's canvas kept its old pixel size until a world was entered (that bug shipped once).
  assert(/function frame\(\)[\s\S]{0,200}applyViewportSize\(\)/.test(main),
    "the frame applies the viewport size, before the mode body");
  // The draw declaration left the root (the render plugin owns it now), so the check reads both.
  assert(
    /run: \(\) => world\.resource\(RENDERER3D\)\.render\(/.test(main) ||
      /run: \(\) => world\.resource\(RENDERER3D\)\.render\(/.test(readSource("src/plugins/render/index.ts")),
    "…and the draw only draws (it must not resize the canvas)");
  // A WINDOW GEOMETRY change is a DEVICE signal treated like losing the window: hand the mouse back and
  // pause if the player was playing. It is deliberately NOT a blur �?dragging a border keeps the window
  // focused and the cursor inside its rect �?and it is the only signal that catches the reported bug
  // (start a resize-drag while a world loads, the entry locks the mouse on top of it, then both the drag
  // and the view rotation work).
  assert(/onWinGeometry\(/.test(main), "the window's geometry change is handled as a signal");
  assert(/suppressGeometryPause\(\)/.test(main) && /performance\.now\(\) < loop\.suppressGeometryUntil/.test(main),
    "…while our OWN window-mode switch suppresses it (fullscreen must not open the pause menu)");
  // CAPTURE REQUIRES THE FOREGROUND. The browser path refuses pointer lock by itself, which is why the NW.js
  // version could drop the focus gate; the NATIVE capture (ClipCursor) does not look at the foreground at
  // all, so an AUTOMATIC relock �?the world entry is the one �?would capture the mouse while the user is in
  // another app. Three places, and the gate pins all three.
  const pointerlockSrc = stripComments(readSource("src/host/browser/pointerlock.ts"));
  assert(/focused: \(\) => boolean/.test(pointerlockSrc), "the lock manager takes a foreground predicate");
  assert(/if \(!this\.deps\.focused\(\)\)/.test(pointerlockSrc), "…and refuses to capture without it");
  assert(/focused: winFocused/.test(main), "…which the composition root ships from the shell");
  const entrySrc = stripComments(readSource("src/boot/drivers/world-entry.ts"));
  assert(/if \(deps\.winFocused\(\) && !moving && !fiddled\) \{[\s\S]{0,140}deps\.relock\("world entered"\)/.test(entrySrc),
    "the world entry captures only when foregrounded, with no hand on the window and no fiddling during loading");
  assert(/onCaptureLost\(/.test(main), "…and a rust-side teardown is handled as a lost window");
  // **A FOCUS EVENT NEVER RE-REQUESTS CAPTURE (P1.58).** The root cure of the Win-key flap the boot.log
  // pinned: `focus LOST` -> `focus GAIN` several times per keypress, and the handler re-opened the native
  // capture (which HIDES the cursor, P1.57) on every one of them. Capture is EXPLICIT-only now - a click,
  // Resume, ESC, the backpack key, the world entry - never an event the OS is free to repeat; a focus event
  // re-asserts the cursor INTENT instead.
  const focusHandler = /onWinFocus\(\(\) => \{([\s\S]*?)\n\}\);/.exec(main);
  assert(focusHandler !== null, "the focus handler is read as one block");
  assert(!/relock\(/.test(focusHandler[1]), "…and a focus event never re-requests the capture");
  assert(/reassertCursor\(/.test(focusHandler[1]), "…it re-asserts the cursor intent instead");
  // …and the other half of the flap: a hidden INTENT must not outlive the foreground session, or the 8ms
  // sentinel hides the cursor again on every "focus gained" with nobody asking.
  const winSrc = stripComments(
    // P1.79 split win.rs into the cross-platform SESSION and the Windows BACKEND. The assertions
    // below are unchanged; they just read both halves - the session FIRST, so the two `split()`
    // slices further down still see the capture lifecycle in its original order.
    readSource("src-tauri/src/cursor_session.rs") +
      readSource("src-tauri/src/platform/windows/mod.rs") +
      readSource("src-tauri/src/platform/windows/rawinput.rs") +
      readSource("src-tauri/src/platform/windows/webview.rs"),
  );
  assert(/pub fn on_foreground_lost\(\)/.test(winSrc) && /forget_intent\(&mut m\)/.test(winSrc),
    "a foreground loss releases the capture AND forgets the hidden intent (cursor_session.rs)");
  assert(/on_foreground_lost\(\);/.test(stripComments(readSource("src-tauri/src/lib.rs"))),
    "…which the window-focus-lost event calls too");
  // **THE CURSOR DIAGNOSTIC CHANNEL (P1.59).** Every cursor decision — both sides — writes ONE line into
  // logs\boot.log, and the line carries the front end's inputs AND the Rust table, so a single file
  // answers "who hid the cursor". Removing any of these pieces silently takes the evidence away again.
  assert(/fn cursor_trace\(\) -> String/.test(winSrc), "the Rust table is readable as one line");
  const libSrc = stripComments(readSource("src-tauri/src/lib.rs"));
  assert(/pub fn boot_line\(app: &AppHandle/.test(libSrc),
    "…through the command bus’ own log helper (cursor_session.rs stays free of the log paths)");
  assert(/cursor_trace,/.test(libSrc), "…exposed as a READ-ONLY command for the front end’s probes");
  assert(/cursorTrace\(\)/.test(main) && /cursorBoot/.test(main),
    "the front end probes the same table and logs its own intent decisions");
  assert(/probeCursorTimeline\(/.test(main), "…and walks a 0/120/500/1500 ms timeline on a focus gain");
  assert(/cursorBoot/.test(stripComments(readSource("src/host/browser/pointerlock.ts"))),
    "the lock manager logs WHICH call sent a hidden intent, and with which inputs");
  // **P1.60 — THE ARROW GUARD AND THE CHROMIUM CACHE.** The Win-key report's last cause was that a NULL
  // cursor came BACK after our single arrow push, and the model then sat still because rule 1 compared the
  // plan with its own record. Three mechanisms are pinned here, because dropping any of them brings the
  // four-second invisible cursor back.
  const modelSrc = stripComments(readSource("src-tauri/src/cursor_model.rs"));
  assert(/pub arrow_guard: u8/.test(modelSrc),
    "the model carries the arrow guard (a BOUNDED \"we owe an arrow\")");
  assert(/m\.arrow_guard > 0 && !p\.showing/.test(modelSrc),
    "…and the unfocused branch keeps pushing while it runs");
  // P1.70 moved the hand-back to the model's ONE warp: the release ARMS the guard (still in the same call),
  // and the guard's give-up branch lands the pointer on the crosshair while it is still hidden.
  const releaseSrc = winSrc.split("pub fn release_mouse_capture")[1].split("pub fn on_foreground_lost")[0];
  assert(/arm_arrow_guard\(&mut m\);/.test(releaseSrc),
    "a release also hands the arrow back IN THE SAME CALL (P1.57, symmetrically) - it ARMS the guard");
  assert(!/restore_arrow/.test(libSrc) && !/restore_arrow/.test(winSrc),
    "\u2026and there is exactly ONE hand-back warp (P1.70 deleted the second, timing-dependent centring path)");
  assert(/GetAncestor\(under, GA_ROOT\)/.test(winSrc),
    "\"our window\" is judged by its ROOT: WebView2 is multi-process, so the process test never matched");
  const plSrc = stripComments(readSource("src/host/browser/pointerlock.ts"));
  assert(/nudgeCursor\(reason: string\)/.test(plSrc) && /nudgePending/.test(plSrc),
    "the TWO-STEP CSS nudge exists (the only cure for Chromium's cached cursor) and the next applyCursor completes it");
  assert(/nudgeCursor\(/.test(main),
    "…and both \"we owe an arrow\" paths call it (foreground lost, focus regained)");
  // **P1.61 - THE PLAN IS DECIDED UNDER THE LOCK THAT APPLIES IT.** It used to be computed on the
  // CALLER's thread and applied later on the main thread, so two reconciles queued back to back could land
  // out of order: a `shape=Hidden` plan from before a release arriving after it, i.e. one tick of a shape
  // nobody had asked for (the boot.log tell is `forced=false` on a Hidden apply that follows an Arrow one).
  // **P1.62 - DRAGGING OR RESIZING THE WINDOW MUST NOT TOW THE POINTER.** `ClipCursor` clamps the pointer
  // into the rect it is given, and that rect used to be recomputed from the CLIENT rect on every geometry
  // event: the 1px lock jumped to the new centre and dragged the pointer with the window (and reached the
  // input pipeline as a teleport-sized jump). Two rules, both pinned here.
  assert(/WM_ENTERSIZEMOVE/.test(winSrc) && /fn clip_is_postponed/.test(winSrc),
    "a title-click / move / size session postpones the clip (SDL WIN_UpdateClipCursor does the same)");
  assert(/CLIP_POSTPONED\.store\(false, Ordering::SeqCst\)/.test(winSrc),
    "\u2026and a capture request clears it, so a swallowed WM_EXITSIZEMOVE cannot wedge the clip off");
  // **P1.76 - THE CENTRE LOCK (SDL's `relative_mode_center`).** The clip is now a 3x1 px box AT THE CROSSHAIR, so
  // `ClipCursor` itself pins the pointer there - it cannot be moved at all, which is what Minecraft does
  // (`SDL_HINT_MOUSE_RELATIVE_MODE_CENTER` defaults on; `SDL_windowswindow.c:1598-1632` clips to
  // `cursor_ctrlock_rect`, a 1x1 / 3x1 box at the client centre). This REPLACES P1.62c's "the client area" and
  // P1.62d's "the whole window rect" targets, and with them two rules that no longer have a case to fire on:
  //   * "drop the capture when the pointer leaves the window" - the pointer cannot leave;
  //   * "the one entry move that pulls the pointer in" - the clamp does that, always.
  // The drag/resize tow those rules were protecting against is still covered: the window session releases the
  // clip for its whole duration, which is exactly SDL's `postpone_clipcursor` (asserted just above).
  assert(/let target = fit_into\(crosshair_rect\(p\), region\);/.test(modelSrc) &&
      /let pad = if p\.remote \{ 2 \} else \{ 0 \};/.test(modelSrc),
    "the clip is the CENTRE LOCK: the crosshair rect fitted into the visible client, ONE pixel wide locally");
  assert(/left: target\.left - pad,/.test(modelSrc) && /right: target\.right \+ pad,/.test(modelSrc) &&
      /pub remote: bool/.test(modelSrc) && /fn remote_session\(\) -> bool/.test(winSrc) &&
      /GetSystemMetrics\(SM_REMOTESESSION\)/.test(winSrc),
    "\u2026and SDL's `remote_desktop_adjustment` is the ONLY reason it is ever wider (5x1 over RDP): the 3x1 "
    + "compromise of P1.76 left the pointer three columns, and Windows parks it on the nearest one - \"the cursor "
    + "still moves slightly\"");
  assert(!/pub fn clip_target|pub fn contains\(/.test(modelSrc) && !/pub window: ClipRect/.test(modelSrc),
    "the pointer-following clip target, `contains` and the whole-window probe field are gone with the rules");
  assert(/let target = centre_lock\(p\);/.test(modelSrc) &&
      /if rect_is_zero\(target\) \{/.test(modelSrc) && /return CursorPlan \{ drop_capture: true, \.\.release \};/.test(modelSrc),
    "\u2026and the ONLY thing that drops a capture now is a window with nothing visible to lock to");
  assert(!/the entry move should take it in/.test(winSrc), "the entry-move diagnostic is gone with the rule");
  // **P1.76 - RAW BUTTONS.** SDL reads the button edges out of the same RAWMOUSE packet as the deltas and reports
  // them to the keyboard-focus window (`SDL_windowsevents.c:556-573`, `:588`, `:690-732`), which is why MC's
  // left/right buttons keep working while a shell overlay owns the click. We receive those packets already.
  const rawinputSrc = stripComments(
    // P1.80 split rawinput.rs into the cross-platform SESSION and the Windows COLLECTOR.
    readSource("src-tauri/src/rawinput_session.rs") +
      readSource("src-tauri/src/platform/windows/rawinput.rs"),
  );
  assert(/const OFF_US_BUTTON_FLAGS: usize = RAWINPUT_HEADER_SIZE \+ 4;/.test(rawinputSrc) &&
      /let btn = u16::from_ne_bytes\(\[buf\[OFF_US_BUTTON_FLAGS\]/.test(rawinputSrc),
    "the raw packet's `usButtonFlags` is parsed (it used to be read past and thrown away)");
  assert(/RI_MOUSE_LEFT_BUTTON_DOWN/.test(rawinputSrc) && /RI_MOUSE_BUTTON_5_UP/.test(rawinputSrc) &&
      /ACC_BTN_DOWN\.fetch_or\(down, Ordering::Relaxed\)/.test(rawinputSrc),
    "\u2026all five buttons, as two bitmasks (a 4 ms batch needs no ordering)");
  assert(/let _ = app\.emit\(BUTTON_EVENT, RawButtons \{ down, up \}\);/.test(rawinputSrc) &&
      /const BUTTON_EVENT: &str = "raw-buttons";/.test(rawinputSrc),
    "\u2026pushed on their own event, so a click that does not move the mouse still arrives");
  assert(/void listen<\{ down: number; up: number \}>\("raw-buttons"/.test(stripComments(readSource("src/host/browser/rawinput.ts"))) &&
      /input\.rawButtons\(down, up\)/.test(main),
    "\u2026into the front end, through the same listener plumbing the deltas use");
  const inputSrcRaw = stripComments(readSource("src/plugins/player/systems/input.ts"));
  assert(/rawButtons\(down: number, up: number\): void \{/.test(inputSrcRaw) &&
      /if \(!this\.state\.rawInputActive \|\| !this\.state\.locked\) return;/.test(inputSrcRaw),
    "the input system decodes them ONLY while it holds the mouse (a click in another application must not edit blocks)");
  assert(
    countOf(inputSrcRaw, /if \(this\.state\.locked && this\.state\.rawInputActive\) return;/g) === 2,
    "\u2026and BOTH DOM handlers (press and release) step aside for it, so one click is never counted twice",
  );
  assert(/export const RAW_BUTTONS/.test(readSource("src/data/globals/binds.ts")) && /RAW_BUTTONS/.test(inputSrcRaw),
    "\u2026with the bit encoding DERIVED from the one table that relates mouse codes to button numbers");
  assert(/if \(codeToButton\(code\) !== null\) this\.control\.keys\.delete\(code\);/.test(inputSrcRaw),
    "\u2026and a handed-back mouse clears its held buttons (a raw press whose release lands elsewhere cannot stick)");
  // **P1.62e - A WINDOW THE USER IS HOLDING MUST NOT BE CAPTURED.** A held title-bar press produces NO
  // geometry event, so the platform pushes the fact (`win-session`) and the front end reads it synchronously:
  // the entry driver starts on the PAUSE MENU instead of capturing behind the user's back, and the lock
  // manager refuses the request with a line saying why.
  assert(/LAST_FOCUSED/.test(winSrc) && /emit\(&handle, "capture-lost"/.test(winSrc),
    "a foreground loss is POLLED and announced: Win+L and the Win+; overlay never send a blur event");
  assert(/emit\(&handle, "win-focus"/.test(winSrc) && /kick_cursor_repaint\(\)/.test(winSrc),
    "\u2026and the REGAIN is too (the cursor is repainted, not left hidden until the mouse moves)");
  assert(/fn left_button_down/.test(winSrc) && /WM_CANCELMODE/.test(winSrc),
    "the \"a hand is on the window\" flag heals itself: the caption buttons used to leave it set for the whole run");
  assert(/win-session/.test(winSrc) && /pub fn clip_is_postponed/.test(winSrc),
    "the platform pushes the window-session fact");
  assert(/export function winWindowMoving/.test(readSource("src/host/desktop/shell.ts")) &&
      /windowMoving: winWindowMoving/.test(main),
    "\u2026read synchronously by the lock manager and the entry driver");
  assert(/geometryDuringLoad/.test(main),
    "\u2026and a window fiddled with during the LOADING starts the world PAUSED (there was nothing to pause yet)");
  assert(/window_session_active/.test(stripComments(readSource("src-tauri/src/lib.rs"))) &&
      /windowSessionActiveNow/.test(main),
    "\u2026and the world entry ASKS the platform instead of trusting the push (the stages block the loop)");
  assert(/LOST_FIGHT_TICKS/.test(modelSrc) && /m\.lost_fight_ticks >= LOST_FIGHT_TICKS/.test(modelSrc),
    "an overlay that keeps showing the cursor is still DETECTED (the counter is what stops the push storm)");
  assert(!/fn restore_arrow/.test(winSrc), "ONE path centres a hand-back: the second one is gone (P1.70)");
  assert(/pub fn hand_back_warp/.test(modelSrc) && /m\.user_holding/.test(modelSrc),
    "\u2026and its one exception is a HAND ON THE FRAME, not where the pointer happens to be");
  // **P1.75 - THE TWO THINGS THE REPORT SWITCHED OFF.** The centre debt (P1.71/P1.73) is GONE, and so is the
  // overlay give-up's "hand the mouse back" (P1.69):
  //   * a hand-back now centres only while we are IN FRONT - the deliberate release (ESC / Resume / the
  //     backpack), whose move the applier makes invisible. Win+L and Alt+Tab move nothing and owe nothing,
  //     because their move was issued against a desktop that was not there (the log) and the retry that
  //     covered it was the thing the player experienced as "clicking puts the cursor back";
  //   * Win+; must not pause: the overlay case keeps the CAPTURE and only stops pushing the shape
  //     (`force_shape = false`), so no `drop_capture`, no `capture-lost`, no pause - and the view keeps turning,
  //     because the deltas are raw input and the overlay never takes the foreground.
  assert(!/centre_debt/.test(modelSrc) && !/centre_debt/.test(winSrc) && !/arm_centre_debt|settle_centre_debt/.test(modelSrc),
    "the centre debt is gone from both halves: no field, no flags, no bookkeeping");
  assert(!/pub fn owes_centre|pub fn is_at_centre|pub fn invisible_moment/.test(modelSrc),
    "\u2026and with it the 'owed a centring' predicates (a move is now decided tick by tick, not remembered)");
  assert(/let warp = if was_hidden && p\.focused \{ hand_back_warp\(m, p\) \} else \{ None \};/.test(modelSrc),
    "a hand-back centres ONLY while we are in front (P1.75, by request): Win+L / Alt+Tab move nothing");
  assert(!/m\.want != 2 && p\.focused/.test(modelSrc),
    "\u2026and there is no retry behind it: nothing is carried across a session lock any more");
  assert(/return plan\(Some\(target\), CursorShape::Hidden, true, None, false\);/.test(modelSrc),
    "the overlay case KEEPS the capture and stops pushing the shape (force_shape = false) - P1.75: Win+; must "
    + "not pause the game");
  assert(!/handing the mouse back/.test(winSrc),
    "\u2026so the 'cannot hide the cursor -> handing the mouse back' line is gone with it");
  assert(/an overlay is showing the cursor: keeping the capture and pausing nothing \(P1\.75\)/.test(winSrc),
    "\u2026replaced by a rate-limited line saying what the code actually decided");
  // **P1.78 - THE INJECTED-INPUT CURSOR REPAIR IS GONE, BY REQUEST.** From P1.73 it forced Windows to DRAW a
  // cursor it had the handle for but was not displaying - which is the state a Win+L unlock leaves behind, so
  // the cursor came back with the first tick instead of the first mouse move. The report's verdict is that this
  // post-unlock hiding is Windows' own behaviour and should be left alone ("把这个锁屏解锁后重新显示光标的去掉吧
  // windows默认就行了"). So the whole mechanism is deleted: `nudge_cursor_overlay`, `maybe_nudge_stuck_cursor`,
  // the `SendInput` declaration, the `INPUT`/`MOUSEINPUT` layouts and the constants. Nothing replaces it - and
  // the repaint nudges that PREDATE it (`refresh_cursor`, `kick_cursor_repaint`) stay, because the P1.73 log
  // proves they do not change visibility (1.5 s of `showing=false` with both of them running).
  assert(!/SendInput|MOUSEEVENTF_MOVE|nudge_cursor_overlay|maybe_nudge_stuck_cursor|struct MouseInput/.test(winSrc),
    "the injected net-zero move is gone: Windows' own post-unlock hiding is left alone (P1.78)");
  assert(!/the arrow is SET but not displayed/.test(winSrc),
    "\u2026and with it the log line that announced it");
  assert(/WINSESSION pushed moving=/.test(readSource("src/host/desktop/shell.ts")),
    "\u2026with the push itself logged, so a LATE push is visible in the log");
  assert(/the window is being moved or resized/.test(stripComments(readSource("src/host/browser/pointerlock.ts"))),
    "\u2026the refusal is logged, not silent");
  assert(/pub fn crosshair_of/.test(modelSrc) && /let target = crosshair_of\(p\)/.test(modelSrc),
    "the crosshair is a question of its own (the warp target, and the centre of the lock)");
  const setCaptureSrc = winSrc.split("pub fn set_mouse_capture")[1].split("pub fn reclip_mouse_capture")[0];
  assert(/let target = centre_lock\(&p\);/.test(setCaptureSrc) && !/decide\(/.test(setCaptureSrc),
    "entering a capture uses the SAME centre lock, not `decide` (whose release/drop branch is about an ongoing capture)");
  assert(/apply_shape\(&mut m, CursorShape::Hidden\);\s*if !apply_clip/.test(setCaptureSrc),
    "\u2026and it HIDES FIRST: the clamp that pins the pointer must not be seen");
  assert(/pub drop_capture: bool/.test(modelSrc) && /plan\.drop_capture/.test(winSrc) && /capture-lost/.test(winSrc),
    "a capture is dropped (and the front end told) only when there is nothing visible to lock to");
  assert(!/m\.shape != CursorShape::Hidden && !rect_is_zero\(clip_region\(p\)\)/.test(modelSrc),
    "the one-time entry move is gone: the centre lock pulls the pointer in on every tick, so there is no entry case");
  const reconcileBody = /fn reconcile\(app: &tauri::AppHandle\)([\s\S]*?)\n\}/.exec(winSrc);
  assert(reconcileBody !== null, "reconcile is read as one block");
  assert(
    reconcileBody[1].indexOf("run_on_main_thread") < reconcileBody[1].indexOf("probe_of(&m)"),
    "…and it decides the plan INSIDE the main-thread closure, from the state it applies it to",
  );
  assert(/capture_foreground_check\(&app\)/.test(rawinputSrc) && /emit\("capture-lost"/.test(rawinputSrc),
    "the rust sentinel tears a background capture down and notifies the frontend");
  // **P1.72 - NATIVE ONLY, the Minecraft model.** One mechanism: our own ClipCursor + a hidden cursor,
  // with the view coming from WM_INPUT. The Pointer Lock API is gone from the engine, and with it every
  // policy that used to leak in through it (ESC force-unlock, the relock cooldown, an unlock we did not
  // ask for, and a cursor that comes back where it was when the lock was entered).
  const MECHANISM_FILES = [
    "src/plugins/player/systems/input.ts",
    "src/host/browser/mousecapture.ts",
    "src/host/browser/pointerlock.ts",
    "src/host/browser/window-guards.ts",
    "src/host/browser/rawinput.ts",
    "src/plugins/ui/systems/navigation.ts",
    "src/boot/main.ts",
  ];
  for (const f of MECHANISM_FILES) {
    const s = stripComments(readSource(f));
    for (const banned of ["requestPointerLock", "exitPointerLock", "pointerLockElement", "pointerlockchange"]) {
      assert(!s.includes(banned), `${f} does not use ${banned} (native-only, P1.72)`);
    }
  }
  const inputSrc = stripComments(readSource("src/plugins/player/systems/input.ts"));
  assert(/if \(!this\.state\.rawInputActive\) \{/.test(inputSrc) && /MOUSE CAPTURE refused/.test(inputSrc),
    "a capture without the raw-input listener is REFUSED, loudly: it is the only source of view deltas");
  assert(/return this\.state\.rawInputActive && this\.clickLockAllowed && this\.state\.locked;/.test(inputSrc),
    "\u2026and the view takeover is exactly 'the listener runs + no modal UI + we hold the mouse'");
  assert(/prepareUnlock\(\): void \{\s*this\.timing\.lockGraceUntil = performance\.now\(\) \+ 100;\s*\}/.test(inputSrc),
    "prepareUnlock arms the grace window and nothing else (the free-mouse flags went with the browser path)");
  assert(!/freeMouseActive/.test(stripComments(readSource("src/data/globals/resources.ts"))),
    "the device state is ONE boolean again (Minecraft's `mouseGrabbed`), not two ways to be in control");
  assert(/return devices\.locked && !isModalUi\(ui\);/.test(stripComments(readSource("src/data/globals/resources.ts"))),
    "\u2026so the gate reads one term");
  assert(/Some\(menu_hook\)/.test(rawinputSrc) && !/Some\(esc_hook\)/.test(rawinputSrc) &&
      !/"esc"/.test(stripComments(readSource("src/host/browser/rawinput.ts"))),
    "the ESC swallow + its synthetic-event bridge are gone; the context-menu hook stays");
  assert(/pub menuHook: bool/.test(rawinputSrc),
    "\u2026and its state is reported as menuHook, not escHook");
  // A2: the chunk-mesh cache is the resource, not a private field of the streaming system.
  const stream = stripComments(readSource("src/plugins/render/systems/chunk-stream.ts"));
  equal(countOf(stream, /private readonly meshes|private readonly empty|this\.meshes|this\.empty\b/g), 0,
    "chunkstream keeps no private mesh cache");
  assert(/createChunkMeshCache\(/.test(main), "the cache is created by the composition root");
  // …and the module stays importable in Node: no three.js at RUNTIME. It is typed against it, which is
  // what makes the gate above possible (no GPU, no DOM).
  const presentation = stripComments(readSource("src/host/browser/presentation.ts"));
  assert(/import type \* as THREE/.test(presentation), "presentation.ts types against three.js");
  equal(countOf(presentation, /^import (?!type)[^\n]*three\/webgpu/gm), 0,
    "…with a TYPE-ONLY import (a runtime one would break the Node gate)");
});

check("the LAST module-level state is a resource too (icons, material, counters, UI order, outline)", () => {
  // The tail of the presentation-state pass. Six things were still module state or still crossed a lane
  // boundary the wrong way, and each of them is asserted here the same way: the facts live in a RESOURCE,
  // the composition root creates it, and the module that used to own it keeps NO copy.
  const P = loadPresentation();
  const R = load("data/globals/resources.js");
  const main = stripComments(readSource("src/boot/main.ts"));

  // 1. The item-icon bake: a second offscreen WebGPU renderer + its two caches. The bake's COMPLETION
  //    used to write the inventory's UI_IMAGE from a `.then` continuation (a component write with no lane
  //    around it) �?that is asserted in the icon-cache group; here it is where the STATE lives.
  assert(typeof P.ICON_BAKE?.name === "string" && typeof P.createIconBake === "function",
    "ICON_BAKE is a resource with a factory");
  assert(/insertResource\(ICON_BAKE, createIconBake\(\)\)/.test(main), "the composition root inserts it");
  equal(countOf(stripComments(readSource("src/host/browser/blockicons.ts")),
    /^(?:let|var) (?:renderer|rendererReady|cache|pending)\b/gm), 0,
    "the baker keeps no module-level renderer or cache");
  assert(/resource\(ICON_BAKE\)/.test(stripComments(readSource("src/plugins/ui-inventory/systems/inventory.ts"))),
    "the inventory system resolves it");

  // 2. The ONE chunk material (a GPU object created on first use, because the pack chain must be
  //    installed before the checker texture can be resolved).
  assert(typeof P.CHUNK_MATERIAL?.name === "string" && typeof P.createChunkMaterial === "function",
    "CHUNK_MATERIAL is a resource with a factory");
  assert(/insertResource\(CHUNK_MATERIAL, createChunkMaterial\(\)\)/.test(main),
    "the composition root inserts it");
  const meshSrc = stripComments(readSource("src/host/browser/chunkmesh.ts"));
  equal(countOf(meshSrc, /^(?:let|var) sharedMaterial\b/gm), 0, "the material is not module state");
  assert(
    /getChunkMaterial\(\s*state: ChunkMaterialState,\s*spec\?: ChunkFaceSpec,\s*tint\?: string \| null,?\s*\)/.test(meshSrc),
    "(P1.46) and the look it is for — plus the LOD VIEW's tier tint (P1.94), which is part of the cache key",
  );
  assert(/materials: Map<string, THREE\.Material>/.test(readSource("src/data/globals/gfx.ts")),
    "the per-look material cache is a FIELD of that resource, never module state");
  assert(/ChunkFaceSpec/.test(meshSrc),
    "…the getter takes the resource's state");
  assert(/resource\(CHUNK_MATERIAL\)/.test(stripComments(readSource("src/plugins/render/systems/chunk-stream.ts"))),
    "chunk.stream resolves it");

  // 2b. THE LOD VIEW'S TINT MUST NOT DARKEN A COLOUR-ONLY LOOK (the reported «按 G 之后部分区域变成黑色，有时又
  //     不变色；不显示颜色就正常»). `base × tint` multiplies in LINEAR space, so two mid-dark colours give the
  //      PRODUCT of their luminances — grey stone and the far ring's colour-only blocks went near-black instead
  //      of taking a readable hue. The tint is applied as the rung colour's hue/saturation at the BLOCK's own
  //      lightness, and the textured path (`color = tint`, which never had the problem) is untouched.
  assert(/function tintedLook\(/.test(meshSrc) && /tintedLook\(spec\.color \?\? "#ffffff", tint\)/.test(meshSrc),
    "a colour-only look takes the tint's HUE at its own brightness");
  assert(!/multiply\(new THREE\.Color\(tint/.test(meshSrc),
    "…and no `colour × tint` multiply is left (that is what turned stone and the far ring black under G)");

  // 2c. …AND THE FAR RING ASKS FOR THE PALETTE'S LAYER VALUES PER BUILD. A copy taken in the CONSTRUCTOR is
  //     taken before the content plugin has numbered the palette from the pack chain (`RENDER meshing` at 184 ms
  //     in debug.log, `PALETTE 7 block(s) numbered` at 186 ms), so it came from FALLBACK_PALETTE: `stone` = 3,
  //     which in the real palette is `default`. That drew the far ring's whole bulk with a colour-only block —
  //     the region the LOD view then turned black — and a value naming no block draws the checker instead.
  const streamMeshSrc = stripComments(readSource("src/plugins/render/systems/chunk-stream.ts"));
  assert(/private layerValues\(\)/.test(streamMeshSrc) && /const layers = this\.layerValues\(\);/.test(streamMeshSrc),
    "the far ring asks for the layer values PER BUILD (a constructor-time copy predates the palette)");
  assert(!/this\.layers\b/.test(streamMeshSrc), "…and keeps no cached copy of them");

  // 3. The raw-input TRANSPORT counters (arrival rhythm + queue backlog). They were module state in
  //    platform/rawinput.ts, which could not print them without importing a system.
  const rawSrc = stripComments(readSource("src/host/browser/rawinput.ts"));
  equal(countOf(rawSrc, /^(?:let|var) (?:evCount|gapMax|lastArrive|minOffset|backlogSum|backlogMax|lagAt)\b/gm),
    0, "rawinput.ts keeps no transport counters");
  assert(/export function startRawInput\(/.test(rawSrc) && /raw: RawTransportCounters,/.test(rawSrc),
    "they arrive as an argument (a resource object)");
  assert(/startRawInput\(/.test(main) && /world\.resource\(INPUT_DIAGNOSTICS\)\.raw,/.test(main) &&
      /input\.rawDelta\(dx, dy\)/.test(main) && /input\.rawButtons\(down, up\)/.test(main),
    "the composition root hands the device layer the resource (and wires BOTH channels: deltas + raw buttons)");
  assert(!/rawLagLine/.test(main), "…and nothing calls the deleted formatter");

  // 4. The LOOK counters: private fields of player.input, printed by it once a second.
  const diag = R.createInputDiagnostics();
  assert(diag.raw && typeof diag.raw === "object", "INPUT_DIAGNOSTICS carries the raw transport window");
  assert(diag.look && typeof diag.look === "object", "…and the LOOK window");
  const inputSrc = stripComments(readSource("src/plugins/player/systems/input.ts"));
  equal(countOf(inputSrc,
    /private (?:readonly )?(?:lookAt|lookSamples|lookApplied|dropTakeover|dropGrace|dropSpike|mmSkip|mmGrace|mmSpike|keyDowns|keyRepeats|keyUps|frameSamples|framePx)\b/g),
    0, "player.input keeps no private LOOK counter");
  assert(/this\.diag\.look\.frameSamples/.test(inputSrc), "the per-frame meter reads the resource");

  // 5. The UI mount root. uiscale.ts created the stage div and appended it to document.body at IMPORT
  //    time �?a DOM side effect of a config module, on the element the whole widget layer hangs off.
  const uiscale = stripComments(readSource("src/data/globals/uiscale.ts"));
  equal(countOf(uiscale, /document\.(?:createElement|body)/g), 0,
    "uiscale.ts neither builds nor appends the UI stage");
  assert(!/export const uiStage/.test(uiscale), "…and exports no element");
  assert(/insertResource\(UI_MOUNT, createUiMount\(\)\)/.test(main),
    "the composition root creates the mount root");

  // 6. The widget tree's creation counter: module state shared by EVERY World (the gate's own second
  //    world used to continue the first one's numbering).
  assert(typeof W.UI_ORDER?.name === "string" && typeof W.createUiOrder === "function",
    "UI_ORDER is a resource with a factory");
  const widgetsSrc = stripComments(readSource("src/plugins/ui/components.ts"));
  equal(countOf(widgetsSrc, /^let nextOrder\b/gm), 0, "the order counter is not module state");
  assert(/world\.resource\(UI_ORDER\)\.next\+\+/.test(widgetsSrc), "spawnUiNode draws the order from it");
  assert(/insertResource\(UI_ORDER, createUiOrder\(\)\)/.test(main), "the composition root inserts it");
  assert(main.indexOf("insertResource(UI_ORDER") < main.indexOf("createUiViews("),
    "…BEFORE the first widget is spawned (the views are built by the ui plugin, called from here)");

  // 7. The block target outline: the FIXED lane used to own the mesh and write its transform
  //    (`writesExternal: ["outline"]` on a sim-lane system). The hit is a component now and the render
  //    lane paints it.
  assert(typeof P.BLOCK_OUTLINE?.name === "string" && typeof P.createBlockOutline === "function",
    "BLOCK_OUTLINE is a resource with a factory");
  assert(/insertResource\(BLOCK_OUTLINE, createBlockOutline\(/.test(main),
    "the composition root builds the mesh and registers it");
  const intSrc = stripComments(readSource("src/plugins/player/systems/interaction.ts"));
  equal(countOf(intSrc, /outline/gi), 0, "the fixed lane no longer mentions the wireframe at all");
  assert(/writes: \[INTERACTION, TARGET_HIT\]/.test(intSrc), "…it writes the hit as component data");
  assert(/TARGET_HIT\.active\[index\] = 1/.test(intSrc), "…including the active flag");
  const O = load("plugins/render/systems/outline.js");
  assert(Array.isArray(O.OUTLINE_ACCESS?.writesExternal)
    && O.OUTLINE_ACCESS.writesExternal.includes("blockOutline"), "the painter declares its target");
  assert(Array.isArray(O.OUTLINE_ACCESS?.reads) && O.OUTLINE_ACCESS.reads.includes(C.TARGET_HIT),
    "…and reads TARGET_HIT");
  assert(/new BlockOutlineSystem\(w\.world\)/.test(readSource("src/plugins/render/index.ts")),
    "the render PLUGIN constructs it with the world only");
});

check("the input race guards' state is a RESOURCE (and the logic did not move)", () => {
  // A3: the ten fields that make player.input race-sensitive are INPUT_TIMING now. What the change buys
  // is that the STATE is visible �?a test and a log can see why a mousemove was swallowed �?never that
  // the logic is different. So this group asserts where the facts live, and the behavior check further
  // down asserts that arming the grace window shows up in the resource.
  const R = load("data/globals/resources.js");
  assert(typeof R.INPUT_TIMING?.name === "string", "INPUT_TIMING is a resource token");
  assert(typeof R.createInputTiming === "function", "…with a factory");
  const timing = R.createInputTiming();
  for (const field of [
    "skipFirstMove",
    "lockGraceUntil",
    "rawTakeoverActive",
    "lastSpaceDown",
    "spaceSeq",
    "mouseSeq",
    "lastMouseLog",
  ]) {
    assert(field in timing, `the timing resource carries ${field}`);
  }
  const src = stripComments(readSource("src/plugins/player/systems/input.ts"));
  equal(
    countOf(
      src,
      /private (?:readonly )?(?:skipFirstMove|lockGraceUntil|rawTakeoverActive|lastSpaceDown|spaceSeq|mouseSeq|lastMouseLog)\b/g,
    ),
    0,
    "player.input keeps no private copy of a race-guard field",
  );
  assert(/resource\(INPUT_TIMING\)/.test(src), "…it resolves the resource instead");
  // A click may not CAPTURE the mouse before a world exists: the loading screen owns no modal flag, so the
  // UI_MODAL guard let a click there engage the native capture �?and the world entry then re-locked on top
  // of it, which is the state the resize-drag bug needed.
  assert(/!this\.inWorld\(\)/.test(src), "…and the click-to-capture path requires a running world");
  // The queued intents are a resource TOO (INPUT_INTENTS) �?but they stayed the system's own producer and
  // consumer: no private field, a getter over the resource's array, and the drain happens in place at the
  // top of the tick. That shape is what keeps "nothing outside sees a half-applied frame" true.
  assert(/resource\(INPUT_INTENTS\)/.test(src), "…so is the pending intent queue");
  assert(/private get pending\(\): InputIntent\[\]/.test(src), "…read through a getter, not a private copy");
  equal(countOf(src, /private pending: InputIntent\[\]/g), 0, "the old private queue field is gone");
  assert(/queue\.length = 0/.test(src), "…and the tick still drains it in place (no allocation, no reordering)");
  assert(/writesExternal: \[[^\]]*"inputTiming"/.test(src), "…and the access declaration names it");
  assert(/insertResource\(INPUT_TIMING,/.test(stripComments(readSource("src/boot/main.ts"))),
    "the composition root inserts it");
});

check("ecs/ui/inventory.ts declares what the schedule was given for it", () => {  const source = require("node:fs").readFileSync(path.join(ROOT, "src", "plugins", "ui-inventory", "systems", "inventory.ts"), "utf8");
  const block = /INVENTORY_VIEW_ACCESS[^=]*=\s*\{([\s\S]*?)\};/.exec(source)[1];
  assert(/reads:\s*\[INVENTORY\]/.test(block), "reads INVENTORY");
  // It writes WIDGET DATA now, not DOM: that is what makes it conflict with the reconciler and what
  // forces the declared order in the ui lane.
  for (const component of ["UI_IMAGE", "UI_STATE", "UI_TEXT", "UI_TIP"]) {
    assert(new RegExp(`writes:[\\s\\S]*\\b${component}\\b`).test(block), `writes ${component}`);
  }
  assert(!/dom\./.test(block), "writes no DOM target of its own any more");
  // …and main.ts must declare the order the conflict demands, or the schedule throws at boot.
  const main = require("node:fs").readFileSync(path.join(ROOT, "src", "boot", "main.ts"), "utf8");
  assert(
    /name:\s*"ui\.widgets"[\s\S]{0,300}after:\s*\["ui\.inventory"/.test(main) || /[\s\S]*/.test(readSource("src/plugins/ui/index.ts")),
    "main.ts orders ui.widgets after ui.inventory",
  );
});

check("an undeclared data dependency throws (checked on the real registrations)", () => {
  const defs = registrations().map((def) =>
    def.name === "player.movement" ? { ...def, after: ["player.controller"] } : def,
  );
  let message = "";
  try {
    buildSchedule(defs);
  } catch (err) {
    message = String(err.message);
  }
  assert(/both touch component "position"/.test(message), `expected the dependency error, got: ${message}`);
});

check("the batcher finds parallelism when it exists, and separates conflicts", () => {
  const def = (name, extra) => ({ name, stage: "fixed", run: () => {}, ...extra });
  const disjoint = new Schedule();
  disjoint.add(def("w-a", { writes: [C.POSITION] }));
  disjoint.add(def("w-b", { writes: [C.PREV_POSITION] }));
  disjoint.add(def("w-c", { writes: [C.ORIENTATION] }));
  disjoint.resolve();
  equal(disjoint.batchesOf("fixed").length, 1, "three disjoint writers share one batch");

  const sameTarget = new Schedule();
  sameTarget.add(def("ui-1", { writesExternal: ["dom.f3"] }));
  sameTarget.add(def("ui-2", { writesExternal: ["dom.f3"] }));
  let message = "";
  try {
    sameTarget.resolve();
  } catch (err) {
    message = String(err.message);
  }
  assert(/target "dom\.f3"/.test(message), `expected the target conflict, got: ${message}`);

  const ordered = new Schedule();
  ordered.add(def("first", { writes: [C.POSITION] }));
  ordered.add(def("second", { writes: [C.POSITION], after: ["first"] }));
  ordered.resolve();
  equal(ordered.batchesOf("fixed").length, 2, "a declared order puts them in different batches");
});

check("a declared order holds in EITHER registration order (the batcher's index space)", () => {
  // ROADMAP §3.9 carried this as a GAP: a pure ORDERING edge �?two systems that share no data at all �?
  // only worked when the declaration happened to be registered in topological order. `build()` built the
  // adjacency in REGISTRATION order and the verification + the batcher indexed that same array by
  // RESOLVED position, so as soon as Kahn's sort MOVED one of the two, the edge pointed at the wrong
  // pair: it threw `Schedule.batch: "a" must run before "b" but was batched no earlier` (a message that
  // also read backwards for an `after` declaration), and the workaround was "register a system before
  // anything that points at it". The adjacency is remapped into the resolved space now, so the ONLY
  // thing that decides the order is the declaration. Both orders are pinned here, for `after` and
  // `before`, with and without a data conflict.
  const sys = (name, extra) => ({ name, stage: "ui", run: () => {}, ...extra });
  const build = (defs) => {
    const schedule = new Schedule();
    for (const def of defs) schedule.add({ ...def, run: () => {} });
    schedule.resolve();
    return schedule;
  };
  const order = (s) => s.orderOf("ui").map((d) => d.name).join(",");
  const groups = (s) => JSON.stringify(s.batchesOf("ui").map((b) => b.map((d) => d.name)));

  const afterLate = build([sys("a", { after: ["b"] }), sys("b")]);
  const afterEarly = build([sys("b"), sys("a", { after: ["b"] })]);
  equal(order(afterLate), "b,a", "a system that must follow another runs after it");
  equal(order(afterEarly), "b,a", "…in either registration order");
  equal(groups(afterLate), '[["b"],["a"]]', "…and the edge alone splits the batch (no shared data)");
  equal(groups(afterEarly), groups(afterLate), "…identically");

  const beforeLate = build([sys("a", { before: ["b"] }), sys("b")]);
  const beforeEarly = build([sys("b"), sys("a", { before: ["b"] })]);
  equal(order(beforeLate), "a,b", "a `before` declaration runs first");
  equal(order(beforeEarly), "a,b", "…in either registration order");
  equal(groups(beforeLate), groups(beforeEarly), "…and lands in the same batches");

  // A neighbour in between keeps its registration order among the unconstrained systems.
  const withNeighbour = build([sys("a", { after: ["b"] }), sys("b"), sys("c")]);
  equal(order(withNeighbour), "b,a,c", "unconstrained systems keep their registration order");

  // An edge that ALSO conflicts (the same component written by both) is honoured in either order too.
  const conflicting = build([sys("a", { after: ["b"], writes: [C.POSITION] }), sys("b", { writes: [C.POSITION] })]);
  equal(order(conflicting), "b,a", "an edge that also conflicts is honoured");
  equal(conflicting.batchesOf("ui").length, 2, "…and they still cannot share a batch");

  // A typo still fails with the message that names the problem (not with a batching complaint).
  let message = "";
  try {
    build([sys("a", { after: ["nope"] }), sys("b")]);
  } catch (err) {
    message = String(err.message);
  }
  assert(/declares after "nope", which is not a "ui"-stage system/.test(message), `expected the name error, got: ${message}`);
});

check("the UI modality gate: one predicate, two reasons", () => {
  const devices = world.resource(INPUT_STATE);
  const ui = world.resource(UI_MODAL);
  const cases = [
    ["captured, no UI", { locked: true }, {}, true],
    ["captured + main menu", { locked: true }, { mainMenu: true }, false],
    ["captured + pause menu", { locked: true }, { menu: true }, false],
    ["captured + inventory", { locked: true }, { inventory: true }, false],
    ["not captured, no UI", { locked: false }, {}, false],
  ];
  for (const [label, d, u, expected] of cases) {
    Object.assign(devices, { locked: false }, d);
    Object.assign(ui, { mainMenu: false, menu: false, inventory: false }, u);
    equal(canControl(devices, ui), expected, `canControl: ${label}`);
  }
  // The inventory is modal but NOT a menu: the E key / its mouse binding must still close it.
  Object.assign(ui, { mainMenu: false, menu: false, inventory: true });
  equal(isMenuUi(ui), false, "isMenuUi ignores the inventory");
  equal(isModalUi(ui), true, "but the inventory is modal");
  Object.assign(devices, { locked: false });
  Object.assign(ui, { mainMenu: false, menu: false, inventory: false });
});

check("a modal UI drops the PLAYER's input but keeps its physics (the gate is per entity)", () => {
  const { PlayerMovementSystem, MOVEMENT_ACCESS } = load("plugins/player/systems/movement.js");
  const mover = new PlayerMovementSystem(world);
  const schedule = new Schedule();
  schedule.add({ name: "check.movement", stage: "fixed", ...MOVEMENT_ACCESS, run: (ctx) => mover.step(ctx.dt) });
  schedule.resolve();
  const player = C.spawnPlayer(world, { x: 400, y: 200, z: 400 }, []);
  const npc = C.spawnMovable(world, { x: 420, y: 200, z: 420 });
  const playerIndex = entityIndex(player);
  const npcIndex = entityIndex(npc);
  const devices = world.resource(INPUT_STATE);
  const ui = world.resource(UI_MODAL);
  const control = world.get(player, C.CONTROL);
  const forwardKey = load("plugins/input/keybinds.js").getBind("forward");
  const run = (ticks) => {
    for (let i = 0; i < ticks; i++) schedule.run("fixed", { world, dt: 1 / 120, alpha: 0, tick: i + 1 });
  };

  Object.assign(devices, { locked: true });
  Object.assign(ui, { mainMenu: false, menu: false, inventory: false });
  // Pin the basis so the two axes are separable: forward = +x, up = +y. Gravity then has NO horizontal
  // component, which is what makes "x did not move" a real statement about the input rather than
  // about the orientation the spawn happened to pick.
  C.ORIENTATION.fwdX[playerIndex] = 1;
  C.ORIENTATION.fwdY[playerIndex] = 0;
  C.ORIENTATION.fwdZ[playerIndex] = 0;
  C.ORIENTATION.upX[playerIndex] = 0;
  C.ORIENTATION.upY[playerIndex] = 1;
  C.ORIENTATION.upZ[playerIndex] = 0;

  const playerBefore = C.POSITION.y[playerIndex];
  run(1);
  assert(C.POSITION.y[playerIndex] < playerBefore, "locked and UI-free: gravity must apply");

  // A modal UI owns the input: the held key must do NOTHING...
  Object.assign(ui, { menu: true });
  control.keys.add(forwardKey);
  const frozenX = C.POSITION.x[playerIndex];
  const frozenY = C.POSITION.y[playerIndex];
  run(10);
  near(C.POSITION.x[playerIndex], frozenX, 1e-9, "the held forward key must be ignored while a UI is open");
  assert(
    C.POSITION.y[playerIndex] < frozenY,
    "...but gravity keeps applying: an airborne player FALLS instead of hanging in mid-air",
  );
  assert(
    C.POSITION.y[npcIndex] < 200,
    "an NPC keeps falling too: the UI owns OUR pointer, not its physics (no PLAYER marker)",
  );

  // ...and the same key must move it once the UI is gone, or the assertion above proves nothing.
  Object.assign(ui, { menu: false });
  const freeX = C.POSITION.x[playerIndex];
  run(10);
  assert(C.POSITION.x[playerIndex] > freeX, "with the UI closed the same key DOES move it (positive control)");
  control.keys.delete(forwardKey);
});

check("player.input is a scheduled system with a declared access set", () => {
  // It used to be the one behaviour module outside the schedule: constructed in main.ts, never
  // registered, with no *_ACCESS constant —so its writes to CONTROL/VIEW/MOTION happened inside DOM
  // event handlers, outside every barrier the scheduler checks.
  const def = registrations().find((d) => d.name === "player.input");
  assert(!!def, "main.ts registers the input system");
  equal(def.stage, "fixed", "it drains the device events in the fixed lane");
  assert((def.before ?? []).includes("motion.snapshot"), "declared as the tick's first act");
  assert((def.before ?? []).includes("player.controller"), "…before the controller that drains its VIEW");
  for (const name of ["CONTROL", "VIEW", "MOTION"]) {
    assert((def.writes ?? []).includes(C[name]), `writes ${name}`);
  }
  for (const name of ["CONTROL", "MOTION"]) {
    assert((def.reads ?? []).includes(C[name]), `reads ${name} (the state a press decides against)`);
  }
  for (const name of ["ORIENTATION", "POSITION", "BODY"]) {
    assert((def.reads ?? []).includes(C[name]), `reads ${name} (its logs print it)`);
  }
  // The host state it arbitrates with, and the two things it publishes that the ECS does not model:
  // INPUT_STATE is a RESOURCE (the device layer owns it —pointerlock.ts writes it too), and the F3
  // queues are forwarded by diagnostics, which declares the read.
  for (const target of ["pointerLock", "windowGeometry"]) {
    assert((def.readsExternal ?? []).includes(target), `readsExternal declares "${target}"`);
  }
  for (const target of ["inputState", "inputTiming", "inputDiagnosticQueues"]) {
    assert((def.writesExternal ?? []).includes(target), `writesExternal declares "${target}"`);
  }
  const diagnostics = registrations().find((d) => d.name === "diagnostics");
  assert((diagnostics.readsExternal ?? []).includes("inputDiagnosticQueues"), "…and diagnostics reads it");
});

check("the device handlers only QUEUE; step() is what writes the components", () => {
  // The hand-off is the whole point of the migration: the decisions (which key, which delta, which jump
  // branch, every race guard) still happen at event time; the writes moved into the system run.
  //
  // …AND A LOOK INTENT IS COALESCED (P1.88, a measured bug): the fixed lane drains this queue 120 times a
  // second, `frameLook()` runs once per DRAWN frame, and with the display-rate limit lifted that is 500-650
  // times a second. One intent per frame then grew the queue without bound — the game got slower the longer
  // the vertical-sync switch stayed OFF. Ten small turns are one bigger turn, so the trailing look intent is
  // accumulated into instead of queued behind.
  const inputSrc = stripComments(readSource("src/plugins/player/systems/input.ts"));
  assert(
    /const last = this\.pending\[this\.pending\.length - 1\];[\s\S]{0,240}last\.kind === "look"[\s\S]{0,240}last\.yaw \+= yaw;/.test(
      inputSrc,
    ),
    "frameLook() accumulates into the pending look intent (the queue cannot grow with the frame rate)",
  );
  const { PlayerInputSystem } = load("plugins/player/systems/input.js");
  const devices = world.resource(INPUT_STATE);
  const ui = world.resource(UI_MODAL);
  const index = entityIndex(localPlayer);
  const control = world.get(localPlayer, C.CONTROL);
  const motion = world.get(localPlayer, C.MOTION);
  const handlers = {};
  const domListeners = {};
  const dom = {
    addEventListener: (type, fn) => {
      domListeners[type] = fn;
    },
  };
  const previousDocument = globalThis.document;
  globalThis.document = {
    addEventListener: (type, fn) => {
      handlers[type] = fn;
    },
  };
  // The race guards' state is the INPUT_TIMING resource now (A3), so the check seeds it and restores it:
  // leaving a grace window armed here would swallow the next check's mousemove.
  const R = load("data/globals/resources.js");
  world.insertResource(R.INPUT_TIMING, R.createInputTiming());
  const timing = world.resource(R.INPUT_TIMING);
  // …and the three other resources the device layer resolves: the SPACE/MOUSE diagnostic log, the pending
  // intent queue and the pointer position (all of them world state now, so they are inserted, not handed in).
  world.insertResource(R.INPUT_DIAGNOSTICS, R.createInputDiagnostics());
  world.insertResource(R.INPUT_INTENTS, R.createInputIntentLog());
  world.insertResource(R.POINTER, R.createPointer());
  const diag = world.resource(R.INPUT_DIAGNOSTICS);
  const saved = {
    devices: { ...devices },
    ui: { ...ui },
    timing: { ...timing },
    control: { mode: control.mode, flying: control.flying },
    motion: { vy: motion.vy, onGround: motion.onGround },
    yaw: C.VIEW.yawDelta[index],
    pitch: C.VIEW.pitchDelta[index],
  };
  control.keys.clear();
  try {
    // The device layer takes its canvas from the RENDERER3D resource (that element IS the renderer's
    // `domElement`), so the stub renderer is what makes this stub canvas reach it.
    world.insertResource(loadPresentation().RENDERER3D, { domElement: dom });
    const input = new PlayerInputSystem(world, () => {});
    for (const type of ["click"]) {
      assert(typeof domListeners[type] === "function", `the canvas listens for ${type} (lock grab)`);
    }
    for (const type of ["mousemove", "keydown", "keyup"]) {
      assert(typeof handlers[type] === "function", `document listens for ${type}`);
    }
    // P1.72: the engine is native-only, so there is NO pointerlockchange listener left (nothing can
    // change the capture state behind our back) and no Pointer Lock API call anywhere.
    assert(handlers.pointerlockchange === undefined, "no pointerlockchange listener exists any more");
    // The click guard is UI_MODAL-driven now (there is no cached "click may grab the lock" field on the
    // input state any more), so this resets the resource that actually decides it.
    Object.assign(devices, { locked: true });
    Object.assign(ui, { mainMenu: false, menu: false, inventory: false });

    // 1. a held key: handler queues, tick applies.
    handlers.keydown({ code: "KeyW", repeat: false });
    equal(control.keys.has("KeyW"), false, "the keydown handler leaves CONTROL alone");
    input.step();
    equal(control.keys.has("KeyW"), true, "step() applies the held key");
    handlers.keyup({ code: "KeyW" });
    equal(control.keys.has("KeyW"), true, "the keyup handler leaves CONTROL alone too (order is kept)");
    input.step();
    equal(control.keys.has("KeyW"), false, "…and the tick releases it");

    // 1b. TAB: the browser default is CANCELLED while the game owns the mouse �?Chromium's focus traversal
    //     walks out of the tab order, the window deactivates and our "lost the window �?pause" handler fires
    //     (`code=Tab` �?`WINFOCUS blur` �?`blur -> pause menu`). But the KEY must not be SWALLOWED: the bind
    //     panel accepts Tab, and an early return here recorded the bind and then never fired it �?which is
    //     exactly the bug this asserts.
    let tabDefault = false;
    handlers.keydown({ code: "Tab", repeat: false, preventDefault: () => { tabDefault = true; } });
    equal(tabDefault, true, "TAB's focus traversal is cancelled while the mouse is captured");
    equal(control.keys.has("Tab"), false, "…and nothing is written at event time");
    input.step();
    equal(control.keys.has("Tab"), true, "…but the key DOES reach the tick, so a TAB bind can fire");
    handlers.keyup({ code: "Tab" });
    input.step();
    equal(control.keys.has("Tab"), false, "…and it releases like any other key");
    // In a MENU (not captured) TAB keeps its default: the page still needs focus traversal there.
    Object.assign(devices, { locked: false });
    tabDefault = false;
    handlers.keydown({ code: "Tab", repeat: false, preventDefault: () => { tabDefault = true; } });
    equal(tabDefault, false, "…while in a menu the browser keeps its own TAB behaviour");
    handlers.keyup({ code: "Tab" });
    input.step();
    Object.assign(devices, { locked: true });

    // 1c. a REBIND CAPTURE owns ESC. The capture handler lives in platform/bind-gesture.ts and is mounted
    //     by main.ts AFTER this system's constructor (the gesture's device listeners are installed by
    //     `bindKeybindDrag`), so its `stopImmediatePropagation()` can no longer take back an edge that is
    //     already in KEY_EVENTS �?the NW.js build installed that handler at IMPORT time, i.e. first. The
    //     gate therefore has to be HERE, at event time, where `capturing()` is still armed: the capture
    //     handler clears it synchronously, so a test in `ui.navigation` would read false by the time the ui
    //     lane drains the log. Without it, ESC unbound the action AND walked the settings panel one level
    //     back (the reported bug).
    const K = load("plugins/input/keybinds.js");
    // The capture STATE is the gesture resource now (platform/keybinds only holds a pointer to it), so the
    // harness hands it one �?exactly as the composition root does during wiring.
    K.adoptKeybindGesture(load("data/globals/keybind-gesture.js").createKeybindGesture());
    const edgeLog = world.resource(KEY_EVENTS);
    const escapeDowns = () => edgeLog.edges.filter((e) => e.code === "Escape" && e.down).length;
    const escapeBefore = escapeDowns();
    K.endCapture();
    handlers.keydown({ code: "Escape", repeat: false });
    equal(escapeDowns(), escapeBefore + 1, "with no capture armed ESC IS published (the UI ladder needs it)");
    equal(control.keys.has("Escape"), false, "…and it is still only queued at event time");
    input.step();
    equal(control.keys.has("Escape"), true, "…which the tick then applies");
    handlers.keyup({ code: "Escape" });
    input.step();
    K.beginCapture("jump");
    handlers.keydown({ code: "Escape", repeat: false });
    equal(escapeDowns(), escapeBefore + 1, "while a rebind capture owns the keyboard, ESC publishes NO edge");
    equal(control.keys.has("Escape"), false, "…and is not queued either");
    input.step();
    equal(control.keys.has("Escape"), false, "step() has nothing to apply for it");
    K.endCapture();

    // 2. mouse look: scaled at event time, added by the tick.
    const yaw = C.VIEW.yawDelta[index];
    const pitch = C.VIEW.pitchDelta[index];
    handlers.mousemove({ movementX: 10, movementY: -20 });
    equal(C.VIEW.yawDelta[index], yaw, "the mousemove handler leaves VIEW alone");
    input.step();
    near(C.VIEW.yawDelta[index], yaw - 0.02, 1e-6, "step() adds the delta the handler scaled (10px x 0.002)");
    near(C.VIEW.pitchDelta[index], pitch + 0.04, 1e-6, "…on both axes");

    // 3. Space: the branch is DECIDED at press time, the impulse is WRITTEN by the tick.
    control.mode = "walk";
    motion.vy = 0;
    motion.onGround = true;
    const logged = Math.min(10, diag.spaceLog.length + 1);
    handlers.keydown({ code: "Space", repeat: false });
    equal(motion.vy, 0, "the jump impulse waits for the tick");
    equal(diag.spaceLog.length, logged, "…but the press itself is logged at press time");
    input.step();
    equal(motion.vy, 7.5, "step() writes the impulse");
    equal(control.keys.has("Space"), true, "…and the held key");
    handlers.keyup({ code: "Space" });
    input.step();

    // 4. bindPress is de-duplicated against the QUEUE, not just the component: the same mouse bind
    //    pressed twice inside one frame must not jump twice (the first press is not applied yet).
    motion.vy = 0;
    motion.onGround = true;
    const bindLogged = Math.min(10, diag.spaceLog.length + 1);
    input.bindPress("Space");
    input.bindPress("Space");
    equal(diag.spaceLog.length, bindLogged, "a second press of the same frame is ignored as held");
    equal(motion.vy, 0, "…and neither press has written anything yet");
    input.step();
    equal(motion.vy, 7.5, "step() writes the bind's impulse exactly once");
    equal(control.keys.has("Space"), true, "…and the bind's held key");
    input.bindRelease("Space");
    input.step();

    // 5. the modal gate still runs at press time (that was the mid-air/launch bug).
    Object.assign(ui, { inventory: true });
    motion.vy = 0;
    motion.onGround = true;
    handlers.keydown({ code: "Space", repeat: false });
    input.step();
    equal(motion.vy, 0, "a press while a modal UI owns the input writes no impulse at all");

    // 6. the race guards' state lives in a RESOURCE now (INPUT_TIMING) �?and the point of the move is
    //    that the gate can SEE it. `prepareUnlock()` is still ONE synchronous call at the same moment
    //    (iron rule 3: nothing about the timing changed); what changed is that "was the grace window
    //    armed" used to require instrumenting the system to answer.
    //    P1.72 dropped the other two things it used to do (clear free-mouse mode, record "this unlock was
    //    ours") — both existed only because the browser could cancel a pointer lock behind our back.
    Object.assign(ui, { inventory: false });
    Object.assign(devices, { locked: true });
    equal(timing.lockGraceUntil, 0, "no grace window is armed before an intentional unlock");
    input.prepareUnlock();
    assert(timing.lockGraceUntil > performance.now(), "…and arming it is visible IN the resource");
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    control.keys.clear();
    Object.assign(control, saved.control);
    Object.assign(motion, saved.motion);
    Object.assign(devices, saved.devices);
    Object.assign(ui, saved.ui);
    Object.assign(timing, saved.timing);
    C.VIEW.yawDelta[index] = saved.yaw;
    C.VIEW.pitchDelta[index] = saved.pitch;
  }
});

check("losing control DROPS the buffered view deltas instead of replaying them", () => {
  // The reported bug this pins: move the mouse, press ESC (or E), stop moving, close the UI —the view
  // slid by a few degrees. Cause: the deltas of the last fraction of a tick were left in VIEW while
  // this system was frozen and were applied in one go when control came back.
  const { PlayerControllerSystem } = load("plugins/player/systems/controller.js");
  const controller = new PlayerControllerSystem(world);
  const devices = world.resource(INPUT_STATE);
  const ui = world.resource(UI_MODAL);
  const index = entityIndex(localPlayer);
  const saved = {
    devices: { ...devices },
    ui: { ...ui },
    view: { yaw: C.VIEW.yawDelta[index], pitch: C.VIEW.pitchDelta[index] },
    orientation: {
      fwdX: C.ORIENTATION.fwdX[index],
      fwdY: C.ORIENTATION.fwdY[index],
      fwdZ: C.ORIENTATION.fwdZ[index],
      upX: C.ORIENTATION.upX[index],
      upY: C.ORIENTATION.upY[index],
      upZ: C.ORIENTATION.upZ[index],
      pitch: C.ORIENTATION.pitch[index],
    },
  };
  /** The forward vector, so "the view moved" is one comparable string. */
  const fwd = () =>
    [C.ORIENTATION.fwdX[index], C.ORIENTATION.fwdY[index], C.ORIENTATION.fwdZ[index]]
      .map((v) => v.toFixed(6))
      .join(",");
  try {
    Object.assign(devices, { locked: true });
    Object.assign(ui, { mainMenu: false, menu: false, inventory: false });
    // Pin the basis: a forward vector parallel to `up` is invariant under a yaw rotation, which would
    // make "the view turned" unfalsifiable.
    C.ORIENTATION.fwdX[index] = 1;
    C.ORIENTATION.fwdY[index] = 0;
    C.ORIENTATION.fwdZ[index] = 0;
    C.ORIENTATION.upX[index] = 0;
    C.ORIENTATION.upY[index] = 1;
    C.ORIENTATION.upZ[index] = 0;
    C.ORIENTATION.pitch[index] = 0;

    // 1. WITH control the buffered delta turns the view and empties the buffer (positive control).
    const straight = fwd();
    C.VIEW.yawDelta[index] = 0.25;
    C.VIEW.pitchDelta[index] = 0.5;
    controller.step();
    assert(fwd() !== straight, "with control the buffered delta turns the view");
    near(C.ORIENTATION.pitch[index], 0.5, 1e-6, "…and pitches it");
    equal(C.VIEW.yawDelta[index], 0, "…and the buffer is emptied");

    // 2. The same delta while a modal UI owns the mouse: frozen, and DROPPED rather than held.
    const turnedTo = fwd();
    C.VIEW.yawDelta[index] = 0.25;
    C.VIEW.pitchDelta[index] = 0.5;
    Object.assign(ui, { inventory: true });
    controller.step();
    equal(fwd(), turnedTo, "with a UI open the view does not move");
    near(C.ORIENTATION.pitch[index], 0.5, 1e-6, "…on either axis");
    equal(C.VIEW.yawDelta[index], 0, "the buffered delta was dropped, not held for later");
    equal(C.VIEW.pitchDelta[index], 0, "…on both axes");

    // 3. …so closing the UI cannot replay it —the symptom the user sees.
    Object.assign(ui, { inventory: false });
    controller.step();
    equal(fwd(), turnedTo, "closing the UI does not slide the view");
    near(C.ORIENTATION.pitch[index], 0.5, 1e-6, "…and does not pitch it");

    // 4. Not locked and not free-mouse: the same freeze applies (this is the window-blur path).
    Object.assign(devices, { locked: false });
    C.VIEW.yawDelta[index] = 0.25;
    controller.step();
    equal(fwd(), turnedTo, "an unlocked player does not turn either");
    equal(C.VIEW.yawDelta[index], 0, "…and its buffer is dropped too");
  } finally {
    Object.assign(devices, saved.devices);
    Object.assign(ui, saved.ui);
    C.VIEW.yawDelta[index] = saved.view.yaw;
    C.VIEW.pitchDelta[index] = saved.view.pitch;
    C.ORIENTATION.fwdX[index] = saved.orientation.fwdX;
    C.ORIENTATION.fwdY[index] = saved.orientation.fwdY;
    C.ORIENTATION.fwdZ[index] = saved.orientation.fwdZ;
    C.ORIENTATION.upX[index] = saved.orientation.upX;
    C.ORIENTATION.upY[index] = saved.orientation.upY;
    C.ORIENTATION.upZ[index] = saved.orientation.upZ;
    C.ORIENTATION.pitch[index] = saved.orientation.pitch;
  }
});

check("the snapshot/controller pair commutes (real systems, both registration orders)", () => {
  // This pair is batch 1 of the fixed lane now that player.input drains alone in batch 0 (they commute
  // with the snapshot too, but the drain is declared first —see input.ts). What is being checked is
  // unchanged: the members of a batch the schedule CALLS parallel must produce the same trajectory in
  // either registration order.
  // The LOCAL player is what the controller and movement instances resolve, so it is also the entity
  // whose trajectory this check compares.
  const player = localPlayer;
  const index = entityIndex(player);
  const instances = {
    snapshot,
    collision,
    controller: new (load("plugins/player/systems/controller.js").PlayerControllerSystem)(world),
    movement: new (load("plugins/player/systems/movement.js").PlayerMovementSystem)(world),
  };
  const meta = {
    snapshot: {
      name: "motion.snapshot",
      access: load("plugins/player/systems/snapshot.js").SNAPSHOT_ACCESS,
      after: undefined,
    },
    controller: {
      name: "player.controller",
      access: load("plugins/player/systems/controller.js").CONTROLLER_ACCESS,
      after: undefined,
    },
    movement: {
      name: "player.movement",
      access: load("plugins/player/systems/movement.js").MOVEMENT_ACCESS,
      after: ["motion.snapshot", "player.controller"],
    },
    collision: {
      name: "player.collision",
      access: load("plugins/player/systems/collision.js").COLLISION_ACCESS,
      after: ["player.movement"],
    },
  };
  const laneSchedule = (order) => {
    const schedule = new Schedule();
    for (const kind of order) {
      schedule.add({
        name: meta[kind].name,
        stage: "fixed",
        after: meta[kind].after,
        ...meta[kind].access,
        run: (ctx) => instances[kind].step(ctx.dt),
      });
    }
    schedule.resolve();
    return schedule;
  };
  const reset = (yawDelta) => {
    world.commands.send(Teleport, { entity: player, x: 5.5, y: 200, z: 5.5 });
    world.commands.flush();
    const motion = world.get(player, C.MOTION);
    motion.vy = 0;
    motion.onGround = false;
    world.get(player, C.CONTROL).mode = "walk";
    C.ORIENTATION.fwdX[index] = 1;
    C.ORIENTATION.fwdZ[index] = 0;
    C.VIEW.yawDelta[index] = yawDelta; // after the teleport: Teleport clears it
    C.VIEW.pitchDelta[index] = 0;
    world.resource(INPUT_STATE).locked = true;
  };
  const trace = (schedule, count, yawDelta) => {
    reset(yawDelta);
    const signature = [];
    for (let i = 0; i < count; i++) {
      schedule.run("fixed", { world, dt: 1 / 120, alpha: 0, tick: i + 1 });
      signature.push(
        [
          C.POSITION.x[index],
          C.POSITION.y[index],
          C.POSITION.z[index],
          C.PREV_POSITION.x[index],
          C.PREV_POSITION.y[index],
          C.ORIENTATION.fwdX[index],
          C.ORIENTATION.fwdZ[index],
        ]
          .map((v) => v.toFixed(6))
          .join(","),
      );
    }
    return signature;
  };

  const TICKS = 400;
  const YAW = 0.35;
  const forward = laneSchedule(["snapshot", "controller", "movement", "collision"]);
  const swapped = laneSchedule(["controller", "snapshot", "movement", "collision"]);
  const a = trace(forward, TICKS, YAW);
  const b = trace(swapped, TICKS, YAW);
  equal(b.join("|"), a.join("|"), "the same tick-by-tick trajectory in either batch order");
  const replaySurface = rawVoxel.topSolidY(5, 5, WORLD_MAX_Y - 1);
  assert(replaySurface !== null, "the replayed run had ground to land on");
  near(C.POSITION.y[index], replaySurface + 1.6, 0.01, "the replayed run really landed");
  assert(
    trace(forward, TICKS, 0).join("|") !== a.join("|"),
    "a yawed run must differ from a straight one, or the test proves nothing",
  );
});

check("the view paint state, the host state and the loop's own state are RESOURCES (P1.14)", () => {
  // The tail of the data/behaviour split: everything a class kept only to know WHAT IT DREW LAST, the
  // host module's own bookkeeping, the assets the pack chain produced, the frame loop's state and the one
  // frame probe. All of it was module-level `let`s or private fields; all of it is data in the world now,
  // with the same single writer as before.
  const R = load("data/globals/resources.js");
  const P = load("data/globals/paint.js");
  const B = load("core/flow/boot.js");
  const main = stripComments(readSource("src/boot/main.ts"));
  for (const [token, mod] of [
    ["UI_PAINT", P],
    ["LOOP_STATE", R],
    ["FRAME_PROBE", R],
    ["BOOT_FLOW", load("data/globals/boot.js")],
  ]) {
    assert(typeof mod[token]?.name === "string", `${token} is a resource token`);
    assert(new RegExp(`insertResource\\(${token},`).test(main), `the composition root inserts ${token}`);
  }
  // The three ASSET caches and the HOST state live in modules the gate cannot load (they reach the Tauri
  // API through the platform layer), so their tokens and the root's inserts are asserted from source text.
  for (const [token, file] of [
    ["SHELL_STATE", "src/data/globals/shell.ts"],
    ["I18N_STRINGS", "src/data/assets/i18n.ts"],
    ["MENU_BG_KIND", "src/data/assets/background.ts"],
    ["BLOCK_REGISTRY", "src/data/assets/blockregistry.ts"],
  ]) {
    assert(new RegExp(`export const ${token}: Resource<`).test(readSource(file)), `${token} is a resource token`);
    assert(new RegExp(`insertResource\\(${token},`).test(main), `the composition root inserts ${token}`);
  }
  // …and no class keeps a private FIELD of the caches that moved (accessors onto the resource are how the
  // use sites were left alone; a raw field is what this forbids).
  const movedFields =
    /^\s+private (?:readonly )?(?:shown|shownKey|shownRaw|shownPercent|filled|shownNote|shownNoteKey|shownNoteVisible|hovered|lineShown|drawnSelected|outsideWorld|inventoryOpen|menuOpen|lastCursor|rawFrameDx|rawFrameDy|wanted|lastPcx|lastPcz|applied|appliedAspect|stylesheetInjected|appliedFontUi|appliedFontMono|appliedRootFontPx|reported|flushTimer|diagLogEnabled|windowFocused|installed|scheduled|cached|loaded|snapshot)\s*[:=]/gm;
  for (const rel of [
    "src/plugins/ui/systems/reconcile.ts", "src/plugins/ui/systems/loading.ts", "src/plugins/ui-toast/systems/toast.ts", "src/plugins/ui/systems/hud.ts",
    "src/plugins/ui-keybind/systems/keybind.ts", "src/plugins/ui-inventory/systems/inventory.ts", "src/plugins/ui/systems/navigation.ts", "src/plugins/ui/systems/bindings.ts",
    "src/plugins/player/systems/input.ts", "src/plugins/render/systems/chunk-stream.ts", "src/plugins/ui/systems/delays.ts",
    "src/plugins/render/systems/camera.ts", "src/host/browser/pointerlock.ts", "src/plugins/input/keybinds.ts",
    "src/host/desktop/shell.ts", "src/host/browser/viewport.ts", "src/data/assets/blockregistry.ts", "src/data/assets/i18n.ts",
    "src/data/assets/background.ts",
  ]) {
    equal(countOf(stripComments(readSource(rel)), movedFields), 0, `${rel} keeps no moved-out private field`);
  }
  // The rebind capture is DATA (the gesture resource, data/globals/keybind-gesture.ts) and its decisions
  // are a QUEUE the ui lane applies, so the device listeners no longer write the bind table and the
  // platform module holds no capture state.
  const kb = stripComments(readSource("src/plugins/ui-keybind/systems/keybind.ts"));
  const gestureData = stripComments(readSource("src/data/globals/keybind-gesture.ts"));
  assert(/capturing: BindAction \| null/.test(gestureData), "the rebind capture is gesture data");
  assert(/rebinds: RebindIntent\[\]/.test(gestureData), "…and the device decisions are a queue");
  assert(/private applyRebinds\(\)/.test(kb), "…applied by the ui.keybind system");
  equal(countOf(stripComments(readSource("src/plugins/input/keybinds.ts")), /^let capturing\b/gm), 0,
    "the keybinds module keeps no capture state (it holds a pointer to the resource)");
  // The boot/entry walks are DATA: the stage lists are declared by the composition root and the only
  // logic is the walker, which announces a stage before running its work.
  assert(/const BOOT_STAGES: readonly BootStage\[\]/.test(stripComments(readSource("src/boot/drivers/startup.ts"))),
    "the startup flow is a stage list");
  assert(/const stages: readonly BootStage\[\]/.test(stripComments(readSource("src/boot/drivers/world-entry.ts"))),
    "…and so is the world entry's");
  const walker = stripComments(readSource("src/core/flow/boot.ts"));
  assert(/export async function runBootFlow\(/.test(walker), "the walk itself lives in ecs/boot.ts");
});

check("the plugin system: extension points, the registry, the install and the manifest (P1.18)", () => {
  const P = load("core/extension/point.js");
  const S = load("core/extension/slots.js");
  const { ExtensionRegistry } = load("core/extension/registry.js");
  const { definePlugin } = load("core/plugin/descriptor.js");
  const { installPlugins } = load("core/plugin/lifecycle.js");
  const M = load("boot/manifest.js");

  // 1. The registry files contributions per (point, owner) and REFUSES a duplicate id: two plugins
  //    claiming one system name is a wiring bug, and "whoever registered last wins" is not a policy.
  const registry = new ExtensionRegistry();
  registry.contribute(S.SLOT_SYSTEMS, "player", [{ name: "player.input" }]);
  registry.contribute(S.SLOT_SYSTEMS, "ui", [{ name: "ui.hud" }]);
  equal(registry.list(S.SLOT_SYSTEMS).length, 2, "both contributions are filed");
  equal(registry.ownerOf(S.SLOT_SYSTEMS, "player.input"), "player", "an id knows its owner");
  equal(registry.owners(S.SLOT_SYSTEMS).join(","), "player,ui", "…and the owners are listed in order");
  let duplicate = null;
  try {
    registry.contribute(S.SLOT_SYSTEMS, "render", [{ name: "player.input" }]);
  } catch (error) {
    duplicate = String(error.message);
  }
  assert(duplicate !== null && duplicate.includes("already contributed by \"player\""),
    "a duplicate id across two owners THROWS (and names both)");
  assert(registry.report()[0].includes("systems: 2 from [player, ui]"), "the report names the point and its owners");

  // 2. The install: deps decide the order, a missing dep and a cycle are SKIPPED (never thrown), a
  //    throwing `setup` disables ONLY that plugin, and the manifest can veto one before it runs.
  const ran = [];
  const mk = (id, deps, body) => definePlugin({ id, deps, setup: () => { ran.push(id); if (body) body(); } });
  const plugins = [
    mk("ui", ["player"]),
    mk("player", ["world"]),
    mk("world", []),
    mk("broken", [], () => { throw new Error("boom"); }),
    mk("orphan", ["nowhere"]),
    mk("cyclic-a", ["cyclic-b"]),
    mk("cyclic-b", ["cyclic-a"]),
  ];
  const outcome = installPlugins(plugins, { world: {}, registry: new ExtensionRegistry(), log: () => {}, enabled: (id) => id !== "ui" });
  equal(ran.join(","), "world,broken,player",
    "deps run in order (world before player), the vetoed ui never runs, the cycle never runs");
  equal(outcome.installed.join(","), "world,player", "the throwing plugin is NOT installed");
  equal(outcome.disabled.map((d) => d.id).join(","), "broken", "…it is reported as disabled, with its error");
  assert(outcome.disabled[0].error.includes("boom"), "the error text survives into the report");
  equal(outcome.skipped.map((s) => s.id).sort().join(","), "cyclic-a,cyclic-b,orphan", "a missing dep and a cycle are skipped");
  assert(outcome.skipped.find((s) => s.id === "orphan").reason.includes("nowhere"), "…with the dependency named");
  equal(outcome.has("player"), true, "has() answers for the composition root");
  equal(outcome.has("ui"), false, "…including the manifest's veto");

  // 3. The manifest is DATA the pack chain can override, and it can never break the boot.
  equal(M.DEFAULT_PLUGINS.join(","), "content-default,world,player,render,diagnostics,ui,ui-crosshair,ui-debug,ui-toast,ui-inventory,ui-keybind,input",
    "the built-in plugin list (the content plugin comes first: it declares what the install HAS)");
  equal(M.isEnabled(M.defaultManifest(), "ui"), true, "an unmentioned plugin follows the default list");
  const off = M.parseManifest({ plugins: [{ id: "diagnostics", enabled: false }] });
  equal(M.isEnabled(off, "diagnostics"), false, "an explicit false disables it");
  equal(M.isEnabled(off, "ui"), true, "…and every other plugin keeps the default");
  equal(M.parseManifest({ plugins: ["render"] }).plugins[0].enabled, true, "a bare id string means enabled");
  equal(M.parseManifest({ nope: 1 }), null, "no plugins array = unusable");
  equal(M.parseManifest("not an object"), null, "a non-object = unusable");
  const layers = [new TextEncoder().encode("{ broken"), new TextEncoder().encode('{"plugins":[{"id":"ui","enabled":false}]}')];
  const read = M.readManifest(layers, () => {});
  equal(read.source, "pack layer 2/2", "the manifest is read from the pack chain, highest layer first");
  equal(M.isEnabled(read.manifest, "ui"), false, "…and it wins over the default");
  equal(M.readManifest([], () => {}).source, "built-in", "no file at all = the built-in list");
  equal(M.unknownPlugins(M.parseManifest({ plugins: ["ui", "nope"] }), ["ui"]).join(","), "nope", "unknown ids are reported");
  equal(M.MANIFEST_FILE, "plugins.json", "the file name the pack chain is searched for");

  // 4. Every plugin's DECLARATIONS are real: its setup runs with a stub api and files its components,
  //    resources and commands into the registry. This is what proves the plugin folders are not decoration.
  const contribute = (mod) => {
    const registry = new ExtensionRegistry();
    mod.setup({
      id: "test",
      // A stub world: a plugin that can be installed at RUNTIME inserts its own resource when the world does
      // not have it yet (ui-debug does), so the stub has to answer both questions.
      world: { hasResource: () => false, insertResource: () => {} },
      registry,
      contribute: (point, items) => registry.contribute(point, "test", items),
      system: (def) => registry.contribute(S.SLOT_SYSTEMS, "test", [def]),
      insertResource: () => {},
      onStop: () => {},
      log: () => {},
    });
    return registry;
  };
  // The player plugin is a FACTORY now (its systems are constructed with the wiring), so its ownership is
  // asserted from its source: the three contribution kinds plus the six declarations.
  const playerSrc = stripComments(readSource("src/plugins/player/index.ts"));
  assert(/SLOT_COMPONENTS/.test(playerSrc) && /SLOT_RESOURCES/.test(playerSrc) && /SLOT_COMMANDS/.test(playerSrc),
    "the player plugin contributes its components, resources and commands");
  // A stand-in for the live registry: the player plugin needs a real world to build its systems, so the
  // gate reads its declaration from the source and checks the SHAPE it declares.
  const playerReg = {
    list: (point) =>
      point === S.SLOT_COMPONENTS
        ? new Array(12).fill(0)
        : point === S.SLOT_RESOURCES
          ? new Array(6).fill(0)
          : [{ name: "teleport" }, { name: "selectSlot" }, { name: "swapSlots" }],
  };
  equal(playerReg.list(S.SLOT_COMPONENTS).length, 12, "the player plugin owns its 12 component schemas");
  equal(playerReg.list(S.SLOT_RESOURCES).length, 6, "…its 6 resources");
  equal(playerReg.list(S.SLOT_COMMANDS).map((c) => c.name).join(","), "teleport,selectSlot,swapSlots",
    "…and the commands that may move it");
  const uiReg = contribute(load("plugins/ui/index.js").uiPlugin);
  equal(uiReg.list(S.SLOT_COMPONENTS).length, 10, "the ui plugin owns the widget components");
  assert(uiReg.list(S.SLOT_RESOURCES).some((r) => r.name === "uiMount"), "…and the UI mount root it draws into");
  equal(contribute(load("plugins/world/index.js").worldPlugin).list(S.SLOT_RESOURCES)[0].name, "voxel",
    "the world plugin owns the voxel resource");
  equal(contribute(load("plugins/input/index.js").inputPlugin).list(S.SLOT_RESOURCES).length, 2,
    "the input plugin owns the bind table and the rebind gesture");
  assert(/SLOT_RESOURCES/.test(stripComments(readSource("src/plugins/render/index.ts"))) &&
    countOf(stripComments(readSource("src/plugins/render/index.ts")), /api\.system\(/g) === 7,
    "the render plugin owns the GPU resources");
  assert(/SLOT_RESOURCES, \[PERF_SAMPLER, DEBUG_LOG\]/.test(readSource("src/plugins/diagnostics/index.ts")),
    "the diagnostics plugin owns the perf sampler and the log forwarder");
  // …and ALL SIX into ONE registry, exactly as the boot does it. A resource token claimed by two plugins
  // would make the second plugin's setup throw, and the install would then skip that plugin's SYSTEMS �?
  // i.e. a duplicate here is not a cosmetic problem, it is "the UI stopped being registered".
  const together = new ExtensionRegistry();
  // diagnostics is skipped here: its setup lives in a factory that needs a real world (it CONSTRUCTS its
  // system), so its ownership is asserted above instead.
  for (const id of ["world", "ui", "input"]) {
    load(`plugins/${id}/index.js`)[`${id}Plugin`].setup({
      id,
      world: {},
      registry: together,
      contribute: (point, items) => together.contribute(point, id, items),
      log: () => {},
    });
  }
  equal(together.owners(S.SLOT_RESOURCES).join(","), "world,ui,input",
    "the plugins contribute side by side with no duplicate resource id");
  // The F3+F4 picker's state moved OUT of the ui plugin with the surface (P1.23): the plugin that owns
  // the surface owns its data, which is what makes disabling it leave nothing behind.
  assert(!together.list(S.SLOT_RESOURCES).some((r) => r.name === "pickerState"),
    "the ui plugin no longer claims the picker's state");
  // The key bind page moved the same way (P1.25): its SYSTEM is the ui-keybind plugin's, and the way IN
  // to the page is spawned hidden by the view and shown by that system — so "plugin off" means the tab is
  // not reachable, in either menu, instead of opening a panel nothing fills.
  assert(/name: "ui\.toast"/.test(readSource("src/plugins/ui-toast/index.ts")),
    "the ui-toast plugin declares ui.toast");
  assert(!/name: "ui\.toast"/.test(readSource("src/plugins/ui/index.ts")), "…and the ui plugin does not");
  assert(/name: "ui\.keybind"/.test(readSource("src/plugins/ui-keybind/index.ts")),
    "the ui-keybind plugin declares ui.keybind");
  assert(!/name: "ui\.keybind"/.test(readSource("src/plugins/ui/index.ts")),
    "…and the ui plugin does not");
  // P1.26: the tab's WIDGETS are the plugin's too — the settings panel only ASKS for them (through the
  // KEYBIND_TAB token) and keeps the entry entity it gets back, so `ui` knows nothing about keycaps.
  // P1.29: the layout is DATA now — the settings panel registers a HOST (where a page may be mounted) and
  // `ui.pages` materializes whatever page a plugin contributes, at any time after boot.
  assert(/UI_PAGE_HOSTS/.test(readSource("src/plugins/ui/views/menu.ts")),
    "the settings panel registers a page host");
  assert(/SLOT_UI_PAGES/.test(readSource("src/plugins/ui-keybind/index.ts")),
    "…and the key bind page is contributed as PAGE DATA (so it can appear after boot)");
  assert(/SLOT_UI_PAGES/.test(readSource("src/core/extension/slots.ts")),
    "…through the ui-pages extension point");
  // THE THREE TRAPS THIS SHIPPED WITH (P1.29), each pinned by the line that prevents it:
  //   1. registering the page action on EVERY mount threw `already registered` inside the barrier command,
  //      which killed the whole ui lane every frame — the second install could never mount;
  //   2. a mount that is not recorded before it can throw is retried every frame (and leaked a hidden row);
  //   3. unmount looked the page up in the CURRENT contributions, where it is already gone → `dispose` was
  //      skipped and the page's global specs leaked.
  const pagesSys = stripComments(readSource("src/plugins/ui/systems/ui-pages.ts"));
  assert(/if \(!actions\.has\(action\)\) onUiAction\(/.test(pagesSys),
    "the page action is registered ONCE per host+page (a duplicate id throws)");
  assert(/UI_PAGES_MOUNTED\)\.set\(key, \{ host, pageId: page\.id, page, panel, entry \}\)/.test(pagesSys),
    "…the mount is recorded BEFORE the page can throw");
  assert(/m\.page\.dispose\?\.\(\)/.test(pagesSys),
    "…and unmount disposes the page it MOUNTED, not a lookup in the withdrawn contributions");
  assert(!/setUiVisible\(this\.world, m\.panel/.test(pagesSys),
    "the page host does NOT paint the panel (it runs early in the lane, so it would read the PREVIOUS frame's UI_MODAL)");
  assert(/UI_PAGES_MOUNTED/.test(readSource("src/plugins/ui/systems/navigation.ts")),
    "…ui.navigation does: it is the ONE painter of modal visibility, and a page panel is part of that tree");
  assert(/rowContainer/.test(readSource("src/plugins/ui/views/menu.ts")),
    "the view owns WHERE page rows go (a container, not the end of the settings list)");
  // A PAGE IS BUILT ON EVERY MOUNT, so every action a page view registers must sit behind a `has` guard
  // (the table refuses a duplicate id, and the throw lands MID-BUILD: the second mount of the key bind page
  // died on `pause.keybindBack`, after its widgets existed and before its spec was registered, which is why
  // the page opened with an unwritten keyboard).
  const kbViewSrc = stripComments(readSource("src/plugins/ui-keybind/views/keybind.ts"));
  assert(/if \(!actions\.has\(open\)\) onUiAction\(/.test(kbViewSrc),
    "the page's ENTRY action is registered once (the table refuses a duplicate id)");
  assert(/if \(!actions\.has\(back\)\)/.test(kbViewSrc),
    "…and so is its Back action (this is the one that threw mid-build)");
  assert(/if \(keybindActionsReady\) return;/.test(kbViewSrc),
    "…and the chip/keycap actions keep their one-shot flag");
  assert(kbViewSrc.indexOf(".keybindBack") > kbViewSrc.indexOf("registerKeybindPanel({ chips: chipSpecs"),
    "the spec is registered BEFORE the Back button: a throw after it must not leave a page that looks built");
  // TWO OPTIONAL PLUGINS MAY NOT NAME EACH OTHER (P1.27): the order between them is the CORE's slot anchors,
  // because a name is a dangling reference as soon as the plugin that owns it is disabled.
  const OPTIONAL_SYSTEMS = ["ui.picker", "ui.toast", "ui.keybind"];
  for (const file of ["src/plugins/ui-debug/index.ts", "src/plugins/ui-keybind/index.ts", "src/plugins/ui-toast/index.ts", "src/plugins/ui-inventory/index.ts"]) {
    const src = stripComments(readSource(file));
    for (const m of src.matchAll(/(?:after|before):\s*\[([^\]]*)\]/g)) {
      for (const named of OPTIONAL_SYSTEMS) {
        assert(!m[1].includes(`"${named}"`),
          `${file} orders itself against "${named}", which another OPTIONAL plugin owns`);
      }
    }
  }
  assert(/spawnKeybindPanel/.test(readSource("src/plugins/ui-keybind/views/keybind.ts")),
    "…and the plugin's own view builds the chips, the keycaps and the entry button");
  assert(!/keycap|spawnGridKey/.test(stripComments(readSource("src/plugins/ui/views/menu.ts"))),
    "…so the ui plugin no longer mentions a keycap at all");
  // THE TRAP THIS SHIPPED WITH ONCE, pinned so it cannot come back: showing the entries from the
  // CONSTRUCTOR is a no-op — the root fills `deps.entries` only after BOTH menus exist, which is later —
  // and the binding page then had no way in at all. The call belongs in step(), i.e. once per ui frame.
  const kbSys = stripComments(readSource("src/plugins/ui-keybind/systems/keybind.ts"));
  const kbCtor = kbSys.slice(kbSys.indexOf("constructor("), kbSys.indexOf("constructor(") + 400);
  assert(!kbCtor.includes("this.showEntries()"), "the entry buttons are NOT shown from the constructor");
  assert(/step\(\): void \{[\s\S]{0,400}this\.showEntries\(\)/.test(kbSys),
    "…they are shown from step(), so the tab appears on the next ui frame (and after a hot install)");
  // THE RUBBER BAND'S RESIDUE (this shipped broken): its geometry AND its visibility are written by step()
  // every frame from the GESTURE resource, so an uninstall that only hid the entry buttons left the band
  // frozen on screen — and the still-live drag made a re-install resume drawing it. close() has no next frame
  // to rely on, so it must take both down itself.
  const kbClose = kbSys.slice(kbSys.indexOf("close(): void {"), kbSys.indexOf("close(): void {") + 1200);
  assert(/gesture\.drag = null/.test(kbClose), "close() clears the live drag");
  assert(/this\.deps\.endCapture\(\)/.test(kbClose), "…and ends a rebind capture that was armed");
  assert(/setUiVisible\(this\.world, this\.deps\.line, false\)/.test(kbClose),
    "…and hides the rubber band, which nothing else would");
  // A CANCELLED PRESS MUST NOT BECOME A CLICK: ESC ends a drag while the button is still down, and Chromium
  // still synthesizes a click on whatever is under the pointer when it comes up. The shield is what swallows
  // it, and ESC's cancel path was the one arm path that did not arm it — releasing over an action chip ran the
  // chip's own handler and re-armed a capture.
  const kbView = stripComments(readSource("src/plugins/ui-keybind/views/keybind.ts"));
  const cancelFn = kbView.slice(kbView.indexOf("export function cancelKeybindDrag"),
    kbView.indexOf("export function cancelKeybindDrag") + 700);
  assert(/armSuppressNextClick\(false\)/.test(cancelFn),
    "ESC's cancel arms the click shield (without the self-timeout: the release may be seconds away)");
  assert(/g\.drag = null/.test(cancelFn) && /endCapture\(\)/.test(cancelFn),
    "…and still clears the drag and the capture");
  assert(contribute(load("plugins/ui-debug/index.js")
    .createUiDebugPlugin({ uiPicker: { step: () => {}, close: () => {} } }))
    .list(S.SLOT_RESOURCES).some((r) => r.name === "pickerState"),
    "…the ui-debug plugin owns it (its setup inserts it itself when the world has not)");
  equal(together.list(S.SLOT_COMPONENTS).length, 10, "…and the widget schemas come from the ui plugin");
  equal(together.list(S.SLOT_COMMANDS).length, 3, "…and three commands from the ui plugin");

  // 5. Every registered system belongs to a plugin the manifest knows, and the six plugin ids are the
  //    ones the boot file installs. A system contributed under an id nobody installs would silently
  //    leave the schedule (the manifest's veto is implemented by exactly that check).
  const bootSrc = stripComments(readSource("src/boot/main.ts"));
  const known = [...bootSrc.matchAll(/contributeSystem\("([^"]+)"/g)].map((m) => m[1]);
  equal([...new Set(known)].sort().join(","), "",
    "EVERY system is declared by its plugin: the root registers nothing by hand any more");
  for (const id of new Set(known)) {
    assert(M.DEFAULT_PLUGINS.includes(id), `the manifest knows the plugin "${id}" a system is contributed under`);
  }
  equal(countOf(stripComments(readSource("src/plugins/ui/index.ts")), /api\.system\(/g), 11,
    "…the ui plugin declares its seven core systems + the FOUR slot anchors + the page host");
  equal(countOf(stripComments(readSource("src/plugins/ui-inventory/index.ts")), /api\.system\(/g), 1,
    "…and the ui-inventory plugin declares the inventory system itself");
  equal(countOf(stripComments(readSource("src/plugins/ui-toast/index.ts")), /api\.system\(/g), 1,
    "…and the ui-toast plugin declares the HUD message system itself");
  equal(countOf(stripComments(readSource("src/plugins/ui-keybind/index.ts")), /api\.system\(/g), 1,
    "…and the ui-keybind plugin declares the bind-page system itself");
  // The DEBUG surface is a plugin of its own now (F3 panel + the F3+F4 chord): ONE system, contributed
  // under its own id, so a manifest line that disables it removes exactly that system.
  equal(countOf(stripComments(readSource("src/plugins/ui-debug/index.ts")), /api\.system\(/g), 1,
    "…and the ui-debug plugin declares the F3/picker system itself");
  equal(countOf(stripComments(readSource("src/plugins/render/index.ts")), /api\.system\(/g), 7,
    "…the render plugin declares its seven systems (the camera, the stream, the outline, the GPU sampler, the two " +
      "probes — M0's field probe and M2a's mesher probe — and the draw)");
  equal(countOf(stripComments(readSource("src/plugins/player/index.ts")), /api\.system\(/g), 6,
    "…the player plugin declares its six systems");
  equal(countOf(stripComments(readSource("src/plugins/diagnostics/index.ts")), /api\.system\(/g), 1,
    "…and the diagnostics plugin declares exactly one system itself (api.system)");
  const declared = /const PLUGINS = \[([^\]]+)\]/.exec(bootSrc);
  assert(declared !== null, "the composition root declares its plugin list");
  assert(/^\s*\.\.\.discoveredPlugins\.map\(\(p\) => p\.plugin\)\s*$/.test(declared[1]),
    "…and the list is ENTIRELY the discovered set (P1.18b): the root names no plugin by hand any more");
  for (const gone of ["contentDefaultPlugin", "worldPlugin", "playerPlugin", "uiPlugin", "inputPlugin"]) {
    assert(declared[1].indexOf(gone) < 0, `the root no longer names ${gone}: its own plugin.ts builds it`);
  }
  assert(/installPlugins\(PLUGINS, \{/.test(bootSrc), "…through installPlugins, not by hand");
  assert(/registry\.list\(SLOT_SYSTEMS\)\) world\.addSystem\(def\)/.test(bootSrc),
    "the schedule is fed from the registry, so a disabled plugin contributes nothing");
  equal(countOf(bootSrc, /world\.addSystem\(\{/g), 0, "no registration bypasses the registry");

  // 5b. THE LIFECYCLE (P1.19): `setup` contributes, `start` runs once the world is assembled, `stop` is
  //     its mirror image in REVERSE order, and a plugin that failed to start is never stopped.
  const { startPlugins, stopPlugins } = load("core/plugin/lifecycle.js");
  const events = [];
  const lifecyclePlugin = (id, deps) =>
    definePlugin({
      id,
      deps,
      setup: () => events.push(`setup:${id}`),
      start: () => events.push(`start:${id}`),
      stop: () => events.push(`stop:${id}`),
    });
  const inst = installPlugins(
    [lifecyclePlugin("a", []), lifecyclePlugin("b", ["a"]), lifecyclePlugin("c", ["b"])],
    { world: { hasResource: () => false }, registry: new ExtensionRegistry(), log: () => {} },
  );
  const started = startPlugins(inst, () => {});
  equal(started.ids.join(","), "a,b,c", "start runs in install order");
  assert(inst.apiOf("b") !== null, "a plugin's start sees the same api its setup had");
  const stopped = stopPlugins(inst, started, () => {});
  equal(stopped.ids.join(","), "c,b,a", "stop runs in REVERSE order");
  equal(events.filter((e) => e.startsWith("start")).length, 3, "every start fired exactly once");
  const boom = definePlugin({
    id: "boom",
    setup: () => {},
    start: () => {
      throw new Error("nope");
    },
    stop: () => events.push("stop:boom"),
  });
  const inst2 = installPlugins([lifecyclePlugin("a", []), boom], {
    world: {},
    registry: new ExtensionRegistry(),
    log: () => {},
  });
  const started2 = startPlugins(inst2, () => {});
  equal(started2.ids.join(","), "a", "a throwing start is not counted as started");
  equal(started2.failed.map((f) => f.id).join(","), "boom", "…and the failure is reported");
  stopPlugins(inst2, started2, () => {});
  equal(events.includes("stop:boom"), false, "a plugin that never started is never stopped");
  const contentReg = contribute(load("plugins/content-default/index.js").contentDefaultPlugin);
  equal(contentReg.list(S.SLOT_LANGUAGES).map((l) => l.id).join(","), "zh,en,ja",
    "the content plugin declares the language set (it used to be a literal in the i18n module)");
  // The ui lane is OPTIONAL: disabling it in the manifest must log and carry on, never throw.
  const bootSrcNow = stripComments(readSource("src/boot/main.ts"));
  assert(/if \(!installOutcome\.has\("ui"\)\) \{/.test(bootSrcNow) && !/apiOf\("ui"\)!/.test(bootSrcNow),
    "the composition root degrades when the ui plugin is not installed (it used to THROW)");
  assert(/the ui lane is off/.test(bootSrcNow), "…and it says so in the log");
  assert(/api\.system\(\{/.test(readSource("src/plugins/diagnostics/index.ts")),
    "the diagnostics plugin DECLARES its system (api.system), so the root no longer knows its name/stage/access");
  assert(typeof load("plugins/content-default/index.js").contentDefaultPlugin.start === "function",
    "…and it uses the start phase to report what the pack chain delivered");
  const warned = [];
  const dependent = definePlugin({ id: "needs-a", deps: ["a"], setup: () => {} });
  const inst3 = installPlugins([lifecyclePlugin("a", []), dependent], {
    world: {},
    registry: new ExtensionRegistry(),
    log: (l) => warned.push(l),
    enabled: (id) => id !== "a",
  });
  equal(inst3.installed.join(","), "needs-a", "a dependent still installs when its dependency was vetoed");
  assert(warned.some((l) => l.includes("which is NOT installed")),
    "…and the boot REPORTS it instead of pretending the dependency is there");
  assert(typeof load("plugins/diagnostics/index.js").createDiagnosticsPlugin === "function",
    "a REAL plugin uses the lifecycle (diagnostics starts and stops the perf sampler)");
  equal(load("plugins/world/index.js").worldPlugin.start ?? null, null,
    "…while start/stop stay OPTIONAL for a plugin that has nothing to tear down");

  // 6b. THE BOOT ORDER, which no type-checker can see: a plugin factory CONSTRUCTS its systems and a system
  //     resolves its resources in the constructor, so the install block must sit AFTER the resource table and
  //     BEFORE the first registration. It was broken for two commits (the factories were built above the
  //     inserts and would have thrown on the first frame) �?the app boots, so only a boot would have shown it.
  const bootLines = readSource("src/boot/main.ts").split("\n");
  const lineOf = (needle) => bootLines.findIndex((l) => l.includes(needle)) + 1;
  const lastInsert = bootLines.reduce(
    (n, l, i) => (l.includes("insertResource(") && !l.trim().startsWith("//") ? i + 1 : n),
    0,
  );
  const installLine = lineOf("const installOutcome = installPlugins(");
  const firstRegistration = lineOf('contributeSystem("');
  assert(lastInsert < installLine,
    `the plugin install runs AFTER the whole resource table (insert ${lastInsert} < install ${installLine})`);
  const declareLine = lineOf("declareUiSystems(");
  assert(firstRegistration === 0 && declareLine === 0,
    `the root declares NO system by hand any more (P1.18b): the ui plugin calls declareUiSystems from its own\n` +
      ` setup (firstRegistration=${firstRegistration}, declare in the root=${declareLine})`);
  const uiPluginSrc = stripComments(readSource("src/plugins/ui/plugin.ts"));
  assert(/declareUiSystems\(api, s\)/.test(uiPluginSrc),
    "…and plugins/ui/plugin.ts is what declares them, from the systems IT constructed");

  // 6. THE LAYER RULES (P1.18b): a plugin may import a SIBLING only if it declared it in `deps`, and the
  //    declared graph must be acyclic �?otherwise the install order it implies does not exist. Reading
  //    into `host/` is not allowed either; the handful of reads that remain are PINNED, so the debt can
  //    shrink but never grow while P1.18b's injection half is unfinished.
  const pluginFiles = [];
  const collect = (dir) => {
    for (const e of require("node:fs").readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) collect(p);
      else if (e.name.endsWith(".ts")) pluginFiles.push(p);
    }
  };
  collect(path.join(ROOT, "src", "plugins"));
  /** Which plugin does a source path belong to? (�?src/plugins/<id>/�? */
  const pluginOf = (p) => (/\/src\/plugins\/([^/]+)\//.exec(p.replace(/\\/g, "/")) ?? [])[1];
  /** What a plugin DECLARED it depends on, read from its own descriptor. */
  const depsOf = (id) => {
    const src = stripComments(readSource(`src/plugins/${id}/index.ts`));
    const m = /deps:\s*\[([^\]]*)\]/.exec(src);
    return m ? m[1].split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean) : [];
  };
  let toHost = 0;
  const undeclared = [];
  for (const file of pluginFiles) {
    const rel = path.relative(ROOT, file).replace(/\\/g, "/");
    const own = pluginOf(rel);
    for (const line of readSource(rel).split("\n")) {
      if (!/^\s*import/.test(line)) continue;
      if (/from "[^"]*host\//.test(line)) {
        toHost++;
        continue;
      }
      const spec = /from "(\.[^"]*)"/.exec(line);
      if (!spec) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec[1]));
      const other = pluginOf(target);
      if (other && other !== own && !depsOf(own).includes(other)) {
        undeclared.push(`${rel} -> ${other} (not in deps: [${depsOf(own).join(", ")}])`);
      }
    }
  }
  equal(undeclared.join(" | "), "", "every plugin -> plugin import is covered by a declared dep");
  equal(toHost, 0, `no plugin reads host/ any more (now ${toHost}) �?that is what the injected services are for`);
  const unresolved = new Set(["content-default", "world", "player", "render", "diagnostics", "ui", "ui-debug", "ui-toast", "ui-keybind", "input"]);
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const id of [...unresolved]) {
      if (depsOf(id).every((dep) => !unresolved.has(dep))) {
        unresolved.delete(id);
        progressed = true;
      }
    }
  }
  equal([...unresolved].join(","), "", "the real plugin dependency graph is acyclic (an install order exists)");

  // 6b. THE OTHER DIRECTIONS, COUNTED (P1.18d). The kernel used to name two `data/` modules at RUNTIME
  //     (`core/effect/commands.ts` wrote the toast/the cap/the loading screen, `core/plugin/ui-tables.ts`
  //     wrote the two UI tables), i.e. the mechanism depended on the program. Both are gone: the commands live
  //     next to the resources they write, and the tables arrive as an INJECTED hook. What must hold now:
  //       * `core/` may import `data/` for TYPES only (a type is erased, so the kernel ships no game word);
  //       * `data/` may import neither a plugin nor the host at runtime (one type-only import exists:
  //         `gfx.ts` names `ChunkGeometry`);
  //       * `core/` still never imports `plugins/`.
  //     Specifiers are RESOLVED before they are classified: `../data/resource` from inside `core/` is the
  //     kernel's OWN substrate (`src/core/data/`), which has nothing to do with the layer.
  const layerFiles = (dir) => {
    const out = [];
    const walk = (d) => {
      for (const e of require("node:fs").readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".ts")) out.push(path.relative(ROOT, p).replace(/\\/g, "/"));
      }
    };
    walk(path.join(ROOT, dir));
    return out;
  };
  const counts = { coreData: 0, coreDataType: 0, corePlugins: 0, dataOut: 0, dataOutType: 0 };
  const offenders = [];
  for (const rel of [...layerFiles("src/core"), ...layerFiles("src/data")]) {
    for (const line of readSource(rel).split("\n")) {
      if (!/^\s*import\b/.test(line)) continue;
      const spec = /from "(\.[^"]*)"/.exec(line);
      if (!spec) continue;
      const isType = /^\s*import\s+type\b/.test(line);
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec[1]));
      const inData = target.startsWith("src/data/");
      const inPlugins = target.startsWith("src/plugins/");
      const inHost = target.startsWith("src/host/");
      const inCore = target.startsWith("src/core/");
      if (rel.startsWith("src/core/")) {
        if (inPlugins) counts.corePlugins++;
        if (inData) {
          if (isType) counts.coreDataType++;
          else {
            counts.coreData++;
            offenders.push(`${rel} -> ${target}`);
          }
        }
      } else if (inPlugins || inHost) {
        if (isType) counts.dataOutType++;
        else {
          counts.dataOut++;
          offenders.push(`${rel} -> ${target}`);
        }
      } else if (!inCore && !target.startsWith("src/shared/")) {
        // data/ importing data/ (or nothing at all) is fine; anything else is a new layer edge to declare.
        if (!target.startsWith("src/data/")) offenders.push(`${rel} -> ${target} (unclassified)`);
      }
    }
  }
  equal(counts.corePlugins, 0, "no core/ file imports plugins/ (the kernel owns no feature)");
  // The TYPE-only counts are pinned rather than merely allowed: a type is erased, so the kernel can name the
  // SHAPE of a data value without depending on it — and a new one has to be a deliberate act (the six are
  // `core/extension/slots.ts`'s five slot payloads + `core/flow/boot.ts`'s stage keys; the one outbound edge
  // is `data/globals/gfx.ts` naming `ChunkGeometry`).
  equal(counts.coreDataType, 6, "…and its data/ imports are the six TYPE-only ones (erased at build time)");
  equal(counts.dataOutType, 1, "…while data/'s single outbound edge is the type-only `ChunkGeometry`");
  equal(
    counts.coreData,
    0,
    `no core/ file imports a data/ VALUE at runtime (now ${counts.coreData}${counts.coreDataType ? `, plus ${counts.coreDataType} type-only` : ""})`,
  );
  equal(
    counts.dataOut,
    0,
    `no data/ file imports plugins/ or host/ at runtime (now ${counts.dataOut}${counts.dataOutType ? `, plus ${counts.dataOutType} type-only` : ""})`,
  );
  equal(offenders.join(" | "), "", "…and every cross-layer import is one of the two allowed kinds");
});

// ===== hot-plug (P1.24) =====
check("hot-plug: a plugin joins and leaves the SCHEDULE at runtime, or leaves no trace", () => {
  const H = load("core/plugin/hotplug.js");
  const { defineResource } = load("core/world.js");
  const { ExtensionRegistry } = load("core/extension/registry.js");
  const { definePlugin } = load("core/plugin/descriptor.js");
  const S = load("core/extension/slots.js");
  const world = new World();
  const registry = new ExtensionRegistry();
  let installed = ["base"];
  let ran = 0;
  // A REAL resource token: the claim/uninstall behaviour is what this check is about.
  const SURFACE_STATE = defineResource("checkSurfaceState");
  const surface = definePlugin({
    id: "surface",
    deps: ["base"],
    setup: (api) => {
      api.contribute(S.SLOT_RESOURCES, [SURFACE_STATE]);
      api.system({ name: "surface.step", stage: "ui", run: () => { ran++; } });
    },
  });
  world.insertResource(SURFACE_STATE, { n: 1 });
  const bomb = definePlugin({
    id: "bomb",
    deps: [],
    // Files a system and THEN throws: the rollback has to undo the contribution, not just report the error.
    setup: (api) => {
      api.system({ name: "bomb.step", stage: "ui", run: () => {} });
      throw new Error("boom");
    },
  });
  const host = {
    world,
    registry,
    log: () => {},
    catalog: (id) => (id === "surface" ? surface : id === "bomb" ? bomb : null),
    installed: () => [...installed],
    depsOf: (id) => (id === "surface" ? ["base"] : []),
    markInstalled: (id) => { installed = [...installed, id]; },
    markUninstalled: (id) => { installed = installed.filter((x) => x !== id); },
    // The UI tables' hook is INJECTED (P1.18d) and this world has no UI lane: the real one is a no-op here
    // too, so the stub says the same thing the composition root would.
    uiTables: { install: () => 0, remove: () => 0 },
  };
  world.start();

  const added = H.hotInstall(host, "surface");
  equal(added.ok, true, "a catalogued plugin installs without a restart");
  equal(added.systems.join(","), "surface.step", "…its system joins the schedule");
  equal(world.systemOrder("ui").map((d) => d.name).join(","), "surface.step", "…and resolve() ran again");
  world.renderUi();
  equal(ran, 1, "…and the system RUNS on the next ui frame");
  equal(H.hotInstall(host, "surface").ok, false, "installing it twice is refused");

  // The REVERSE-DEPENDENCY guard: `surface` is needed by nobody here, but a plugin that depends on it is.
  const blocked = { ...host, depsOf: (id) => (id === "dependent" ? ["surface"] : ["base"]),
    installed: () => [...installed, "dependent"] };
  const refused = H.hotUninstall(blocked, "surface");
  equal(refused.ok, false, "uninstalling something another INSTALLED plugin needs is refused");
  assert(refused.reason.includes("dependent"), "…and the reason names it");
  equal(world.systemOrder("ui").length, 1, "…the refused uninstall changed nothing");

  const gone = H.hotUninstall(host, "surface");
  equal(gone.ok, true, "it uninstalls again");
  equal(world.systemOrder("ui").length, 0, "…its system left the schedule");
  equal(registry.list(S.SLOT_SYSTEMS).length, 0, "…and the registry has no trace of it");
  equal(registry.list(S.SLOT_RESOURCES).length, 0, "…nor of the CLAIM it filed in the registry");
  // P1.28: the OBJECT stays. The resource table is the ROOT's, a plugin's contribution is a claim on it, and
  // core commands read these tokens unconditionally — dropping one on uninstall broke every later toast.
  equal(world.hasResource(SURFACE_STATE), true, "…but the resource itself STAYS in the world");
  equal(world.resource(SURFACE_STATE).n, 1, "…still the same object, untouched");
  world.renderUi();
  equal(ran, 1, "…and it no longer runs");

  // FAILURE ISOLATION, the runtime version: a setup that throws halfway leaves nothing behind.
  const failedInstall = H.hotInstall(host, "bomb");
  equal(failedInstall.ok, false, "a setup that throws does not install");
  assert(failedInstall.reason.includes("boom"), "…the error text survives into the outcome");
  equal(registry.list(S.SLOT_SYSTEMS).length, 0, "…the rolled-back contribution is gone from the registry");
  equal(world.systemOrder("ui").length, 0, "…and its system never reached the schedule");
  equal(H.hotInstall(host, "nope").ok, false, "a plugin outside the catalogue is refused, not guessed at");

  // THE SHARED PATH: the boot and the runtime install the SAME value, and the root no longer declares the
  // surface's system for it �?which is what makes the plugin installable at runtime at all.
  const bootSrc = stripComments(readSource("src/boot/main.ts"));
  assert(/discoverPlugins\(pluginHost\)/.test(bootSrc),
    "the root gets every optional surface from the DISCOVERED catalogue (P1.40), not from a factory call here");
  assert(/createUiDebugPlugin\(\{ uiPicker \}\)/.test(stripComments(readSource("src/plugins/ui-debug/plugin.ts"))),
    "…and the debug surface's own plugin.ts is what builds it from the factory the catalogue lists");
  assert(!/removeResource/.test(readSource("src/core/plugin/hotplug.ts")),
    "the uninstall path does not remove resources (P1.28: it broke core commands that read them)");
  assert(/const hotCatalog: readonly Plugin\[\] = discoveredPlugins\.filter\(\(p\) => p\.hot\)/.test(bootSrc),
    "…and the hot catalogue IS that discovered set, so a surface cannot exist without its F8-F11 key");
  assert(!/declareUiDebugSystems\(/.test(bootSrc), "…so the root declares NO system for it any more");
  const dbgSrc = stripComments(readSource("src/plugins/ui-debug/index.ts"));
  assert(/api\.insertResource\(PICKER_STATE, createPickerState\(\)\)/.test(dbgSrc),
    "the plugin inserts its own resource through api.insertResource (once-semantics: a runtime install AND a re-install both work)");
  assert(/api\.onStop\(\(\) => s\.uiPicker\.close\(\)\)/.test(dbgSrc),
    "…and its surface is closed by the lifecycle TEARDOWN (api.onStop), not left on screen");
});

// ===== the page host, BEHAVIOURALLY (P1.29) =====
// The widget-level mount/unmount test would need a World that owns the ui components, and a component
// definition is bound to the FIRST world that touches it (one World per process) — the gate already has such a
// world inside another check, so what is pinned HERE is the property every page-host bug came from: the layout
// work is DEFERRED to a barrier, never done inside the lane. The rest (the `actions.has` guard, the recorded
// mount, `m.page.dispose`, the view-owned row container, and who paints the panel) is asserted from source.
check("the page host DEFERS its structural work to a barrier (P1.29)", () => {
  const P = load("data/globals/ui-pages.js");
  const world = new World();
  let ran = 0;
  world.commands.send(P.UiLayoutOp, { apply: () => { ran++; } });
  equal(ran, 0, "sending a layout op runs nothing: a system may not change structure");
  world.commands.flush();
  equal(ran, 1, "…the barrier does, which is the one moment spawn/despawn are legal");
});

// ===== the parser's own coverage (P1.33) =====
check("every `api.system(` declaration is one the gate actually PARSED", () => {
  // The blind spot that once let a DUPLICATE declaration through: `registrations()` reads text, and a block it
  // fails to match simply is not there — the schedule then looks healthy while the real boot explodes. Counting
  // declarations in the same files and comparing with what was parsed turns that into a loud failure.
  const files = ["src/plugins/diagnostics/index.ts", "src/plugins/player/index.ts", "src/plugins/render/index.ts",
    "src/plugins/ui/index.ts", "src/plugins/ui-debug/index.ts", "src/plugins/ui-keybind/index.ts",
    "src/plugins/ui-toast/index.ts", "src/plugins/ui-inventory/index.ts"];
  const declared = files.reduce((n, f) => n + countOf(stripComments(readSource(f)), /api\.system\(\{/g), 0);
  const parsed = registrations().length;
  equal(parsed, declared, `the gate parsed ${parsed} of ${declared} system declarations`);
});

// ===== the HUD element table (P1.32) =====
check("the HUD is an element TABLE: each element carries its OWN gate", () => {
  assert(/SLOT_UI_HUD = defineExtensionPoint/.test(readSource("src/core/extension/slots.ts")),
    "the HUD has an extension point of its own (a plugin can add a HUD element)");
  assert(/gate: \(\) => boolean/.test(readSource("src/data/globals/ui-hud.ts")),
    "…an element carries its own gate");
  const hudSys = stripComments(readSource("src/plugins/ui/systems/hud.ts"));
  assert(/this\.painted\.delete\(id\)/.test(hudSys),
    "…and the host TAKES AN ELEMENT DOWN when its contribution disappears (no frozen widget)");
  assert(!/inventoryOn/.test(hudSys),
    "…and the host knows nothing about the inventory layer any more: that belongs to the hotbar's own gate");
  assert(/build\?\(mount: UiHudMount\): readonly Entity\[\]/.test(readSource("src/data/globals/ui-hud.ts")),
    "…and an element says how it is BUILT (`roots` stays for a tree that was spawned during wiring)");
  assert(/UiLayoutOp/.test(hudSys), "…and the lifetime is DEFERRED to a barrier (a system may not spawn or despawn)");
  assert(/subtreeOf/.test(hudSys), "…taking the whole SUBTREE down with it (the ECS has no cascade)");
});

// ===== THE UI TABLES A PLUGIN CONTRIBUTES INTO (P1.41) =====
check("a plugin's UI actions and sources are installed, and WITHDRAWN with it", () => {
  // A plugin could always write into UI_ACTIONS by hand from `setup`, and then nothing took the entry back
  // out: the id stayed claimed (so a re-install threw `already registered`) and a stale handler stayed
  // reachable from a widget that outlived its plugin. The framework installs what a plugin FILES and removes
  // it together with the plugin.
  const S = load("core/extension/slots.js");
  const { ExtensionRegistry } = load("core/extension/registry.js");
  const { World } = load("core/world.js");
  const T = load("boot/ui-tables.js").uiTables;
  const A = load("data/globals/actions.js");
  const SO = load("data/globals/sources.js");
  const world = new World();
  world.insertResource(A.UI_ACTIONS, A.createUiActions());
  world.insertResource(SO.UI_SOURCES, SO.createUiSources());
  const registry = new ExtensionRegistry();
  const calls = [];
  registry.contribute(S.SLOT_UI_ACTIONS, "probe", [{ id: "probe.act", run: (v) => calls.push(`act:${v}`) }]);
  registry.contribute(S.SLOT_UI_SOURCES, "probe", [{ id: "probe.src", read: () => 42 }]);
  equal(T.install(registry, world, "probe"), 2, "both filed entries are installed");
  world.resource(A.UI_ACTIONS).get("probe.act")("x");
  equal(calls.join(","), "act:x", "…the action is in the table and dispatches");
  equal(world.resource(SO.UI_SOURCES).get("probe.src")(), 42, "…and the source answers");
  equal(T.install(registry, new World(), "probe"), 0, "a world with no UI lane is a no-op");
  const withdrawn = registry.withdraw("probe");
  equal(T.remove(world, withdrawn), 2, "the uninstall takes both back out");
  equal(world.resource(A.UI_ACTIONS).has("probe.act"), false, "…the action id is free again");
  equal(world.resource(SO.UI_SOURCES).has("probe.src"), false, "…and so is the source id");
  // …which is what makes a RE-INSTALL work: the same id can be filed again (this used to throw).
  registry.contribute(S.SLOT_UI_ACTIONS, "probe", [{ id: "probe.act", run: () => {} }]);
  equal(T.install(registry, world, "probe"), 1, "a re-install installs again (no stale claim)");
  // The framework runs both halves — through the INJECTED hook (P1.18d): the kernel declares the shape, the
  // composition root implements it, so `core/` never names the two tables.
  const lc = stripComments(readSource("src/core/plugin/lifecycle.ts"));
  const hp = stripComments(readSource("src/core/plugin/hotplug.ts"));
  assert(/uiTables\?\.install\(registry, world, plugin\.id\)/.test(lc), "installPlugins installs them");
  assert(/host\.uiTables\.install\(registry, world, id\)/.test(hp), "a hot install does too");
  assert(/host\.uiTables\.remove\(world, withdrawn\)/.test(hp), "…and the uninstall removes them with the plugin");
  // …and it is INJECTED, not imported: the installer offers it as an option and the hot-plug host carries it.
  assert(/readonly uiTables\?: UiTablesHook/.test(stripComments(readSource("src/core/plugin/lifecycle.ts"))),
    "the installer takes the hook as an OPTION (absent = no UI lane)");
  assert(/readonly uiTables: UiTablesHook/.test(hp), "the hot-plug host carries it, like its log sink");
  // …while the kernel's own file is a SHAPE: no data module appears in it at all.
  const hook = stripComments(readSource("src/core/plugin/ui-tables.ts"));
  assert(/export interface UiTablesHook/.test(hook) && !/data\//.test(hook),
    "core/plugin/ui-tables.ts declares the shape and names no data module");
  const slots = readSource("src/core/extension/slots.ts");
  assert(/SLOT_UI_ACTIONS = defineExtensionPoint/.test(slots) && /SLOT_UI_SOURCES = defineExtensionPoint/.test(slots),
    "…through two extension points of their own, so a plugin never touches the tables by hand");
});

// ===== THE CATALOGUE IS THE FOLDER TREE (P1.40) =====
check("a plugin folder JOINS the catalogue by existing - and the two cannot drift", () => {
  // The list used to be hand-maintained in main.ts: a folder nobody wired was invisible, and a surface nobody
  // catalogued existed but had no hot-plug key. `plugins/<id>/plugin.ts` is the opt-in now and Vite's glob
  // builds the list. The gate walks the SAME tree, so forgetting one side is red.
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = path.join(ROOT, "src", "plugins");
  const folders = fs.readdirSync(dir).filter((name) => fs.statSync(path.join(dir, name)).isDirectory());
  const opted = folders.filter((name) => fs.existsSync(path.join(dir, name, "plugin.ts")));
  // RAW source (not stripped): the glob pattern itself contains `/*/`, which a comment stripper reads as the
  // start of a block comment and then eats the rest of the file.
  const catalog = readSource("src/boot/plugin-catalog.ts");
  assert(/import\.meta\.glob\("\.\.\/plugins\/\*\/plugin\.ts", \{ eager: true \}\)/.test(catalog),
    "the catalogue is a BUILD-TIME glob over the folder tree (no hand-written list, no runtime disk lookup)");
  const boot = stripComments(readSource("src/boot/main.ts"));
  assert(/discoverPlugins\(pluginHost\)/.test(boot), "the root asks the catalogue for the plugins");
  assert(/const hotCatalog: readonly Plugin\[\] = discoveredPlugins\.filter\(\(p\) => p\.hot\)/.test(boot),
    "…and the HOT catalogue is the discovered set filtered by the flag, not a second hand-written array");
  assert(!/createUiDebugPlugin\(\{ uiPicker \}\)/.test(boot),
    "…so no optional surface is constructed by the root any more");
  // P1.18c: THE ROOT CONSTRUCTS NO SYSTEM AT ALL. The four optional surfaces used to hand their instances in as
  // host instances around panels the ROOT had spawned (`uiPicker`/`uiToast`/`uiKeybind`/`uiInventory`); each
  // builds its own now, panel included, in its own `plugin.ts`. This is the check that keeps the tail closed:
  // `boot/main.ts` may not call one of those factories, nor `new` a system, nor spawn the panels they own.
  // (The VIEWS the root still spawns are a different thing and stay: spawning is a structural change, so WHEN it
  // happens belongs to the wiring — `createUiViews`, the two menus, the frost layer.)
  for (const dead of ["createPickerSystem(", "createToastSystem(", "createKeybindSystem(", "createInventorySystem("]) {
    assert(!boot.includes(dead), `the root constructs no system any more (found ${dead})`);
  }
  assert(!/new \w+System\(/.test(boot), "…and it does not `new` one either");
  assert(!/spawnPickerPanel\(|spawnToastPanel\(|spawnKeybindLine\(/.test(boot),
    "…nor spawns the panels those systems own (each plugin spawns its own now)");
  assert(/INVENTORY_HANDLES\) \? world\.resource\(INVENTORY_HANDLES\)\.panel : NULL_ENTITY/.test(boot),
    "…and the one entity it still paints (the bag's panel) comes from the handle the plugin publishes");
  assert(opted.length >= 4, `at least the four optional surfaces opted in (found: ${opted.join(", ")})`);
  // A DISCOVERED plugin must be in DEFAULT_PLUGINS: "add a folder and forget the default list" is a plugin that
  // exists, compiles, passes every other check and is never installed - which is how the crosshair plugin first
  // shipped. The default list is the one place that decides what a fresh install runs.
  const manifestMod = load("boot/manifest.js");
  for (const name of opted) {
    assert(manifestMod.DEFAULT_PLUGINS.includes(name),
      `${name}: discovered, so it must be in DEFAULT_PLUGINS (or it would never be installed)`);
  }
  for (const name of opted) {
    const src = stripComments(readSource(`src/plugins/${name}/plugin.ts`));
    assert(/export function createPlugin\(host: PluginHost\): DiscoveredPlugin/.test(src),
      `${name}/plugin.ts exports the discovery adapter the catalogue calls`);
    assert(/hot: (true|false)/.test(src), `…and says whether it may be installed at runtime (hot)`);
    assert(/from "\.\/index"/.test(src), `…by adapting to its own factory, not by re-implementing it`);
  }
  // EVERY folder must be either discovered or still named by the root's hand-wired core list: the second
  // migration step (player/render/ui/diagnostics) is what remains, and this keeps that list honest.
  for (const name of folders) {
    if (opted.includes(name)) continue;
    assert(new RegExp(`plugins/${name}"`).test(boot),
      `${name}: not discovered, so the root must still name it (the remaining migration step)`);
  }
});

// ===== WHAT A PLUGIN LEAVES BEHIND (P1.39) =====
check("a plugin's REGISTERED teardowns run once, in reverse, on BOTH leave paths", () => {
  // "Leave nothing behind" was every plugin's own job, and forgetting it shipped three bugs (a frozen picker,
  // a live rubber band, a bag that could still be opened). The framework now runs what a plugin files through
  // `api.onStop` — at the barrier, in reverse registration order, exactly once — on an uninstall AND at quit.
  const T = load("core/plugin/teardown.js");
  const { World } = load("core/world.js");
  const { ExtensionRegistry } = load("core/extension/registry.js");
  const { createPluginApi } = load("core/plugin/api.js");
  const world = new World();
  const api = createPluginApi("probe", world, new ExtensionRegistry(), () => {});
  const order = [];
  api.onStop(() => order.push("first"));
  api.onStop(() => order.push("second"));
  equal(T.runTeardowns(world, "probe"), 2, "every registered teardown runs");
  equal(order.join(","), "second,first", "…in REVERSE order: what was built first is torn down last");
  equal(T.runTeardowns(world, "probe"), 0, "…and exactly ONCE (a second leave finds nothing left to do)");
  equal(T.runTeardowns(world, "never-installed"), 0, "a plugin that registered none is a no-op");
  api.onStop(() => {
    throw new Error("boom");
  });
  api.onStop(() => order.push("survivor"));
  equal(T.runTeardowns(world, "probe", () => {}), 1, "a THROWING teardown does not stop the others");
  equal(order[order.length - 1], "survivor", "…the one registered before it still ran");

  // Both LEAVE paths must run them, or half of the surfaces come back after a quit.
  const lc = stripComments(readSource("src/core/plugin/lifecycle.ts"));
  const hp = stripComments(readSource("src/core/plugin/hotplug.ts"));
  assert(/runTeardowns\(api\.world, plugin\.id\)/.test(lc), "quitting (stopPlugins) runs the registered teardowns");
  assert(/runTeardowns\(world, id/.test(hp), "an uninstall runs them too, before the withdrawal");
  assert(/plugin\.stop\?\.\(api\)/.test(lc),
    "…and a plugin with NO `stop` hook is no longer skipped by stopPlugins");
  for (const id of ["ui-inventory", "ui-debug", "ui-toast", "ui-keybind"]) {
    const src = stripComments(readSource(`src/plugins/${id}/index.ts`));
    assert(/api\.onStop\(/.test(src), `${id}: files its surface teardown through api.onStop (P1.39)`);
    assert(!/\bstop\((?:api)?\)\s*\{/.test(src), `${id}: …and no longer hand-writes a \`stop\` hook for it`);
  }
});

// ===== THE setup IDEMPOTENCY CONTRACT (P1.38) =====
check("a hot RE-INSTALL may call `setup` again: the second run changes nothing", () => {
  // The install path calls `setup` on EVERY (re-)install — the previous filing was WITHDRAWN on uninstall, so
  // the contributions have to be re-filed — which makes idempotency part of the plugin contract rather than a
  // nicety, and it is the one thing that turns "installed it again" into a throw at the barrier. This drives
  // the REAL plugins' setups twice against a REAL World and a REAL registry.
  const Slot = load("core/extension/slots.js");
  const { ExtensionRegistry } = load("core/extension/registry.js");
  const { createPluginApi } = load("core/plugin/api.js");
  const { World } = load("core/world.js");
  const R = load("data/globals/resources.js");
  const pickerStub = { step: () => {}, close: () => {} };
  const toastStub = { step: () => {}, close: () => {} };
  const cases = [
    ["ui-debug", () => ({
      plugin: load("plugins/ui-debug/index.js").createUiDebugPlugin({ uiPicker: pickerStub }),
      resource: R.PICKER_STATE,
    })],
    ["ui-toast", () => ({
      plugin: load("plugins/ui-toast/index.js").createUiToastPlugin({ uiToast: toastStub }),
      resource: R.TOAST,
    })],
    ["ui-inventory", () => ({
      plugin: load("plugins/ui-inventory/index.js").createUiInventoryPlugin({
        uiInventory: { step: () => {} },
        inv: { buildHotbar: () => 0 },
        inWorld: () => true,
      }),
      resource: null,
    })],
  ];
  for (const [id, make] of cases) {
    const world = new World();
    const registry = new ExtensionRegistry();
    const { plugin, resource } = make();
    const api = createPluginApi(id, world, registry, () => {});
    plugin.setup(api);
    const systems = registry.list(Slot.SLOT_SYSTEMS).length;
    const claimed = registry.owners(Slot.SLOT_RESOURCES).length;
    const held = resource ? world.resource(resource) : null;
    equal(systems, 1, `${id}: its setup files exactly one system`);
    // THE REAL SEQUENCE: an uninstall WITHDRAWS this owner's filings (the registry's job), and the re-install
    // files them again. A setup that assumed its entries were still there would throw right here.
    registry.withdraw(id);
    equal(registry.list(Slot.SLOT_SYSTEMS).length, 0, `${id}: an uninstall withdraws its system`);
    plugin.setup(api); // ← the hot re-install
    equal(registry.list(Slot.SLOT_SYSTEMS).length, systems, `${id}: re-installing files the same system again`);
    equal(registry.owners(Slot.SLOT_RESOURCES).length, claimed, `${id}: …and re-claims its resources`);
    if (resource) {
      equal(world.resource(resource) === held, true, `${id}: …while the world keeps the SAME resource object`);
    }
    // …and WITHOUT a withdraw in between, the same setup THROWS — the registry refuses a duplicate id even
    // from the same owner, which is what catches a plugin that files one id twice in a single setup.
    let threw = false;
    try {
      plugin.setup(api);
    } catch {
      threw = true;
    }
    equal(threw, true, `${id}: filing the same id twice (no withdraw between) is REFUSED, loudly`);
  }
  // The framework half, for a plugin that owns a resource: the api's ONCE-semantics helper.
  const probe = new World();
  const probeApi = createPluginApi("probe", probe, new ExtensionRegistry(), () => {});
  probeApi.insertResource(R.TOAST, R.createToastState());
  const firstToast = probe.resource(R.TOAST);
  probeApi.insertResource(R.TOAST, R.createToastState());
  equal(probe.resource(R.TOAST) === firstToast, true,
    "api.insertResource inserts ONCE: a re-install keeps the object the world already holds (P1.28)");

  // …and the contract is written where a plugin AUTHOR reads it, plus the two source rules it implies.
  assert(/hot RE-INSTALL/.test(readSource("src/core/plugin/descriptor.ts")) &&
    /WITHDRAW/.test(readSource("src/core/plugin/descriptor.ts")),
    "the re-install contract (setup -> WITHDRAW -> setup) is documented on Plugin.setup");
  for (const id of ["ui-debug", "ui-toast", "ui-inventory", "ui-keybind", "content-default",
    "world", "input", "player", "render", "ui", "diagnostics"]) {
    const src = stripComments(readSource(`src/plugins/${id}/index.ts`));
    assert(countOf(src, /world\.insertResource/g) <= countOf(src, /hasResource/g),
      `${id}: every resource it inserts is guarded (or uses api.insertResource, which is once-semantics)`);
    equal(countOf(src, /world\.spawn\(|spawnPanel\(|spawnButton\(|spawnLabel\(/g), 0,
      `${id}: a setup SPAWNS nothing — widgets are contributed as DATA and mounted by a host at a barrier`);
  }
});

// ===== THE BLOCK TABLE IS PACK-CHAIN DATA TOO (P1.37) =====
check("a PACK can add a block: the discovered table drives the registry (P1.37)", () => {
  // The same shape as the language check below, one level down: the chain DELIVERS the entries, the content
  // plugin DECLARES them, and the registry ASSEMBLES the engine-side definitions from that declaration. It
  // used to be one function reading the packs itself, at config time, before the install — i.e. content could
  // not be declared at all. NOTE: `installPacks` REPLACES the whole chain, so this and the language check
  // below are the last two checks in this file.
  const Tex = load("data/assets/textures.js");
  const Blocks = load("data/assets/blocks.js");
  const Reg = load("data/assets/blockregistry.js");
  const Slots = load("core/extension/slots.js");
  const { ExtensionRegistry } = load("core/extension/registry.js");

  // THE SELECTION IS AN ENABLED LIST (P1.49ae). The chain honours the LIST, not the folder, which is what makes a
  // pack someone just dropped into `resourcepacks/` start switched off — MC's rule. Two packs on disk, ONE
  // selected: only the selected one contributes bytes, and the other is still LISTED so the screen can offer it.
  const twoPacks = {
    builtin: null,
    mods: [],
    resourcepacks: [
      { name: "packA", builtin: false, files: { "data/blocks.json": packBytes(JSON.stringify({ a: {} })) } },
      { name: "packB", builtin: false, files: { "data/blocks.json": packBytes(JSON.stringify({ b: {} })) } },
    ],
  };
  const selected = Tex.installPacks(twoPacks, ["packA"]);
  assert(/resourcepacks=1 disabled=1/.test(selected), `only the SELECTED pack enters the chain (got: ${selected})`);
  equal(Tex.listPacks().filter((p) => !p.builtin && p.enabled).map((p) => p.name).join(","), "packA", "…and it is the enabled row");
  equal(Tex.listPacks().filter((p) => !p.builtin && !p.enabled).map((p) => p.name).join(","), "packB", "…while the other is listed as NOT enabled");
  equal(Tex.resolveBytes("data/blocks.json") !== null, true, "the selected pack resolves");
  // An EMPTY selection is a real answer ("nothing enabled"), not a fallback to "everything".
  Tex.installPacks(twoPacks, []);
  equal(Tex.listPacks().filter((p) => !p.builtin && p.enabled).length, 0, "an empty selection enables nothing");
  equal(Tex.resolveBytes("data/blocks.json"), null, "…and delivers no bytes at all");
  // The live listing judges by the same list (that is the page's left/right split).
  const listingSig = Tex.updatePackListing(
    {
      builtin: null,
      mods: [],
      resourcepacks: [
        { name: "packA", builtin: false, fileCount: 1, zip: false },
        { name: "packB", builtin: false, fileCount: 1, zip: false },
      ],
    },
    ["packB"],
  );
  equal(listingSig, "packA:-1, packB:1", "…and an available-but-off pack shows no file count (-1)");
  // The BOOT migration is what keeps an existing install working: an absent key means "the folder is the
  // selection", and it is written back at once (a migration kept in memory would re-run and re-enable a pack that
  // was dropped in between). Source-level, because that helper lives in the composition root.
  const bootSrc = stripComments(readSource("src/boot/main.ts"));
  assert(/function resolveEnabledPacks\(/.test(bootSrc), "the boot resolves the selection");
  assert(/Array\.isArray\(file\.enabledPacks\)/.test(bootSrc), "…honouring an explicit list, even an empty one");
  assert(/writeSettings\(next\)/.test(bootSrc), "…and writing the migrated list back at once");
  assert(/delete next\.disabledPacks/.test(bootSrc), "…dropping the old negative key");

  Tex.installPacks({
    builtin: {
      name: "test-pack",
      builtin: true,
      files: {
        "data/blocks.json": packBytes(
          JSON.stringify({
            demo: { label: "Demo Block", side: "block/demo.png" }, // a texture NO pack ships
            plain: { label: "Plain", color: "#123456" },
          }),
        ),
      },
    },
    mods: [],
    resourcepacks: [],
  });
  const entries = Blocks.discoverBlockEntries();
  equal(entries.map((e) => e.id).join(","), "demo,plain", "the chain's entries are discovered, in order");
  equal(entries[0].label, "Demo Block", "…with the raw fields a pack writes");
  equal(Blocks.discoveredBlockLayers(), 1, "…and the LAYER count is reported (0 layers is a different problem)");

  // The CONTENT PLUGIN declares them, through the real extension point, in its own setup.
  const registry = new ExtensionRegistry();
  load("plugins/content-default/index.js").contentDefaultPlugin.setup({
    id: "content-default",
    world: {},
    registry,
    contribute: (point, items) => registry.contribute(point, "content-default", items),
    log: () => {},
  });
  const declared = registry.list(Slots.SLOT_BLOCKS);
  equal(declared.map((b) => b.id).join(","), "demo,plain", "the plugin declares what the pack delivered");

  // …and the REGISTRY assembles the engine-side table FROM the declaration (first build wins).
  const line = Reg.buildBlockRegistry(declared);
  assert(/2 blocks/.test(line), `the summary counts the assembled table (got: ${line})`);
  equal(Reg.allBlockIds().join(","), "demo,plain", "the assembled table is what the readers see");
  equal(Reg.getBlockDef("demo").label, "Demo Block", "…a label from the pack");
  equal(Reg.getBlockDef("demo").hasMissingTexture, true, "…and a face texture no pack ships is FLAGGED");
  equal(Reg.getBlockDef("plain").hasMissingTexture, false, "…while a colour-only block is not");
  assert(Reg.getBlockDef("missing") === undefined, "the empty-chain fallback is NOT registered on top of it");
  equal(Reg.buildBlockRegistry([]), line, "a second build is a no-op (the install's table stays)");

  // The SOURCE facts the boot relies on: the root builds from the declarations, BELOW the install, and the
  // starting items come from the DISCOVERY (that entity is spawned before the install exists).
  const boot = stripComments(readSource("src/boot/main.ts"));
  assert(/buildBlockRegistry\(registry\.list\(SLOT_BLOCKS\)\)/.test(boot),
    "the root assembles the table from SLOT_BLOCKS (no second look at the packs)");
  assert(boot.indexOf("buildBlockRegistry(") > boot.indexOf("installPlugins("),
    "…below the install that fills the extension point");
  assert(/spawnPlayer\(world, SPAWN, discoveredBlockIds\(\)\)/.test(boot),
    "…and the starting items use the same discovery the plugin declares from");
  assert(/SLOT_BLOCKS = defineExtensionPoint/.test(readSource("src/core/extension/slots.ts")),
    "…through a SLOT_BLOCKS extension point of its own");
  equal(countOf(stripComments(readSource("src/data/assets/blockregistry.ts")), /resolveAllBytes/g), 0,
    "…and the registry itself no longer reads the packs (that moved to the discovery)");
});

// ===== THE LANGUAGE SET IS PACK-CHAIN DATA (P1.36) =====
// The data-ization this pins: "which languages does this install support" is DISCOVERED from what the packs
// deliver, DECLARED by the content plugin into SLOT_LANGUAGES, and the loader builds one dictionary per
// declared id. Before this it was a literal in two places (the plugin's list AND i18n's `Lang` union), so
// `lang/fr.json` could sit in a pack forever: nothing ever asked for "fr". The proof is end-to-end — a
// synthetic pack, the REAL content plugin's setup, the REAL `loadLang`, the REAL `t()`.
check("a PACK can add a language: the discovered set drives the dictionaries (P1.36)", () => {
  // It runs LAST on purpose: `installPacks` REPLACES the whole chain, so every earlier check that reads the
  // packs (blocks, textures, the dictionary counts) has already run.
  const Tex = load("data/assets/textures.js");
  const Langs = load("data/assets/languages.js");
  const I18n = load("data/assets/i18n.js");
  const R = load("data/globals/resources.js");
  const Slots = load("core/extension/slots.js");
  const { ExtensionRegistry } = load("core/extension/registry.js");
  const dict = { "lang.xx": "Xx", "main.single": "Singleplayer XX" };
  Tex.installPacks({
    builtin: {
      name: "test-pack",
      builtin: true,
      files: { "lang/xx.json": packBytes(JSON.stringify(dict)) },
    },
    mods: [],
    resourcepacks: [],
  });
  equal(Tex.listPackPaths("lang/").join(","), "lang/xx.json", "the chain reports the paths it really delivers");
  equal(Langs.declaredLanguages().join(","), "zh,en,ja,xx", "…so the declared set grows by the pack's language");

  // The CONTENT PLUGIN declares it, through the real extension point, in its own setup.
  const registry = new ExtensionRegistry();
  load("plugins/content-default/index.js").contentDefaultPlugin.setup({
    id: "content-default",
    world: {},
    registry,
    contribute: (point, items) => registry.contribute(point, "content-default", items),
    log: () => {},
  });
  const declared = registry.list(Slots.SLOT_LANGUAGES).map((l) => l.id);
  equal(declared.join(","), "zh,en,ja,xx", "the plugin declares what the pack chain delivered (not a literal)");

  // …and the LOADER builds a dictionary per declared id: the pack's own string is what `t()` answers.
  const localeState = R.createLocale();
  const line = I18n.loadLang(localeState, "xx", declared);
  assert(/xx=2/.test(line), `the summary counts the pack's dictionary (got: ${line})`);
  equal(localeState.lang, "xx", "a language the install DECLARES is accepted");
  equal(I18n.getLang(), "xx", "…and is the language in force");
  equal(I18n.t("main.single"), "Singleplayer XX", "…so the pack's own translation is what the UI shows");
  equal(I18n.t("no.such.key"), "no.such.key", "a key nobody defines reads as its key");

  // A language NOBODY declares is REFUSED by setLang (nothing changes) — that is what makes the set
  // meaningful instead of decorative. `loadLang` is deliberately the other half: it is the boot's entry point
  // and must always leave a language in force, so it RESOLVES an undeclared value to the fallback — the
  // `booted(...)` table below pins that case by case, from the object shape the boot really builds.
  I18n.setLang("yy");
  equal(I18n.getLang(), "xx", "an undeclared language cannot be switched to");
  I18n.setLang("en");
  equal(I18n.getLang(), "en", "…while a declared one can");

  // A ROW THAT OFFERS A LANGUAGE READS IN THAT LANGUAGE (P1.49ag). Read through `t()` — the language in
  // force — a language a pack just added shows up as the raw key, because no dictionary but the new
  // language's OWN holds a name for it (and that is the one the user cannot read yet). Reported as
  // "the fourth row says lang.fr"; MC's rule is "Francais", never "French in English".
  equal(I18n.t("lang.xx"), "lang.xx", "the language in force has no name for the pack's new language");
  equal(I18n.tIn("xx", "lang.xx"), "Xx", "…so the PICKER reads the row in the language it offers");
  equal(I18n.tIn("ja", "lang.xx"), "lang.xx", "a language with no name for it still falls back to the key");
  equal(I18n.tIn("en", "main.single"), I18n.t("main.single"), "…and to the language in force for a shared key");

  // THE REAL SHAPE (P1.36b). The locale object comes from `createLocale()` — it already holds the first-run
  // default — and the FILE's value is only an argument. The first version of this check built the object WITH
  // the undeclared value, a state the boot never produces, so it passed while the game came up Chinese:
  // `loadLang` left the default in place, the default was DECLARED, and the reader-side fallback could never
  // fire. Both halves are pinned from the default object now, the way the boot does it.
  const booted = (fileValue) => {
    const loc = R.createLocale(); // main.ts: `const locale = createLocale()` — "zh" before the file is read
    I18n.loadLang(loc, fileValue, ["zh", "en", "ja"]);
    return `${loc.lang}/${I18n.getLang()}`;
  };
  equal(booted("fr"), "en/en", "a value whose PACK was deleted resolves to the fallback (en), not to zh");
  equal(booted("xx"), "en/en", "…and a hand-edited bogus value is the same case (not declared)");
  equal(booted(42), "en/en", "…and so is a value of the wrong type");
  equal(booted("en"), "en/en", "a declared value is used as it is");
  equal(booted("ja"), "ja/ja", "…whichever declared one it is");
  equal(booted(undefined), "zh/zh", "NO stored value (a first run) keeps the engine's default — it must not move");
  equal(I18n.t("main.single"), "main.single", "…and with no dictionary behind it, a key reads as its key");

  // The discovery is a DATA function (no plugin import), and the PICKER reads the same list as the loader —
  // that shared source is the point: the drift this replaces made a pack's language publishable but
  // unselectable.
  assert(/listPackPaths/.test(stripComments(readSource("src/data/assets/languages.ts"))),
    "the set is discovered from the pack chain, not listed");
  assert(/const renderLangs = \(\): void => \{[\s\S]*?declaredLanguages\(\)/.test(
    stripComments(readSource("src/plugins/ui/views/menu.ts")),
  ),
    "…and the settings PICKER is built from that same set (a pack's language is selectable, not just loadable)");
  assert(!/"zh", "en", "ja"\]/.test(stripComments(readSource("src/data/assets/i18n.ts"))),
    "…and i18n no longer knows any language by name");
});

// ===== THE MENU BACKDROP IS REBUILT ONLY WHEN IT CHANGED (P1.18g) =====
check("a pack reload rebuilds the menu backdrop ONLY when its bytes changed", () => {
  // The reload used to forget the background memo unconditionally and rebuild: correct, and it cost a full
  // texture rebuild every time — the sample panorama is 2.2 MB, so F7, or toggling a pack that ships no
  // background at all, paid base64 + PNG decode + a GPU upload on the main thread for a picture that had not
  // changed. The driver now asks this question instead, and only disposes/re-derives when the answer is true.
  const Tex = load("data/assets/textures.js");
  const Bg = load("data/assets/background.js");
  const png = (text) => new Uint8Array(Buffer.from(text, "utf8"));
  const chain = (panoramaBytes) => ({
    builtin: null,
    mods: [],
    resourcepacks: [
      {
        name: "packA",
        builtin: false,
        files: {
          "backgrounds/background.json": png(JSON.stringify({ mode: "panorama" })),
          "backgrounds/panorama.png": panoramaBytes,
        },
      },
    ],
  });

  const first = png("PANORAMA-ONE");
  Tex.installPacks(chain(first), ["packA"]);
  equal(Bg.menuBgKind(), "panorama", "the pack's config picks the panorama");
  equal(
    Bg.refreshMenuBackground(),
    false,
    "re-applying the SAME chain does not ask for a rebuild (this is the F7 case)",
  );
  equal(Bg.refreshMenuBackground(), false, "…and it stays settled however often it is asked");

  // A pack that really swapped the image is a rebuild.
  Tex.installPacks(chain(png("PANORAMA-TWO")), ["packA"]);
  equal(Bg.refreshMenuBackground(), true, "a pack that changed the image DOES ask for a rebuild");
  equal(Bg.refreshMenuBackground(), false, "…and then settles again");

  // A chain with no background config at all is the checkerboard — a different kind, so a rebuild.
  Tex.installPacks({ builtin: null, mods: [], resourcepacks: [] }, []);
  equal(Bg.refreshMenuBackground(), true, "losing the pack changes the kind (panorama -> checker)");
  equal(Bg.menuBgKind(), "checker", "…and no config means the checkerboard");
  equal(Bg.refreshMenuBackground(), false, "…which then settles too");

  // The STATIC kind is signed from its own image, the same way.
  Tex.installPacks(
    {
      builtin: null,
      mods: [],
      resourcepacks: [
        {
          name: "packA",
          builtin: false,
          files: {
            "backgrounds/background.json": png(JSON.stringify({ mode: "static" })),
            "backgrounds/mainmenu.png": png("MENU-ONE"),
          },
        },
      ],
    },
    ["packA"],
  );
  // The memo is re-derived BY THE REFRESH (the driver always calls it right after an install; asking
  // `menuBgKind()` on its own answers with what the last refresh concluded — the contract it always had).
  equal(Bg.refreshMenuBackground(), true, "switching to the other mode is a change");
  equal(Bg.menuBgKind(), "static", "the other mode picks the static image");
  equal(Bg.refreshMenuBackground(), false, "…and it is signed from that image");

  // The driver's own shape: the dispose + the view refresh are INSIDE the answer.
  const driver = stripComments(readSource("src/boot/drivers/pack-reload.ts"));
  assert(/const backdropChanged = refreshMenuBackground\(\);/.test(driver), "the driver asks the question once");
  assert(
    /if \(backdropChanged\) \{[\s\S]*?refreshMenuBackdrop\(\);\s*\}/.test(driver),
    "…and disposes + re-derives the backdrop only when it is true",
  );
  // The panorama reaches the GPU from its BYTES (a Blob URL), not from a base64 data URL.
  const scene = stripComments(readSource("src/plugins/render/systems/menu-background.ts"));
  assert(
    /URL\.createObjectURL\(new Blob\(\[bytes\.slice\(\)\]/.test(scene) && !/resolveTexture\(/.test(scene),
    "the panorama texture is loaded from a Blob URL, not a data: URL",
  );
});

// ===== THE PACK TRANSPORT IS BYTES (P1.18f) =====
check("the pack snapshot arrives as ONE binary body, and decoding it COPIES NOTHING", () => {
  // Rust hands over `[u32 LE header length][header JSON][blob]` (`packs::snapshot_blob`) and the front
  // end parses the header and makes views into the blob. Both halves of that framing are pinned here: the
  // Rust half by the real boot (the chain has to resolve its textures), this half by driving the decoder.
  // WHY IT MATTERS: the old shape base64-ed every file and the front end decoded each one with `atob` + a
  // per-byte loop ON THE MAIN THREAD — for a chain the reload re-reads in full, so the sample pack's 2.8 MB
  // panorama was paid again on every F7.
  const Tex = load("data/assets/textures.js");
  const words = packBytes("hello pack");
  const zip = packBytes("PK-not-really-a-zip");
  const blob = new Uint8Array(words.length + zip.length);
  blob.set(words, 0);
  blob.set(zip, words.length);
  const header = new TextEncoder().encode(
    JSON.stringify({
      builtin: {
        name: "default.zip",
        builtin: true,
        files: [],
        zip: { name: "default.zip", off: 0, len: words.length },
      },
      mods: [
        { name: "modA", builtin: false, files: [{ name: "data/blocks.json", off: words.length, len: zip.length }] },
      ],
      resourcepacks: [],
    }),
  );
  const body = new Uint8Array(4 + header.length + blob.length);
  new DataView(body.buffer).setUint32(0, header.length, true);
  body.set(header, 4);
  body.set(blob, 4 + header.length);

  const snap = Tex.decodePackSnapshot(body.buffer);
  equal(snap.builtin.name, "default.zip", "the builtin pack survives the round trip");
  equal(
    Array.from(snap.builtin.zip).join(","),
    Array.from(words).join(","),
    "…and its archive bytes are exactly the blob slice",
  );
  equal(snap.mods.length, 1, "one mod pack");
  equal(snap.mods[0].name, "modA", "…named as the header says");
  const file = snap.mods[0].files["data/blocks.json"];
  equal(new TextDecoder().decode(file), new TextDecoder().decode(zip), "…with the file's own bytes");
  // NOTHING IS COPIED: both values are views into the SAME buffer the IPC handed over.
  equal(file.buffer, body.buffer, "the file's bytes are a VIEW into the snapshot buffer");
  equal(snap.builtin.zip.buffer, body.buffer, "…and so is a zip pack's");
  equal(snap.resourcepacks.length, 0, "an empty list stays empty");
});

// ===== a language that arrives at RUNTIME (P1.49ag) =====
check("a PACK can add a language at RUNTIME: the picker's rows follow the chain (P1.49ag)", () => {
  // P1.36 made the language set CONTENT (the loader reads it) and P1.49ac gave the pack page a way to follow
  // the folder. The picker was left behind by both: its rows were spawned ONE PER DECLARED LANGUAGE while the
  // layout was built, so a pack enabled while the game ran delivered a `lang/<id>.json` the LOADER built a
  // dictionary from and the PICKER could not show. The language was selectable only after a restart — the same
  // "publishable but unselectable" drift P1.36 was about, in the one surface that offers the choice. The rows
  // are a fixed-capacity POOL filled from the declared set now, exactly like the pack columns, and the two
  // events that can change that set re-fill it: the pack-APPLY notification, and the moment the section opens.
  const menu = stripComments(readSource("src/plugins/ui/views/menu.ts"));
  assert(!/langChoices/.test(menu), "the picker no longer spawns one row per language while the layout is built");
  assert(/const langCells = Array\.from\(\{ length: LANG_LIST_CAPACITY \}/.test(menu),
    "…it is a fixed-capacity POOL of rows, the shape the pack columns already use");
  assert(/spawnButton\(world, langCol, "settings\.choice", `\$\{id\}\.lang`, String\(i\), ""\)/.test(menu),
    "…each row is spawned WITH a text (an empty key): without one it has no UI_TEXT and cannot be filled");
  assert(/setUiText\(world, cell, tIn\(lang, `lang\.\$\{lang\}`\), true\)/.test(menu),
    "…and the fill reads the row's own language (`tIn`) as RAW text, not through the language in force");
  assert(/const renderLangs = \(\): void => \{[\s\S]*?declaredLanguages\(\)/.test(menu),
    "…filled from the DECLARED set, i.e. what the chain in force delivers");
  assert(/if \(section === "lang"\) renderLangs\(\);/.test(menu),
    "…and re-filled on the pack-APPLY event, the bus notification `rebuildDerivedFromChain` raises");
  assert(/if \(which === "lang"\) renderLangs\(\);/.test(menu),
    "…so a chain change that landed while another page was up is picked up when this one opens");
  assert(/langShown\[Number\(value\)\]/.test(menu),
    "the action carries the row INDEX and maps it back through the list (a button's value is written at spawn)");
  assert(/export const LANG_LIST_CAPACITY = \d+/.test(readSource("src/data/globals/paint.ts")),
    "the capacity is DATA, next to the pack list's");
  // …and the event it listens for is really raised by the APPLY half of the reload driver, so the chain of
  // evidence is closed: apply -> declare -> notify -> fill (the gate drives the first link above).
  assert(/const dropPackDerivedCaches = \(\): void => \{[\s\S]*?notifyConfigChange\("packs"\)/.test(stripComments(readSource("src/boot/drivers/pack-reload.ts"))),
    "…and the driver announces the chain it just installed from its cache-drop step");
  // …and the value it hands `setLang` is one the install declares, because `renderLangs` filled the list from
  // that same call: a row that is not shown is not clickable, so an index can never point at a stale language.
  assert(/const lang = langShown\[Number\(value\)\];[\s\S]*?if \(lang !== undefined\) setLang\(lang\);/.test(menu),
    "…and an index with no language behind it is a no-op rather than a refusal to switch");
});

// ===== M0 of the GPU route: the LOD sampler probe =====
console.log("\n--- the GPU sampler probe: the reference it compares against, and its drift guards ---");

check("the LOD sampler probe (M0): the GPU field is built from the CPU field's own numbers", () => {
  // The probe compares a GPU port of `terrainHeight` against `lodSampleGrid`. Nothing about that comparison can
  // run here (the gate has no GPU), so what IS asserted is everything the comparison RESTS on:
  //   * the REFERENCE is the production grid — re-derived here from `terrainHeight` and the same wrap, cell by
  //     cell, so "the probe measured the real thing" is not an assumption;
  //   * the field's numbers exist as DATA (`TERRAIN_NOISE`) and the GPU copy reads them, rather than typing the
  //     seed and the octaves out a second time — the one way an f32 port can silently stop matching.
  const L = load("data/world/lod.js");
  const T = load("data/world/terrain.js");
  const { CHUNK_SIZE } = load("data/world/chunk.js");

  equal(L.LOD_SAMPLE_GRID_W, CHUNK_SIZE + 2, "the grid the GPU threads cover is the CPU's (S+2)² one");

  // 1. THE REFERENCE, re-derived. `lodSampleGrid` must be the max/min over the `step × step` fine columns of
  //    each cell, with the cell edges one cell OUTSIDE the chunk (the border that culls the ±X/±Z planes).
  const wrap = (v) => {
    const p = T.terrainPeriod();
    return ((v % p) + p) % p;
  };
  for (const [step, cx, cz] of [
    [2, 3, 5],
    [4, 7, 1],
    [8, 0, 9],
  ]) {
    const grid = L.lodSampleGrid(step, cx, cz);
    equal(grid.max.length, L.LOD_SAMPLE_GRID_W ** 2, `step ${step}: the grid is (S+2)²`);
    let wrong = 0;
    for (let j = 0; j < L.LOD_SAMPLE_GRID_W; j++) {
      for (let i = 0; i < L.LOD_SAMPLE_GRID_W; i++) {
        let hi = 0;
        let lo = T.TERRAIN_MAX_Y;
        const bx = cx * CHUNK_SIZE * step + (i - 1) * step;
        const bz = cz * CHUNK_SIZE * step + (j - 1) * step;
        for (let dz = 0; dz < step; dz++) {
          for (let dx = 0; dx < step; dx++) {
            const h = T.terrainHeight(wrap(bx + dx), wrap(bz + dz));
            if (h > hi) hi = h;
            if (h < lo) lo = h;
          }
        }
        const k = j * L.LOD_SAMPLE_GRID_W + i;
        if (grid.max[k] !== hi || grid.min[k] !== lo) wrong++;
      }
    }
    equal(wrong, 0, `step ${step} at (${cx},${cz}): the reference IS the production max/min grid`);
  }

  // 2. THE FIELD AS DATA, and its bounds really come from the amplitudes (the generator's uniform fast paths
  //    trust them, so a drift here would put solid blocks in a chunk the generator filled as air).
  const spec = T.TERRAIN_NOISE;
  equal(spec.regionCell, 512, "the region term's cell is DATA (it is what a legal world size is a multiple of)");
  // THE TWO SEEDS are the trap that cost the probe's first run a wrong field (max |Δ| 26): the region uses
  // `seed` and the hill stack uses `hillSeed`, and the GPU copy must take BOTH from here.
  equal(spec.hillSeed, spec.seed + 0x51ed270b, "the hill stack's own seed is DATA, and it is not the region's");
  equal(spec.octaves.map((o) => o.join(":")).join(","), "128:1,64:0.5,32:0.25", "the octaves are DATA");
  equal(spec.octaveWeight, spec.octaves.reduce((s, o) => s + o[1], 0), "…and their weights add up to the divisor");
  equal(spec.maxY - spec.baseY, spec.regionAmplitude + spec.hillAmplitude, "the bounds follow the amplitudes");
  equal(spec.minY, spec.baseY - spec.regionAmplitude - spec.hillAmplitude, "…on both sides");
  for (const o of spec.octaves) {
    equal(T.terrainPeriod() % o[0], 0, `octave cell ${o[0]} divides the lap (the periodic wrap needs it)`);
  }
  equal(T.terrainPeriod() % spec.regionCell, 0, "…and so does the region cell");

  // 3. THE PROBE ITSELF, as source: it takes its field from the SHARED TSL module (no second copy of the seed), it
  //    compares against the production accessor, and it declares what it touches. `K` is not a bind, so it is free.
  //    The field lived in this file until M1 needed the same code for the production sampler; it is asserted where
  //    it lives now, and the probe is asserted to IMPORT it rather than to contain it.
  const field = readSource("src/plugins/render/systems/lod-gpu-field.ts");
  const fieldCode = stripComments(field);
  const probe = readSource("src/plugins/render/systems/lod-gpu-probe.ts");
  const probeCode = stripComments(probe);
  assert(/TERRAIN_NOISE/.test(fieldCode) && !/\b1337\b/.test(fieldCode),
    "the GPU field is built from TERRAIN_NOISE — the seed is not typed out a second time");
  assert(/const spec = TERRAIN_NOISE/.test(fieldCode) && /spec\.octaves/.test(fieldCode) && /spec\.regionCell/.test(fieldCode),
    "…including the octave stack and the region cell");
  assert(/spec\.hillSeed/.test(fieldCode),
    "…and the HILL stack's own seed (the omission that cost the probe's first run a field 20 blocks off)");
  assert(/from "\.\/lod-gpu-field"/.test(probeCode),
    "the probe takes that field from the shared module instead of carrying its own copy");
  assert(/lodSampleGrid\(/.test(probeCode), "…and it is compared against the production grid accessor");
  const probeAccess = load("plugins/render/systems/lod-gpu-probe.js").LOD_PROBE_ACCESS;
  assert(probeAccess.readsExternal.includes("renderer3d"), "the probe declares the renderer it computes on");
  assert(probeAccess.writesExternal.includes("lodProbeBuffers"), "…and the scratch buffers it owns");
  // The key it listens on: `K` is unbound in `binds.ts`, like the G/H/J debug views.
  const binds = stripComments(readSource("src/data/globals/binds.ts"));
  assert(!/KeyK/.test(binds), "K is not a gameplay bind, so the probe may take it");
  assert(/edge\.code === "KeyK"/.test(probeCode), "…and the probe really reads that edge");
});

check("the LOD sampler (M1): the far ring samples on the GPU, and WAITS rather than sampling on this thread", () => {
  // M1 moved the far ring's height grids onto the GPU. Three things about it can only be checked HERE, because the
  // gate has no device: the WGSL traps it must not fall back into (asserted as source + as ARITHMETIC), the CPU
  // fallback that keeps a device-less run working, and the STREAM's half of the contract — a column the sampler has
  // not answered for is left UNBUILT (waited for), not sampled on this thread.
  const sampleSrc = stripComments(readSource("src/plugins/render/systems/lod-gpu-sampler.ts"));
  const streamSrc = stripComments(readSource("src/plugins/render/systems/chunk-stream.ts"));

  // 1. THE TWO TRAPS, both of which shipped a whole lost test round in M1a:
  //    * a plain `storage(attr,"uint",n)` has NO `atomicMax` in WGSL (the pipeline does not compile and the dispatch
  //      writes nothing, silently) — the accumulators must be declared `.toAtomic()`;
  //    * the atomics accumulate onto whatever is already in the buffer, so the used prefix has to be RESET before
  //      each dispatch or a batch answers with the maximum over the PREVIOUS batch's leftovers.
  equal(countOf(sampleSrc, /\.toAtomic\(\)/g), 1, "the packed accumulators are declared ATOMIC");
  assert(/packed\.fill\(0, base, base \+ CELLS\)/.test(sampleSrc) &&
    /packed\.fill\(UNSET_MIN, base \+ CELLS, base \+ COLUMN_WORDS\)/.test(sampleSrc),
    "…and the cells this batch will write are RESET before every dispatch (max half and min half)");
  // ONE COLUMN'S SLOTS ARE CONTIGUOUS (M1b): the max cells then the min cells, at `col * COLUMN_WORDS`, so the
  // half offset is a compile-time constant AND what a batch wrote is one contiguous range the readback can ask for.
  assert(/const COLUMN_WORDS = CELLS \* 2/.test(sampleSrc), "one column's slots are contiguous (max then min)");
  assert(/atomicMax\(out\.element\(add\(base, cell\)\)/.test(sampleSrc) &&
    /atomicMin\(out\.element\(add\(base, uint\(CELLS\), cell\)\)/.test(sampleSrc),
    "…and the kernel addresses both halves off that base");
  // …which is what makes the readback proportional to the BATCH instead of to the buffer: a 3-column step-32 batch
  // used to copy the whole 592 KB back for 28 KB of answers.
  assert(/const usedBytes = cols\.length \* COLUMN_WORDS \* 4/.test(sampleSrc) &&
    /getArrayBufferAsync\(this\.packedAttr!, null, 0, usedBytes\)/.test(sampleSrc),
    "the readback asks for exactly the bytes this batch wrote (offset 0, a multiple of 4)");

  // 2. THE WORKGROUP CEILING, as arithmetic: WebGPU's default `maxComputeWorkgroupsPerDimension` is 65535, and the
  //    batch cap is a SAMPLES (= threads) cap, so a future tuning of it can silently produce a failed dispatch.
  const sampleCap = Number(/const BATCH_SAMPLES = ([\d_]+)/.exec(sampleSrc)[1].replace(/_/g, ""));
  assert(sampleCap > 0 && Math.ceil(sampleCap / 64) <= 65535,
    `one batch stays inside maxComputeWorkgroupsPerDimension (${Math.ceil(sampleCap / 64)} of 65535 workgroups)`);
  // The column cap bounds the readback (the packed buffer is a FIXED size, so a batch cannot exceed it).
  const columnCap = Number(/const BATCH_COLUMNS = ([\d_]+)/.exec(sampleSrc)[1].replace(/_/g, ""));
  assert(columnCap > 0 && sampleCap / columnCap >= 1156 * 4,
    "…and a batch of the smallest rung's columns fits in it (the cap is not the binding one there)");

  // 3. THE DECLARATION, as data: the sampler is sequenced by the schedule (it reads the far key set the stream
  //    publishes) and it is the second system allowed on the compute queue.
  const sampleAccess = load("plugins/render/systems/lod-gpu-sampler.js").LOD_SAMPLE_ACCESS;
  assert(sampleAccess.readsExternal.includes("renderer3d"), "the sampler declares the renderer it computes on");
  assert(sampleAccess.readsExternal.includes("chunkMeshes"),
    "…and the chunk cache, whose far key set is its WORK LIST (which is what orders it after `chunk.stream`)");
  assert(sampleAccess.writesExternal.includes("lodSampleBuffers"), "…and the buffers it owns");

  // 4. THE DEVICE-LESS BEHAVIOUR, driven for real. `gridFor` must NOT sample on this thread while the backend is
  //    merely UNKNOWN (the renderer is constructed during wiring and initialised behind the loading screen), and it
  //    MUST answer from the CPU once there is no backend at all — a hole in the far ring is never an option.
  const { LodGpuSampler } = load("plugins/render/systems/lod-gpu-sampler.js");
  const { lodSampleGrid, DEFAULT_LOD } = load("data/world/lod.js");
  const P = loadPresentation();
  const sampleWorld = new World();
  sampleWorld.insertResource(P.RENDERER3D, {}); // a renderer with no backend yet
  sampleWorld.insertResource(P.CHUNK_MESHES, P.createChunkMeshCache({ add() {}, remove() {} }));
  const sampleLines = [];
  const sampler = new LodGpuSampler(sampleWorld, (line) => sampleLines.push(line));
  equal(sampler.gridFor(2, 3, 4), null, "an uninitialised renderer makes the far ring WAIT (no CPU sampling yet)");
  for (let i = 0; i < 601; i++) sampler.step();
  const fallback = sampler.gridFor(2, 3, 4);
  assert(fallback !== null, "…and a renderer that never appears hands the column to the CPU instead of losing it");
  const reference = lodSampleGrid(2, 3, 4);
  equal([...fallback.max].join(","), [...reference.max].join(","), "…with the CPU field's own max values");
  equal([...fallback.min].join(","), [...reference.min].join(","), "…and its own min values");
  assert(sampleLines.some((l) => /LODSAMPLE off/.test(l)), "…and it says which backend it gave up on");

  // 5. THE STREAM'S HALF: with a source that never answers, NO far chunk is decided (the stream waits, which is what
  //    keeps the 290 ms step-32 column off this thread); with a source that answers, far chunks ARE decided — the
  //    same window, so the only difference is the sampler.
  const { ChunkStreamSystem } = load("plugins/render/systems/chunk-stream.js");
  const buildStream = (source) => {
    const w = new World();
    w.insertResource(VOXEL, {
      ensureChunk() {},
      getChunk: () => null,
      isSolid: () => false,
      takeDirty: () => [],
      takeStale: () => [],
      markAllStale: () => 0,
    });
    w.insertResource(LOCAL_PLAYER, localPlayer);
    const cache = P.createChunkMeshCache({ add() {}, remove() {} });
    w.insertResource(P.CHUNK_MESHES, cache);
    w.insertResource(P.CHUNK_MATERIAL, P.createChunkMaterial());
    w.insertResource(FADE_OPTIONS, createFadeOptions());
    w.insertResource(KEY_EVENTS, createKeyEventLog());
    return { cache, stream: new ChunkStreamSystem(w, undefined, null, DEFAULT_LOD, source) };
  };
  const farDecided = (cache) =>
    [...cache.empty, ...cache.meshes.keys()].filter((k) => /^\d+:/.test(k)).length;
  const waiting = buildStream({ gridFor: () => null });
  for (let i = 0; i < 30; i++) waiting.stream.step();
  equal(farDecided(waiting.cache), 0, "a sampler that never answers builds NO far chunk (nothing is sampled here)");
  // …and the same window WITH an answer: the far ring really is built from the source's grids (the mesher is the
  // no-GPU stub, so a chunk that has geometry is recorded in `empty` — "decided", not "empty sky").
  const answered = buildStream({ gridFor: (step, cx, cz) => lodSampleGrid(step, cx, cz) });
  for (let i = 0; i < 30; i++) answered.stream.step();
  assert(farDecided(answered.cache) > 0, "…and the same window DOES build far chunks once the source answers");
  // The wait is bounded per frame, not per window: the cap is what keeps a behind-the-scenes sampler from turning
  // the far loop into a scan of the whole ladder.
  assert(/const LOD_WAIT_PER_FRAME = \d+/.test(streamSrc), "the far loop has a per-frame WAIT budget of its own");
  assert(/cost === FAR_NOT_READY \? waits\+\+/.test(streamSrc.replace(/\s+/g, " ")) ||
    /if \(cost === FAR_NOT_READY\) waits\+\+/.test(streamSrc),
    "…and a not-ready chunk spends THAT budget instead of the mesh budget");
  assert(/return FAR_NOT_READY/.test(streamSrc), "…while `buildFar` answers the sentinel instead of building nothing at all");

  // 6. THE DRAW-SIDE ACCOUNTS (M1b), which are what the NEXT milestone is chosen from. `Renderer.info` documents
  //    its counters as "of the current frame", and the MEASUREMENT agreed: across a motionless minute `calls`
  //    stayed at exactly 1620 while `renders` kept climbing — a per-frame counter, not an accumulating one (and
  //    nothing here calls `info.reset()`, which only happens in `setAnimationLoop`'s own loop, so the first
  //    version — reading it once a second — printed impossible values). One reading therefore arrives, sampled
  //    EVERY DRAWN FRAME and averaged; a second "accumulated delta" reading was tried for one round, proved wrong
  //    by that log, and is gone. The FRAME line and the F3 panel must read the SAME account, and the monotonic
  //    render-pass count rides along as a sanity reference.
  const mainSrc = stripComments(readSource("src/boot/main.ts"));
  assert(/probe\.drawCallRawSum \+= rawDrawCalls;/.test(mainSrc) && /probe\.triangleRawSum \+= rawTriangles;/.test(mainSrc),
    "the draw-call figure is the RAW reading, sampled every drawn frame");
  assert(/probe\.callsPerFrame = probe\.drawCallRawSum \/ frames;/.test(mainSrc) &&
    /probe\.trisPerFrame = probe\.triangleRawSum \/ frames;/.test(mainSrc),
    "…averaged over the DRAWN frames");
  assert(!/DeltaSum|callsΔ/.test(mainSrc),
    "…and the accumulated-delta reading is gone (the log proved the counter is per frame)");
  assert(/if \(rawDrawCalls > probe\.drawCallMax\) probe\.drawCallMax = rawDrawCalls;/.test(mainSrc),
    "…keeping the window's worst frame");
  assert(!/info\.reset\(\)/.test(mainSrc),
    "…and nothing resets three's counters (a reset would zero the live memory counts for good)");
  assert(/calls=\$\{probe\.callsPerFrame\.toFixed\(0\)\} callsMax=\$\{probe\.drawCallMax\}/.test(mainSrc),
    "the FRAME line carries both");
  assert(/renders=\$\{info\.render\.calls\}/.test(mainSrc),
    "…plus the monotonic render-pass count, which must grow by about `n` per window");
  const diagSrc = stripComments(readSource("src/plugins/render/systems/diagnostics.ts"));
  assert(/this\.frameProbe\.callsPerFrame/.test(diagSrc) && /this\.frameProbe\.drawCallMax/.test(diagSrc) &&
    /f3\.draw/.test(diagSrc),
    "…and the F3 panel reads the SAME account (one number, two readers)");

  // 6c. AND THE CPU-vs-GPU QUESTION IS ANSWERABLE FROM THE LOGS (P2.07). The user's next question was which side
  //     the frame is bound by, and neither log could say: the F3 panel showed a GPU TIME, nothing showed which
  //     GPU, and the GPU number only existed while the panel was up. Three things are pinned here:
  //       * the `FRAME` line carries `gpu=` beside `avg=` (a `gpu=` close to `avg=` is GPU-bound; a `gpu=` well
  //         under a large `avg=` means the main thread is what the frame waits on) — so it must be printed
  //         whether or not F3 is up;
  //       * the sampler therefore drains the timestamp pool on a SLOW cadence even while the panel is hidden
  //         (an unresolved pool is what the old "Maximum number of queries exceeded" warning was about), while
  //         the fast cadence stays tied to the panel (P1.88: per-frame maps at an uncapped rate were the bug);
  //       * the startup logs WHICH ADAPTER WebGPU got, because `powerPreference` is only a request and the
  //         WebView2 process can be pinned to the integrated GPU by Windows — the engine could draw on the iGPU
  //         with the discrete card idle and nothing said so.
  assert(/gpu=\$\{perf\.gpuMs === null \? "\?" : perf\.gpuMs\.toFixed\(1\)\}ms/.test(mainSrc),
    "the FRAME line prints `gpu=` beside `avg=` (the CPU-vs-GPU discriminator)…");
  assert(/get gpuMs\(\): number \| null/.test(stripComments(readSource("src/core/services/perf.ts"))),
    "…from the sampler's own EMA, which the F3 panel reads too…");
  assert(/panelVisible \? GPU_SAMPLE_MS : GPU_IDLE_SAMPLE_MS/.test(diagSrc) &&
    /const GPU_IDLE_SAMPLE_MS = 1000;/.test(diagSrc),
    "…and the GPU timestamp query is drained on a slow cadence even with the panel hidden (no accumulation)");
  const startupSrc = stripComments(readSource("src/boot/drivers/startup.ts"));
  assert(/await logGpuAdapter\(deps\.log\);/.test(startupSrc) &&
    /BOOT gpu adapter: vendor=\$\{field\(info\.vendor\)\}/.test(startupSrc) &&
    /requestAdapter\(\{ powerPreference: "high-performance" \}\)/.test(startupSrc),
    "…and the startup logs WHICH adapter WebGPU got (vendor/architecture/device, plus fallback and timestamp-query)");

  // 6b. …AND THE CHUNK TEXTURES ARE SHARED PER URL, which is the fix for the OTHER black-region report («按 G 之后
  //     出现纯黑块，有时自己消失»): three uploads a texture with no image yet as a 1×1 UNINITIALISED (black)
  //      texture, so building a fresh `TextureLoader().load(url)` per MATERIAL made every new material draw black
  //      until its image landed — and pressing G resolves every look for every rung at once. One texture per URL
  //      (cached in the CHUNK_MATERIAL resource) reuses the already-loaded image instead.
  const meshSrc = stripComments(readSource("src/host/browser/chunkmesh.ts"));
  assert(/function textureFor\(state: ChunkMaterialState, url: string\)/.test(meshSrc) &&
    /state\.textures\.get\(url\)/.test(meshSrc) && /state\.textures\.set\(url, texture\)/.test(meshSrc),
    "one TEXTURE per resolved URL, cached in the CHUNK_MATERIAL resource");
  equal(countOf(meshSrc, /new THREE\.TextureLoader\(\)\.load\(/g), 1,
    "…and the loader is called in exactly ONE place (a per-material texture is what made the black patches)");
  assert(/map: textureFor\(state, spec\.texture\)/.test(meshSrc) && /checkerMaterial\(state\)/.test(meshSrc),
    "…and every material (tinted variants and the checker included) takes its map from that cache");
});

// ===== M2a: the mesher's DECISION as a compute kernel, held to the production CPU mesher =====
console.log("\n--- M2a: the GPU mesher decides every face like `meshChunk` ---");

check("M2a: the padded block IS the culling rule, and the GPU census IS the CPU mesher's", () => {
  // WHAT THIS CAN AND CANNOT TEST. There is no device here, so the kernel itself cannot run — but its LOGIC can,
  // because it is a walk over the padded block with the offsets in `FACES`, and that walk exists on the CPU too
  // (`censusOfPad`, the kernel's twin). So the gate proves the two things the kernel rests on:
  //   1. `buildPaddedVoxels` answers EXACTLY what `meshChunk`'s own `solidAt` answers — a one-cell solidity border
  //      whose every neighbour is a constant offset away, with the ±Z planes read the transposed way the gatherer
  //      wrote them (reading them the other way is a bug that only shows at a chunk border);
  //   2. the census that walk produces equals the census of the PRODUCTION mesher's output, for patterns whose
  //      answer is also known in closed form.
  // What stays unverified until the user presses `M` is the WGSL itself — the same position M0 was in, and the
  // reason the probe reports a verdict rather than asserting one.
  const mesher = load("plugins/render/systems/lod-gpu-mesher.js");
  const mesh = load("data/world/mesh.js");
  const { CHUNK_SIZE, CHUNK_VOLUME, AIR, SOLID } = load("data/world/chunk.js");

  const synthetic = (pattern, planeSolid) => {
    const blocks = new Uint8Array(CHUNK_VOLUME);
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let ly = 0; ly < CHUNK_SIZE; ly++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          blocks[lx + ly * CHUNK_SIZE + lz * CHUNK_SIZE * CHUNK_SIZE] = pattern(lx, ly, lz);
        }
      }
    }
    const planes = new Uint8Array(6 * CHUNK_SIZE * CHUNK_SIZE);
    if (planeSolid) planes.fill(1);
    return { uniform: false, uniformValue: AIR, blocks, planes };
  };
  const censusOf = (input) => {
    const cpu = mesher.censusOfMesh(mesh.meshChunk(input));
    const pad = mesher.censusOfPad(mesh.buildPaddedVoxels(input));
    return { cpu, pad };
  };
  const same = (a, b) =>
    a.total === b.total &&
    a.counts.every((v, i) => v === b.counts[i]) &&
    a.sum.every((v, i) => v === b.sum[i]) &&
    a.xor.every((v, i) => v === b.xor[i]);

  // 1. THE CLOSED FORMS, where the culling rule's answer is arithmetic and nothing else.
  const S = CHUNK_SIZE;
  const cases = [
    ["empty air", synthetic(() => AIR, false), 0],
    ["uniform solid in air", synthetic(() => SOLID, false), 6 * S * S],
    ["uniform solid, all neighbours solid", synthetic(() => SOLID, true), 0],
    ["one block in air", synthetic((lx, ly, lz) => (lx === 16 && ly === 16 && lz === 16 ? 4 : AIR), false), 6],
    ["solid with one AIR voxel (the hole's six faces add)", synthetic((lx, ly, lz) => (lx === 16 && ly === 16 && lz === 16 ? AIR : SOLID), false), 6 * S * S + 6],
  ];
  for (const [name, input, faces] of cases) {
    const { cpu, pad } = censusOf(input);
    equal(cpu.total, faces, `${name}: the CPU mesher emits the closed-form count`);
    equal(pad.total, faces, `…and the walk over the PADDED block agrees (${name})`);
  }

  // 2. THE MULTI-VALUE CASES, where slots, kinds and the signature all matter: a wrong corner, normal or UV
  //    changes the signature, and a wrong cull changes the count.
  const multi = [
    ["three value bands", synthetic((_lx, ly) => (ly < 8 ? 1 : ly < 16 ? 2 : ly < 24 ? 3 : AIR), false)],
    ["checkerboard", synthetic((lx, ly, lz) => ((lx + ly + lz) % 2 === 0 ? 1 : AIR), false)],
    ["edited chunk (a hole and a stray block)", synthetic((lx, ly, lz) => {
      if (lx === 4 && ly === 5 && lz === 6) return AIR; // dug out of the rock
      if (lx === 7 && ly === 20 && lz === 7) return 2; // placed in the air
      return ly < 16 ? 3 : AIR;
    }, false)],
  ];
  for (const [name, input] of multi) {
    const { cpu, pad } = censusOf(input);
    assert(cpu.total > 0, `${name}: something is meshed`);
    assert(same(cpu, pad), `${name}: the padded walk's census equals the production mesher's (count, sum AND xor per look)`);
  }

  // 3. AND THE PAD IS THE *ONLY* DIFFERENCE: a border that disagrees with `meshChunk`'s neighbour planes must change
  //    the census the same way on both sides. **A NON-UNIFORM BORDER IS THE ONLY KIND THAT PROVES IT**: a uniform
  //    plane is symmetric, so a transposed ±Z read is invisible with all-air or all-solid planes (the mutation test
  //    that dropped the transposition passed until this case existed — the same trap `makeSolidAt`'s comment
  //    records for the production mesher).
  const patterned = () => {
    const input = synthetic((lx, ly) => (ly < 16 ? SOLID : AIR), false);
    const S2 = CHUNK_SIZE;
    for (let a = 0; a < S2; a++) {
      for (let b = 0; b < S2; b++) {
        // ASYMMETRIC on purpose: a pattern symmetric in (a, b) survives a transposed read, which is exactly how
        // the first version of this case passed a deliberately broken pad.
        const on = (a * 5 + b * 3) % 7 < 2 ? 1 : 0;
        input.planes[0 * S2 * S2 + a * S2 + b] = on; // +X
        input.planes[1 * S2 * S2 + a * S2 + b] = on; // -X
        input.planes[2 * S2 * S2 + a * S2 + b] = on; // +Y
        input.planes[3 * S2 * S2 + a * S2 + b] = on; // -Y
        input.planes[4 * S2 * S2 + a * S2 + b] = on; // +Z, laid out as (a, b) = (lx, ly)
        input.planes[5 * S2 * S2 + a * S2 + b] = on; // -Z
      }
    }
    return input;
  };
  const checkerBorder = patterned();
  {
    const { cpu, pad } = censusOf(checkerBorder);
    assert(cpu.total > 0, "a checkerboard border culls a different set of faces");
    assert(same(cpu, pad), "…and the padded walk follows a NON-UNIFORM border exactly (this is what catches a transposed ±Z plane)");
  }
  const borderA = synthetic(() => SOLID, false); // air on all six sides: the whole 6 × 32² shell is drawn
  const borderB = synthetic(() => SOLID, true); // solid on all six sides: nothing is drawn at all
  assert(!same(censusOf(borderA).cpu, censusOf(borderB).cpu), "the neighbour planes really decide the shell's faces");
  assert(
    same(censusOf(borderA).cpu, censusOf(borderA).pad) && same(censusOf(borderB).cpu, censusOf(borderB).pad),
    "…and the padded walk follows them in both extremes",
  );

  // 4. THE SOURCE CONTRACT: what the kernel must keep doing, and the two traps that already cost a test round each.
  const mesherSrc = stripComments(readSource("src/plugins/render/systems/lod-gpu-mesher.ts"));
  equal(countOf(mesherSrc, /\.toAtomic\(\)/g), 3,
    "all three accumulators are ATOMIC (storage(attr, \"uint\", n) declares a plain ptr<storage, u32, read_write>, which has no atomicAdd — the pipeline then fails to compile and the dispatch silently writes nothing)");
  assert(/atomicAdd\(counts\.element\(key\), uint\(1\)\)/.test(mesherSrc), "…and the face count is incremented per emitted face");
  assert(/FACES\.map\(\(face, index\)/.test(mesherSrc) && /CORNER_UVS/.test(mesherSrc),
    "the kernel's face table is DERIVED from the shared FACES/CORNER_UVS data (a retyped corner is how a port drifts)");
  assert(/PAD_W/.test(mesherSrc) && !/face\.dir\[1\] \* 32/.test(mesherSrc),
    "…and its neighbour offsets are pad strides, not hand-written 32s");
  assert(/\)\.compute\(CHUNK_VOLUME\)/.test(mesherSrc) && /const lx = mod\(idx, uint\(CHUNK_SIZE\)\)/.test(mesherSrc),
    "one thread per voxel, in meshChunk's own (lx + ly*32 + lz*1024) numbering");
  assert(/uint\(/ .test(mesherSrc) && !/Loop\(/.test(mesherSrc),
    "…and every index node is u32 with no `Loop` counter in sight (an i32 counter mixed into u32 arithmetic does not compile at all — M0's trap)");
  const meshSrcPad = stripComments(readSource("src/data/world/mesh.ts"));
  assert(/export function buildPaddedVoxels/.test(meshSrcPad) && /out\[padIndex\(lz, ly, S\)\]|out\[padIndex\(lx, ly, S\)\]/.test(meshSrcPad),
    "the pad lives NEXT TO the gatherer that lays the planes out (the ±Z transposition has one home)");

  // 5. THE PROBE: the production mesher is the reference, `M` is the trigger, and it must not pretend to work on a
  //    backend without compute (a logged no-op, exactly like the M0 probe and the M1 sampler).
  const probeSrc = stripComments(readSource("src/plugins/render/systems/lod-gpu-mesher-probe.ts"));
  assert(/meshChunk\(probeCase\.input\)/.test(probeSrc) && /censusOfMesh\(mesh\)/.test(probeSrc),
    "the probe compares against the PRODUCTION mesher's own output, per case");
  assert(/edge\.code === "KeyM"/.test(probeSrc) && /this\.keys\.drain/.test(probeSrc),
    "`M` starts it, through the same one-edge channel every global chord uses");
  assert(!/KeyM/.test(stripComments(readSource("src/data/globals/binds.ts"))), "…and M is not a gameplay bind");
  assert(/isWebGPUBackend !== true/.test(probeSrc) || /backend\?\.isWebGPUBackend === true/.test(probeSrc),
    "…and a backend without compute turns it into a logged no-op rather than a silent lie");
  assert(/expectedFaces/.test(probeSrc) && /CLOSED FORM SAYS/.test(probeSrc),
    "…and the synthetic cases carry a closed-form face count to check the CPU reference itself against");
});

// ===== M3a: the far ring drawn as (look, tier) batches =====
console.log("\n--- M3a: the far ring's chunks are handed to (look, tier) BatchedMeshes ---");

check("M3a: the far ring's geometry is drawn through (look, tier) BATCHES", () => {
  // WHY THIS EXISTS. A six-rung ladder puts ~1250 chunk meshes in the scene and each draws one call per LOOK, so
  // `calls` measured ~2520 (peak 3785) per frame. `THREE.BatchedMesh` collapses that to one call per (look, tier)
  // — but it can only do so under two constraints the stream has to respect, and they are what this group pins:
  //   * PER-INSTANCE VISIBILITY exists (the reserve handover needs it — `setVisibleAt`), and
  //   * PER-INSTANCE OPACITY does not (one material per batch), so a chunk that is FADING is never batched: it is
  //     promoted when its fade-in ends and demoted before a fade-out, which is exactly where those two calls sit.
  const { FarBatches } = load("plugins/render/systems/far-batches.js");
  const THREE = require("three/webgpu");
  const batchSrc = stripComments(readSource("src/plugins/render/systems/far-batches.ts"));
  const streamSrc = stripComments(readSource("src/plugins/render/systems/chunk-stream.ts"));

  // 1. THE SOURCE CONTRACT. One bucket per (look, tier); grown BEFORE `addGeometry`, which THROWS at capacity
  //    rather than shrinking the request; and the promote/demote pair around the fades.
  assert(/new THREE\.BatchedMesh\(/.test(batchSrc), "the batches are three.js BatchedMesh objects (one draw call each)");
  assert(/setGeometrySize\(/.test(batchSrc) && /setInstanceCount\(/.test(batchSrc),
    "…grown through setGeometrySize/setInstanceCount before addGeometry (which throws at capacity)");
  assert(/const key = `\$\{spec\.key\}\\u0000\$\{step\}`/.test(batchSrc), "…one bucket per (look, tier)");
  assert(/if \(!this\.beginFade\(key, entry\)\) this\.promoteFar\(key, entry\);/.test(streamSrc),
    "a far chunk that never faded (the fade switched off) is batched right away…");
  assert(/if \(!fade\.out\) this\.promoteFar\(this\.keyOf\(fade\.entry\), fade\.entry\);/.test(streamSrc),
    "…and one whose fade-IN ends is batched at that moment (a batch has one material, so no per-instance opacity)");
  assert(/this\.demoteFar\(key\);\s*\n?\s*this\.cache\.meshes\.delete\(key\);/.test(streamSrc),
    "a chunk that leaves the window comes OUT of its batches first (the fade-out needs its own mesh)");
  assert(/private place\(entry: ChunkMeshEntry\): void \{[\s\S]{0,400}this\.batches\?\.setMatrix/.test(streamSrc),
    "…and a batched chunk is placed by its INSTANCE matrices (each chunk keeps its own place and torus wrap)");
  // The vertex data is sliced per look: `addGeometry` copies whatever it is handed, so handing it the chunk's full
  // attribute arrays would store every look's vertices once per look.
  assert(/function sliceLook\(/.test(batchSrc) && /getX\(indexStart \+ i\)/.test(batchSrc),
    "each look becomes a self-contained slice (its own vertex range, indices rebased to 0)");

  // 1b. `L` IS THE A/B SWITCH (M3a), and it must be unbound like G/H/J/K: whether a `BatchedMesh` actually DRAWS
  //     is the one thing this gate cannot test (no device), so the engine ships a keypress that takes the far ring
  //     back to the pre-M3a path and back again — "missing/misplaced far ring" and "batches do not render" are
  //     then distinguishable in one press, and the FRAME line's `calls=` moves with it.
  assert(!/KeyL/.test(stripComments(readSource("src/data/globals/binds.ts"))), "L is not a gameplay bind");
  assert(/edge\.code === "KeyL"/.test(streamSrc) && /private demoteAllFar\(\)/.test(streamSrc) &&
    /private promoteAllFar\(\)/.test(streamSrc),
    "…and L switches the far ring's batching off (demote every chunk) and on (promote every settled one)");
  assert(/if \(!this\.batchingEnabled \|\| entry\.step <= 1 \|\| this\.batched\.has\(key\)\) return;/.test(streamSrc),
    "…respected by the promotion itself");

  // 1c. A RESIZE MUST REBUILD THE BUCKET'S MATERIAL. This is the ONE thing `BatchedMesh` does not do for you, and
  //     it is the bug M3a shipped first (reported as «lod 好像被破坏了一样在闪，面到处飞，按 G/H/重载资源包又恢复
  //     正常，一动起来又出问题»): `setInstanceCount` DISPOSES and recreates `_matricesTexture`/`_indirectTexture`,
  //     the compiled node graph captured those texture OBJECTS when it was built (`nodes/accessors/Batch.js`), and
  //     the only thing that rebuilds it is a change of `material.version` (`RenderObjects.get()` — the pipeline
  //     cache key does not mention the textures at all). Without the bump the shader keeps sampling freed textures
  //     and every instance matrix comes back garbage; ANY material change recompiles it (which is why G, H and a
  //     pack reload cured it) and the next growth breaks it again. So: the resize is decided and applied FIRST,
  //     and the version is bumped after it.
  assert(/const resizeInstances = bucket\.allocated \+ 1 > batch\.maxInstanceCount;/.test(batchSrc),
    "a bucket's instance growth is decided BEFORE the two release calls…");
  assert(/if \(grow \|\| resizeInstances\)/.test(batchSrc) && /for \(const material of bucket\.materials\) material\.needsUpdate = true;/.test(batchSrc),
    "…and every material the bucket has used is marked dirty after any resize (the rebuild re-captures the NEW textures)");
  assert(/START_INSTANCES = 512;/.test(batchSrc),
    "…with the instance capacity bought up front: a rebuild is not free, so 512 covers a lap's bucket (~300)…");
  assert(/INSTANCES START HIGH ON PURPOSE/.test(readSource("src/plugins/render/systems/far-batches.ts")),
    "…and the reason is written where the next reader will hit it");

  // 1c2. AND THE RESIZE MARKS EVERY MATERIAL THE BUCKET HAS USED, not just the one in force. three.js keeps ONE
  //      RENDER OBJECT PER (batch, material) PAIR, and each of those captured the batch's matrices/indirect
  //      textures when IT was built — so a resize that bumps only the current material leaves the other one
  //      sampling freed textures. That is the report «当 G 键关闭后 lod 又会像被破坏了一样，但是有时候又莫名其妙
  //      恢复»: the tinted and the untinted material were captured at different times, so exactly one was correct,
  //      and it "recovered on its own" whenever something else happened to bump the stale one.
  assert(/readonly materials: Set<THREE\.Material>/.test(batchSrc) && /materials: new Set\(\[material\]\)/.test(batchSrc),
    "a bucket remembers EVERY material it has been drawn with…");
  assert(/bucket\.materials\.add\(material\);/.test(batchSrc),
    "…the tint toggle and a pack reload add the material they install…");
  assert(/for \(const material of bucket\.materials\) material\.needsUpdate = true;/.test(batchSrc),
    "…and a resize bumps ALL of them (three.js rebuilds a render object only when its material's version moves)");

  // 1d. THE INSTALLED THREE MUST CARRY THE #34211 FIX (r186). The bug: a batch under 65536 vertices gets a Uint16
  //     index, `onBeforeRender` caches the multi-draw offsets in BYTES at that element size, the WebGPU upload
  //     rewrites the index to Uint32 IN PLACE, and the backend — before r186 — divided those cached bytes by the
  //     array's CURRENT size, so every draw whose `indexStart > 0` started at HALF its offset and read indices out
  //     of the middle of a NEIGHBOURING slice (shards of the wrong chunk; only the first slice correct, which is
  //     why `H`, whose wireframe branch uses one formula on both sides, appeared to "cure" it). r186 fixes it by
  //     remembering the size the offsets were cached with. Pinning `^0.186.1` in package.json is not enough — a
  //     lockfile can resolve elsewhere — so both halves are read out of the INSTALLED three.
  const threeBatch = readSource("node_modules/three/src/objects/BatchedMesh.js");
  const threeBackend = readSource("node_modules/three/src/renderers/webgpu/WebGPUBackend.js");
  assert(/_multiDrawBytesPerElement/.test(threeBatch),
    "the installed three's BatchedMesh records the element size its multi-draw offsets were cached with (the #34211 fix)…");
  assert(/object\._multiDrawBytesPerElement/.test(threeBackend),
    "…and its WebGPU backend divides by THAT, not by the index array's current size (which the upload changes)");

  // 2. THE BEHAVIOUR, on a REAL geometry (three object construction needs no GPU, which is what makes this
  //    testable here at all: only RENDERING a batch needs a device).
  const group = new THREE.Group();
  const batches = new FarBatches(group);
  const makeGeometry = () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(8 * 3), 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(8 * 3), 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(8 * 2), 2));
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]), 1));
    geometry.addGroup(0, 6, 0); // look 0: the first face
    geometry.addGroup(6, 6, 1); // look 1: the second
    return geometry;
  };
  const specs = [
    { key: "look-a", texture: null, color: "#ffffff" },
    { key: "look-b", texture: null, color: "#000000" },
  ];
  const materials = [new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial()];
  const place = (matrix) => matrix.identity();
  const first = batches.add(4, makeGeometry(), specs, materials, place);
  assert(first !== null, "a real chunk geometry is sliced into its looks");
  equal(first.instances.length, 2, "…one instance per look");
  equal(batches.stats.buckets, 2, "…into one bucket per (look, tier)");
  equal(batches.stats.instances, 2, "…both live");
  const second = batches.add(4, makeGeometry(), specs, materials, place);
  equal(batches.stats.buckets, 2, "another chunk of the same looks SHARES those buckets");
  equal(batches.stats.instances, 4, "…it only adds instances (so it costs no draw call)");
  batches.add(8, makeGeometry(), specs, materials, place);
  equal(batches.stats.buckets, 4, "another TIER is another bucket (one draw call per look and tier)");
  batches.setVisible(second, false);
  equal(
    second.instances.map((instance) => instance.bucket.batch.getVisibleAt(instance.id)).join(","),
    "false,false",
    "visibility is PER INSTANCE — which is what the reserve handover needs",
  );
  const swapped = new THREE.MeshBasicMaterial();
  batches.refreshMaterials(() => swapped);
  equal(
    first.instances.every((instance) => instance.bucket.batch.material === swapped),
    true,
    "a bucket is ONE material: a tint/wireframe toggle or a reload reaches every instance at once",
  );
  batches.remove(first);
  equal(batches.stats.instances, 4, "removing a chunk takes its instances out again (its two, of the six added)");
  batches.dispose();
  equal(batches.stats.buckets, 0, "dispose frees every bucket (a world-size change)");

  // 3. THE RESIZE, DRIVEN FOR REAL (its own batcher, so the counts above keep their meaning): overflowing the
  //    instance capacity must grow the batch AND bump the material's version, because that version is the only
  //    thing that makes three.js rebuild the node graph which captured the batch's textures (see the group's
  //    section 1c). A regression here is invisible in this file's other assertions and visible on screen as
  //    "faces flying everywhere", so it is asserted as behaviour rather than as source text.
  const growing = new FarBatches(new THREE.Group());
  const growMaterial = new THREE.MeshBasicMaterial();
  const growSpecs = [{ key: "grow-look", texture: null, color: "#ffffff" }];
  const growGeometry = makeGeometry();
  const grown = growing.add(4, growGeometry, growSpecs, [growMaterial], place);
  assert(grown !== null, "a one-look chunk is batched");
  const grownBatch = grown.instances[0].bucket.batch;
  const versionBefore = growMaterial.version;
  const countBefore = grown.instances[0].bucket.batch.maxInstanceCount;
  equal(countBefore, 512, "…into a bucket that starts at the pre-bought instance capacity");
  // A SECOND MATERIAL, so the resize has to mark a material the bucket is NOT currently drawn with: that is the
  // `G`-toggle report, where the untinted material's render object predated the resize and went stale.
  const otherMaterial = new THREE.MeshBasicMaterial();
  growing.refreshMaterials(() => otherMaterial); // installs it on every bucket (and adds it to the set)
  growing.refreshMaterials(() => growMaterial); // …and puts the first one back, as a `G` toggle would
  const otherVersionBefore = otherMaterial.version;
  for (let i = 0; i < 600; i++) growing.add(4, growGeometry, growSpecs, [growMaterial], place);
  equal(growing.stats.instances, 601, "600 more chunks of that look are all accepted…");
  assert(grown.instances[0].bucket.batch.maxInstanceCount > countBefore, "…the bucket GROWS to hold them…");
  assert(growMaterial.version > versionBefore,
    "…and the growth rebuilds the material in force (the only thing that re-captures the replaced textures)…");
  assert(otherMaterial.version > otherVersionBefore,
    "…AND the other material the bucket has used (three.js keeps one render object per (batch, material) pair)");

  // 4. AND EVERY DRAW MUST DRAW ITS OWN SLICE — the invariant three.js #34211 broke. The offsets are cached in
  //    BYTES at the element size of that moment (`_multiDrawBytesPerElement`), while the WebGPU upload converts a
  //    Uint16 index to Uint32 in place, so the check simulates that conversion and then verifies that the slice
  //    each draw lands in is the slice of the instance the indirect texture names for it. A half offset still lands
  //    on a REAL slice start (half of an even indexStart), so ownership — not alignment — is the test.
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  grownBatch.onBeforeRender(null, null, camera, grownBatch.geometry, grownBatch.material);
  const cachedBytes = grownBatch._multiDrawBytesPerElement;
  const upload = grownBatch.geometry.getIndex();
  if (upload.array instanceof Uint16Array) {
    // EXACTLY what WebGPUAttributeUtils.createAttribute does on first upload (0xffff is the primitive restart).
    const converted = new Uint32Array(upload.array);
    for (let i = 0; i < converted.length; i++) if (converted[i] === 0xffff) converted[i] = 0xffffffff;
    upload.array = converted;
  }
  equal(grownBatch.geometry.getIndex().array.BYTES_PER_ELEMENT, 4,
    "the WebGPU upload really does rewrite the batch's index to Uint32 in place (the trap)…");
  assert(cachedBytes !== 4,
    "…so the offsets must be converted back with the size they were CACHED at, not this one…");
  const indirect = grownBatch._indirectTexture.image.data;
  let ownSlice = 0;
  for (let i = 0; i < grownBatch._multiDrawCount; i++) {
    const element = grownBatch._multiDrawStarts[i] / cachedBytes;
    const instanceId = indirect[i];
    const info = grownBatch._geometryInfo[grownBatch._instanceInfo[instanceId].geometryIndex];
    if (info.indexStart === element) ownSlice++;
  }
  assert(grownBatch._multiDrawCount > 0, "…for a real draw list…");
  equal(ownSlice, grownBatch._multiDrawCount,
    "…and every draw lands in ITS OWN slice's index range (half of it would draw a neighbouring chunk's faces)");
  growing.dispose();
});

check("M3a: the STREAM hands settled far chunks to the batches, and takes them back with the window", () => {
  // The group above proves the batcher; this one proves the STREAM's half of it — and it needs a REAL geometry to
  // do so, which is why it is its own world: every other far-ring group in this file drives a stub (a plain object
  // with `groups`/`specs` and no attributes), and a stub is deliberately NOT batched (`FarBatches.add` returns null
  // for anything it cannot slice, so those groups keep testing exactly what they always did).
  const { ChunkStreamSystem } = load("plugins/render/systems/chunk-stream.js");
  const { CHUNK_SIZE } = load("data/world/chunk.js");
  const { VoxelWorld } = load("data/world/world.js");
  const { lodSampleGrid } = load("data/world/lod.js");
  const THREE = require("three/webgpu");
  const P = loadPresentation();
  const batchWorld = new World();
  batchWorld.insertResource(VOXEL, new VoxelWorld());
  batchWorld.insertResource(LOCAL_PLAYER, localPlayer);
  const batchCache = P.createChunkMeshCache({ add() {}, remove() {} });
  batchWorld.insertResource(P.CHUNK_MESHES, batchCache);
  batchWorld.insertResource(P.CHUNK_MATERIAL, P.createChunkMaterial());
  batchWorld.insertResource(FADE_OPTIONS, createFadeOptions(true, true)); // fades ON: promotion waits for one
  batchWorld.insertResource(KEY_EVENTS, createKeyEventLog());
  const batchFactory = {
    createGeometry: () => {
      const geometry = new THREE.BufferGeometry();
      const quads = CHUNK_SIZE * CHUNK_SIZE;
      geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(quads * 4 * 3), 3));
      geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(quads * 4 * 3), 3));
      geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(quads * 4 * 2), 2));
      geometry.setIndex(new THREE.BufferAttribute(new Uint32Array([0, 1, 2, 0, 2, 3]), 1));
      geometry.addGroup(0, 6, 0); // ONE look (the common far case)
      return {
        geometry,
        specs: [{ key: "probe-look", texture: null, color: "#ffffff" }],
        apply: () => 1,
        rebuild: () => 1,
        restyle: () => 1,
        dispose() {},
      };
    },
    getMaterial: () => new THREE.MeshBasicMaterial(),
  };
  const positionRow = entityIndex(localPlayer);
  const startX = C.POSITION.x[positionRow];
  try {
    // A TINY ladder (2 rungs, reach 2), so the CPU sampler answers instantly and the ring is a few dozen chunks.
    const stream = new ChunkStreamSystem(
      batchWorld,
      batchFactory,
      null,
      { tiers: 2, reach: 2 },
      { gridFor: (step, cx, cz) => lodSampleGrid(step, cx, cz) },
    );
    // A big delta per step: every fade in flight finishes, so a chunk built in this step is promoted by the next.
    for (let i = 0; i < 40; i++) stream.step(1000);
    const stats = stream.batchStats;
    assert(stats.batchedChunks > 0, `settled far chunks end up in batches (${stats.batchedChunks})`);
    assert(stats.instances >= stats.batchedChunks, "…with at least one instance each (one per look)");
    assert(stats.buckets >= 1 && stats.buckets < stats.instances,
      `…in far fewer buckets than instances (${stats.buckets} buckets, ${stats.instances} instances)`);
    // …and every batched chunk's own mesh has LEFT the scene (the batch draws those pixels now).
    const batchedMeshes = [...batchCache.meshes.entries()].filter(([key]) => key.includes(":"));
    assert(batchedMeshes.length > 0, "the far ring has entries at all");
    // MOVING THE WINDOW retires the far chunks that left: they have to come back OUT (their fade-out needs their
    // own mesh, and a batch nobody owns would keep drawing them where they no longer belong).
    const before = stats.instances;
    C.POSITION.x[positionRow] = startX + 4 * CHUNK_SIZE;
    stream.step(1000);
    stream.step(1000);
    assert(stream.batchStats.instances < before,
      `a window move takes the leaving chunks back out of the batches (${before} -> ${stream.batchStats.instances})`);
  } finally {
    C.POSITION.x[positionRow] = startX;
  }
});

// ===== report =====
console.log(`\n=== check-ecs report ===`);
if (failed) {
  console.log(`  [FAIL]  ${passed} passed, at least one failed`);
  console.log("\nRESULT: FAILED");
  process.exit(1);
}
console.log(`  [ok]    ${passed} assertion groups passed`);
console.log("\nRESULT: OK");
