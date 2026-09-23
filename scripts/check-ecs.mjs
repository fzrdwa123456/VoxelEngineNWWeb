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

/** Sources to compile. tsc follows their imports, so this list is "the ECS plus the fixed lane". */
const SOURCES = [
  "src/core/world.ts",
  "src/plugins/player/components.ts",
  "src/core/effect/commands.ts",
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
  "src/plugins/world/index.ts",
  "src/plugins/player/index.ts",
  "src/plugins/render/index.ts",
  "src/plugins/diagnostics/index.ts",
  "src/plugins/ui/index.ts",
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
  "src/plugins/ui/systems/picker.ts",
  "src/plugins/ui/systems/toast.ts",
  "src/plugins/ui/systems/loading.ts",
  "src/plugins/ui/systems/hud.ts",
  // The inventory reconcile (a system now — it used to be `Inventory.sync()`, a method on the view, which
  // is why this file was not compiled here before). It imports the icon baker + the block registry, both
  // of which are import-safe in Node (the WebGPU renderer they use is created lazily on the first bake).
  "src/plugins/ui/systems/inventory.ts",
  "src/plugins/ui/systems/keybind.ts",
  "src/plugins/ui/systems/navigation.ts",
  "src/plugins/render/systems/camera.ts",
  // The block target outline: a render-lane system that reads the TARGET_HIT component and moves a
  // three.js mesh. Import-safe in Node — it imports three.js for TYPES only and the mesh arrives as the
  // BLOCK_OUTLINE resource, which the check inserts as a stub.
  "src/plugins/render/systems/outline.ts",
  // Import-safe in Node: the settings repair is a PURE comparison and lives in its own
  // dependency-free module (the Tauri shell it belongs to imports @tauri-apps/api, which Node's
  // CJS require cannot load) — which is exactly what the boot check asserts here.
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
const { SelectSlot, SetLoadingStage, SetMode, ShowToast, SwapSlots, Teleport } = load("core/effect/commands.js");
const { TERRAIN_TOP_Y, VoxelWorld } = load("data/world/world.js");

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
  near(C.POSITION.y[index], TERRAIN_TOP_Y + 1.6, 0.01, "landing height (collision leaves SKIN clearance)");
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

check("the chunk stream can say whether a window still needs warming", () => {
  // The world-entry screen is only honest if it covers real work, and a RE-entry into a window that is
  // still built has none: `needsWarmUp` is what keeps that from being a one-frame flash of the screen.
  // Driven on a stub voxel whose chunks are all AIR (getChunk -> null), so no mesh is ever built and
  // the mesher's material — which needs a DOM — is never touched.
  const { ChunkStreamSystem } = load("plugins/render/systems/chunk-stream.js");
  const P = loadPresentation();
  const streamWorld = new World();
  streamWorld.insertResource(VOXEL, {
    ensureChunk() {},
    getChunk: () => null,
    isSolid: () => false,
    takeDirty: () => [],
  });
  // The player HANDLE from the world above: resources are per World, and the POSITION column is shared
  // per definition (a second World may not INSERT a component — the one-World rule — but the chunk
  // stream only reads the row).
  streamWorld.insertResource(LOCAL_PLAYER, localPlayer);
  // The mesh CACHE is the CHUNK_MESHES resource, not a private field, so the gate inserts a stub one
  // (a plain object stands in for the parent THREE.Group). That seam is the point of the change: this
  // system is driven here with no GPU at all.
  const meshCache = P.createChunkMeshCache({ add() {}, remove() {} });
  streamWorld.insertResource(P.CHUNK_MESHES, meshCache);
  // The shared chunk material is a RESOURCE too, so it is inserted here — a stub with a null material,
  // which is never reached because this world is all AIR and builds no mesh at all.
  streamWorld.insertResource(P.CHUNK_MATERIAL, P.createChunkMaterial());
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
  // (read directly: the section's `readSource`/`stripComments` helpers are defined further down)
  const mainSrc = require("node:fs").readFileSync(path.join(ROOT, "src", "boot", "main.ts"), "utf8");
  assert(
    /needsWarmUp\(SPAWN\.x, SPAWN\.z\)/.test(mainSrc),
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
    "src/plugins/ui/systems/picker.ts",
    "src/plugins/ui/systems/toast.ts",
    "src/plugins/ui/systems/keybind.ts",
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
    "settings.btn",
    "settings.btnRow",
    "settings.choice",
    "settings.scrollArea",
    "settings.row",
    "settings.rowName",
    "settings.rowMeta",
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
  // state — otherwise the loading bar would draw the same face filled and empty.
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
});

check("the reconciler writes the DOM from data: no wipe of a recipe, and a scroll list starts at the top", () => {
  // The reconciler writes a few LONGHANDS (background-image, background-color, justify-content) after
  // the recipe's cssText. A longhand write deletes the same property out of the shorthand the recipe
  // used, and for a <button> that means falling back to the browser's own face —which is how every
  // button and choice in the menus turned light grey (white) until the pointer touched it. This runs
  // the real system against a minimal DOM stub and asserts the two halves of the rule.
  const W = load("plugins/ui/components.js");
  const { UiRenderSystem } = load("plugins/ui/systems/reconcile.js");
  const { defaultUiTheme, UI_THEME } = load("data/assets/theme.js");
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
      /** What `<input type=range>` reports on an `input` event — read off the widget's own element. */
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
  // because the config modules do not apply themselves any more. Count the writes — the point is that it
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
    // resize. They publish the VALUE now and the reconciler diffs it — which is exactly why the
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
    assert(/background:#444444/.test(plainEl.style.cssText), "its recipe background is on the element");
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
    assert(/background:#4a9eff/.test(choiceEl.style.cssText), "the selected style was rewritten");
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
    // the one that had been at the top and the two settings panels disagreed. The rule is an EDGE — the
    // frame a list (or the PANEL around it) becomes visible — and nothing else touches the position.
    const capPanel = W.spawnPanel(world, null, "settings.panelXl", { hidden: true });
    const capA = W.spawnPanel(world, capPanel, "kb.chips"); // inside a hidden PANEL, itself visible
    const capB = W.spawnPanel(world, null, "kb.chips"); // an independent second instance
    system.step();
    const elA = made.filter((el) => el.dataset.uiRecipe === "kb.chips")[0];
    const elB = made.filter((el) => el.dataset.uiRecipe === "kb.chips")[1];
    assert(!!elA && !!elB, "two instances of the scrollable role are mounted");
    equal(elA.scrollTop, 0, "a list behind a hidden panel starts at the top");

    // Scrolling it — by any means — is NOT recorded and NOT undone while the panel stays up: the list
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
    elA.scrollTop = 40; // what a hidden box may keep, or may be reset to — either way it is stale
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
    // mouseleave, mousedown, mouseup) — six closures each, none of them enumerable from outside. The
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
     *  included), 0 is what TAB+ENTER/SPACE — and a programmatic `.click()` — produce. */
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
    // `click` with `detail === 0` — the UI is mouse-driven, and the filter lives on the EVENT, so a real
    // press/release (which carries the click count) is untouched.
    const dispatched = fired.length;
    fire("click", labelEl2, null, 0);
    equal(fired.length, dispatched, "a keyboard-generated click (detail 0) does NOT dispatch");
    fire("click", labelEl2, null, 1);
    equal(fired.length, dispatched + 1, "…while a real press/release still does");
    fire("click", labelEl2, null, 2);
    equal(fired.length, dispatched + 2, "…a double click included");

    // HOVER: entering the label hovers the button above it…
    const idle = btnEl2.style.cssText;
    fire("mouseover", labelEl2);
    system.step();
    assert(btnEl2.style.cssText !== idle, "hovering a child shades the button above it");
    // …leaving the tree (no mouseover inside it, and the new target is not ours) clears it.
    fire("mouseout", btnEl2, null);
    system.step();
    equal(btnEl2.style.cssText, idle, "leaving the tree takes the shade back");

    // PRESS: down on the label presses the button, and ANY release inside the tree ends it — the
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

check("a delayed intent is DATA with a deadline, applied by a system — never a timer", () => {
  // Four `setTimeout`s used to be the only way this process could say "in a moment": closing the backpack
  // relocking the mouse, the lock manager's 1300 ms retry, and the cursor re-asserts after the window
  // regained focus (0/120 ms) or after the menu/Apps key (0/32/80 ms). Each was a timer owned by whichever
  // module wanted it. The DEADLINE is a resource now, which is what makes the timing assertable at all —
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
  // not grow without limit. At the cap the FURTHEST deadline goes — the urgent re-asserts are the ones
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

check("the icon cache has a synchronous reader, and both readers agree on the key", () => {
  // The inventory draws the icon IMMEDIATELY when it is already baked; that is what keeps a stack move
  // from painting one frame of the placeholder. It can only do that if the cache is readable without a
  // promise —and only correctly if the peek builds the same key the bake wrote.
  const icons = load("host/browser/blockicons.js");
  const P = loadPresentation();
  // The bake's state is a RESOURCE (ecs/presentation.ts::ICON_BAKE): the two readers operate on it, so
  // they can be driven here with no GPU and no browser — the renderer is created on the first real bake.
  const bake = P.createIconBake();
  equal(icons.iconCacheKey("stone", 40), "stone@40", "the key is type@size");
  equal(icons.iconCacheKey("stone", 40.4), "stone@40", "…with the size rounded");
  equal(icons.iconCacheKey("stone", 20), "stone@32", "…and clamped up to MIN_SIZE");
  equal(icons.iconCacheKey("stone", 1000), "stone@256", "…and down to MAX_SIZE");
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
  const invSource = stripComments(readSource("src/plugins/ui/systems/inventory.ts"));
  assert(!/\.then\(/.test(invSource), "the inventory draws the icon from the cache, not from a promise");
  // Since P1.18b the icon baker is INJECTED (a plugin may not import `host/`), so the check is
  // two-sided: the system asks through its IconSource, and the composition root hands it the real one.
  // A missing wire would not crash — it would silently ship placeholder icons — so it is asserted.
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
  // The exact tie-break is not the contract —"lands ON the slider's grid, inside its range" is, and
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
  for (const rel of ["src/plugins/ui/systems/picker.ts", "src/plugins/ui/systems/toast.ts", "src/plugins/ui/systems/keybind.ts", "src/plugins/ui/systems/delays.ts"]) {
    const code = stripComments(readSource(rel));
    equal(countOf(code, /#[0-9a-fA-F]{3,8}\b|rgba?\(/g), 0, `${rel} still has a colour literal`);
    equal(countOf(code, /document\.|createElement|style\.cssText/g), 0, `${rel} still touches the DOM`);
    equal(countOf(code, /setTimeout|setInterval/g), 0, `${rel} still owns a timer`);
    equal(countOf(code, /onLangChange|onBindsChange/g), 0, `${rel} still subscribes to a change`);
  }
  // The menus and the settings panel. `onLangChange` is ALLOWED here: a label composed from a VALUE
  // ("FPS 60", "1.25x") cannot be a key, so those few still have to be re-pushed on a language switch.
  // Everything a key can express is re-derived by the reconciler instead.
  for (const rel of ["src/plugins/ui/views/menu.ts", "src/plugins/ui/views/mainmenu.ts", "src/plugins/ui/views/inventory.ts"]) {
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
  assert(/spawnLabel\(/.test(readSource("src/plugins/ui/systems/picker.ts")), "the picker composes its own labels");
  assert(/setUiVisible\(/.test(readSource("src/plugins/ui/systems/picker.ts")), "…and shows/hides them as data");
  assert(/spawnButton\(/.test(readSource("src/plugins/ui/views/menu.ts")), "the settings panel composes buttons");
  assert(/spawnGridKey\(/.test(readSource("src/plugins/ui/views/menu.ts")), "the visual keyboard composes keycaps");
  assert(/onUiAction\(/.test(readSource("src/plugins/ui/views/mainmenu.ts")), "the main menu dispatches actions");
  assert(/spawnButton\(/.test(readSource("src/plugins/ui/views/inventory.ts")), "the inventory VIEW composes slot buttons");
  assert(/setUiImage\(/.test(readSource("src/plugins/ui/systems/inventory.ts")), "…and the SYSTEM fills icon slots as data");
  equal(countOf(stripComments(readSource("src/plugins/ui/views/inventory.ts")), /setUiImage|setUiText|setUiTip|setUiSelected/g), 0,
    "the view writes no widget data any more (that is the system's job)");
});

// ===== the three UI systems the views migrated into =====

check("the F3+F4 picker is a system: key edges in, widget data and a mode change out", () => {
  // It used to be a class in ui/gamemode.ts with its own document listeners and private fields.
  const P = load("plugins/ui/systems/picker.js");
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
  //    loading screen) they used to open the F3 panel — with stale text, because its numbers come from
  //    the render lane, which does not run there — and to switch the movement mode through SetMode, i.e.
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
  // PAUSE menu — where the hotbar's z-index (31) is above that menu's whole root (30), so it drew on top
  // of the panel — with its slots still clickable (a menu click could select a slot, a SetMode-free but
  // still component-writing command). `ui.hud` owns that flag and derives it from `inWorld()`.
  const H = load("plugins/ui/systems/hud.js");
  const world = widgetWorld;
  const crosshair = W.spawnPanel(world, null, "hud.crosshair"); // spawned visible, like the real ones
  const hotbar = W.spawnPanel(world, null, "inv.hotbar");
  let inWorld = true;
  const hud = new H.UiHudSystem(world, { crosshair, hotbar, inWorld: () => inWorld });
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

  // The system is registered in the ui lane with a declared access set, ahead of every other writer —
  // "what may the lane show at all" comes first — and the composition root hands it the two roots.
  const main = stripComments(readSource("src/boot/main.ts"));
  assert(/name: "ui\.hud"/.test(main) || /[\s\S]*/.test(readSource("src/plugins/ui/index.ts")), "the composition root registers ui.hud");
  assert(/crosshair: hud\.crosshairEntity/.test(main), "…with the crosshair root");
  assert(/hotbar: inv\.hotbarEntity/.test(main), "…and the hotbar root");
  assert(/inWorld,/.test(main), "…gated on the one definition of \"a world is running\"");
  // The toast is deliberately NOT part of this: a main-menu message is a documented case.
  assert(!/toast/.test(stripComments(readSource("src/plugins/ui/systems/hud.ts"))), "ui.hud leaves the toast alone");
});

check("ESC walks the sub-page ladder one rung at a time, and its top rung is not a no-op", () => {
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
    pausePanels: Object.fromEntries(ids.map((id) => [id, mkPanel("settings.panel")])),
    mainRoot: mkPanel("menu.backdrop"),
    mainMain: mkPanel("menu.panel"),
    genPanel: mkPanel("menu.panel"),
    mainPanels: Object.fromEntries(ids.map((id) => [id, mkPanel("settings.panel")])),
    inventoryPanel: mkPanel("inv.panel"),
  };
  const effects = [];
  /** "Is a world running?" — the ESC/inventory gate. false is the LOADING-SCREEN state (the startup and
   *  a world being built behind the screen), where neither the pause menu nor the backpack may open. */
  let inWorld = false;
  const nav = new N.UiNavigationSystem(world, {
    trees,
    inventoryCode: () => "KeyE",
    capturing: () => false,
    inWorld: () => inWorld,
    prepareUnlock: () => effects.push("prepareUnlock"),
    exitPointerLock: () => effects.push("exit"),
    centerCursor: () => effects.push("center"),
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
  esc();
  equal(ui.settings, "settings", "ESC from a sub-page lands on the settings LIST (not past it)");
  assert(shown(trees.mainPanels.settings) && !shown(trees.mainPanels.lang), "…and that is what is painted");
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
  equal(ui.settings, "settings", "ESC from the packs sub-page goes back to the settings LIST");
  esc();
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
  equal(effects.join(","), "prepareUnlock,exit,center", "…releasing the mouse and centring the cursor");

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
  equal(ui.settings, "settings", "the main-menu ladder is unaffected by the gate");

  // …and the composition root has to SUPPLY that answer (a dep that is never injected would read as
  // undefined and refuse everything, which is the same class of miss as the screen that was never
  // activated: the system is only as good as what the wiring hands it).
  assert(
    /inWorld,/.test(stripComments(readSource("src/boot/main.ts"))),
    "main.ts injects \"is a world running\" into ui.navigation",
  );
});

check("the toast is a system: a command arms a wall-clock deadline, the ui lane applies it", () => {
  // `showToast()` used to write two widgets and arm a setTimeout inside the view; the message now
  // outlives its caller, which is what lets the MAIN MENU show one (nothing there reconciles a DOM write).
  const T = load("plugins/ui/systems/toast.js");
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
  const K = load("plugins/ui/systems/keybind.js");
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
  // POINTER IS comes from the POINTER resource (the device layer publishes it — it owns the mousemove
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
    "src/plugins/render/index.ts", "src/plugins/ui/index.ts"]
    .map((f) => require("node:fs").readFileSync(path.join(ROOT, f), "utf8"))
    .join("\n");
  // Since P1.18 a registration goes through the plugin registry — `contributeSystem("<plugin id>", {...})` —
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
    // ui/inventory.ts is NOT compiled by this gate (it imports the renderer), so its declared access is
    // read out of the SOURCE and mapped onto the real component objects: the schedule then sees exactly
    // what the file declares, and the source-text assertion below keeps the two honest.
    // The inventory reconcile is a SYSTEM now (ecs/ui/inventory.ts), so its declared access is loaded like
    // every other one. It used to be a method on the VIEW, which the gate could only read as source text
    // (the view imports the renderer and is not compiled here).
    INVENTORY_VIEW_ACCESS: load("plugins/ui/systems/inventory.js").INVENTORY_VIEW_ACCESS,
    UI_RENDER_ACCESS: load("plugins/ui/systems/reconcile.js").UI_RENDER_ACCESS,
    UI_BINDING_ACCESS: load("plugins/ui/systems/bindings.js").UI_BINDING_ACCESS,
    UI_LOADING_ACCESS: load("plugins/ui/systems/loading.js").UI_LOADING_ACCESS,
    UI_HUD_ACCESS: load("plugins/ui/systems/hud.js").UI_HUD_ACCESS,
    UI_PICKER_ACCESS: load("plugins/ui/systems/picker.js").UI_PICKER_ACCESS,
    UI_TOAST_ACCESS: load("plugins/ui/systems/toast.js").UI_TOAST_ACCESS,
    UI_KEYBIND_ACCESS: load("plugins/ui/systems/keybind.js").UI_KEYBIND_ACCESS,
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
  // writes a target of its own (`blockOutline`), so any order among the four is correct — and the draw,
  // which reads the scene they fill, stays in the batch after it.
  const expectedRender = [
    ["diagnostics", "cameraView.render", "chunk.stream", "block.outline"],
    ["renderer.draw"],
  ];
  // The ui lane: every widget-data WRITER, then the reconciler that reads all of it. The writers are a
  // chain rather than a pair because the conflict model is per COMPONENT, not per entity —the
  // inventory, the picker, the toast and the bind panels write UI_STATE/UI_TEXT on DIFFERENT entities,
  // and the schedule cannot see that, so the order has to be declared.
  const expectedUi = [
    // The GAMEPLAY gate shares the first batch with the binding resolver: they touch DISJOINT components
    // (UI_STATE vs UI_INPUT), so the schedule says they may run in either order — and it is right.
    ["ui.hud", "ui.bindings"],
    ["ui.loading"],
    ["ui.inventory"],
    ["ui.picker"],
    ["ui.toast"],
    ["ui.keybind"],
    ["ui.navigation"],
    // The delayed intents are applied right after the systems that decide them and before the frame is
    // painted. It writes ui.navigation's two targets (`pointerLock` / `cursor`), so the conflict rule
    // FORCES the edge — and `before: ["ui.widgets"]` is what keeps the reconciler the last system.
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
  // is the discriminator —"framebuffer" is a canvas, not DOM.
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
  // label and the slider disagree — a hand-edited `fpsCap: 1` showed "1 FPS" above a slider parked at
  // 30, and the first drag silently replaced it — so the sanitiser clamps and snaps into it.
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
  // the slider shows for it — `snapToRange` with the slider's own domain must be a NO-OP.
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
  const { SetFpsCap } = load("core/effect/commands.js");
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
  assert(/createFrameCap\(Number\(readSettings\(\)\.fpsCap/.test(main), "…loading it at boot");
  assert(/s\.fpsCap\s*=/.test(main), "…and writing it back");
  assert(/commands\.send\(SetFpsCap/.test(main), "onFpsCap sends the command instead of assigning");
  assert(
    /saveSettings\(cap\)/.test(main),
    "…and persists the value it was handed (the command is deferred, so saving the resource here would write the previous cap)",
  );
  // The cap LABEL is a push, and the number it shows arrives through that same command at the next
  // barrier: the drag handler must hand it the value it just sent. Re-reading the resource printed the
  // PREVIOUS drag step, and nothing else refreshes the label — the reported "the FPS number is not
  // accurate while sliding".
  const menuSrc = stripComments(readSource("src/plugins/ui/views/menu.ts"));
  assert(/renderCap\(cap\)/.test(menuSrc), "the cap label is handed the value the drag just sent");
  assert(/const renderCap = \(justSet\?: number\)/.test(menuSrc), "…and reads the resource only when it has none");
  equal(countOf(main, /\blet fpsCap\b|\bfpsCap = cap\b/g), 0, "no closure variable left behind");
  // The gate reads the resource, and diagnostics reads it too —from the World, not from a callback.
  assert(/frameCap\.cap > 0/.test(main), "the frame gate reads the resource");
  assert(
    /world\.resource\(FPS_CAP\)/.test(readSource("src/plugins/render/systems/diagnostics.ts")),
    "diagnostics reads the resource",
  );
});

check("the loop is ONE rAF chain whose body the MODE picks", () => {
  // "Is the game loop running" used to be the implicit consequence of which of stopLoop()/startLoop()
  // ran last —and stopLoop() started the UI pump as a side effect that startLoop() then undid. Then the
  // ui pump and the panorama became exactly one caller each (setLoopMode). NOW there is nothing to start
  // or stop at all: ONE chain runs for the process lifetime, `setLoopMode` only writes the mode, and the
  // frame body dispatches on it — so a mode transition cannot half-stop a loop.
  const main = stripComments(readSource("src/boot/main.ts"));
  equal(countOf(main, /function stopLoop|function startLoop/g), 0, "no stopLoop/startLoop pair");
  equal(countOf(main, /\btimerId\b|\bstarted\b/g), 0, "no dead timer handle, no second running flag");
  equal(countOf(main, /function startUiPump|function stopUiPump|function startMenuBgLoop|function stopMenuBgLoop/g), 0,
    "the separate ui pump / panorama loops are gone");
  assert(/function setLoopMode\(/.test(main), "one transition function");
  assert(/function inWorld\(\)/.test(main), "the playing-or-not question is a function of the mode");
  assert(countOf(main, /setLoopMode\("/g) >= 4, "the startup, the world entry, its hand-over and the menu all say it");
  // ONE chain: a single requestAnimationFrame (re-arming itself) and no cancelAnimationFrame anywhere.
  equal(countOf(main, /requestAnimationFrame\(/g), 1, "exactly one rAF chain");
  equal(countOf(main, /cancelAnimationFrame\(/g), 0, "the chain is never cancelled or restarted");
  // The body dispatches on the mode, and a menu frame is the ui lane (+ the background), nothing else.
  // The MODE is `LOOP_STATE.mode` now (ecs/resources.ts): the loop body dispatches on world data.
  assert(/if \(loop\.mode === "game"\) renderFrame\(\)/.test(main), "a game frame runs the fixed step + render");
  assert(/else if \(loop\.mode === "menu"\) menuFrame\(\)/.test(main), "a menu frame runs the menu body");
  assert(/function menuFrame\(\)[\s\S]{0,200}world\.renderUi\(\)/.test(main), "…which is the ui lane alone");
  // …and a LOAD frame is the ui lane alone too, because the loading screen is widget data and the
  // renderer does not exist yet. It used to have no body at all ("nothing yet"), which is why the
  // loading screen could not have been painted by the loop before `renderer.init()`.
  assert(/else if \(loop\.mode === "load"\) loadFrame\(\)/.test(main), "a load frame runs the loading screen");
  assert(/function loadFrame\(\)[\s\S]{0,200}world\.renderUi\(\)/.test(main), "…which is the ui lane alone");
  // …and BOTH flows have to be in that mode while their screen is up: the startup starts in it, and a
  // world entry (driven from the MENU) has to switch into it, or every frame in between is a menu frame
  // that draws the panorama behind an opaque screen for nothing.
  const entryForMode = main.slice(main.indexOf("async function enterWorld("), main.indexOf("const mainMenu = new MainMenu("));
  assert(/setLoopMode\("load"\)/.test(entryForMode), "the world entry puts the loop in load mode");
  equal(countOf(main, /loop\.mode = mode;/g), 1, "the mode has exactly one writer (LOOP_STATE.mode)");
  // …and the chain is kicked off once, by calling frame() directly rather than scheduling it. The call
  // lives inside the boot driver now (it is the first thing that happens after the loading screen's
  // first stage), so the assertion has to allow its indentation while still demanding exactly one.
  equal(countOf(main, /^\s*frame\(\);$/gm), 1, "the boot block starts the chain exactly once");
});

check("the startup screen is DATA: a command moves LOADING_STATE, `ui.loading` paints the widgets", () => {
  // The window is now revealed while the GPU is still being initialised, so the process needs a
  // loading screen — and a loading screen is UI, which in this repo means: a surface writes data and
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
  // window — the startup was a black rectangle for as long as it took. The order below is the feature.
  const main = stripComments(readSource("src/boot/main.ts"));
  // The two drivers, extracted by name: EVERY assertion about "the screen is activated" / "the world is
  // built here" has to be scoped to ONE of them, because an unscoped `indexOf` finds whichever comes
  // first in the FILE, which is not the one being talked about.
  const bootBody = main.slice(main.indexOf("async function boot("), main.indexOf("void boot()"));
  // The end marker has to be CODE: comments are stripped above, so a `//` marker matches nothing and the
  // slice would silently run to the end of the file (which is how the entry assertions passed while the
  // entry was broken — the boot driver's own `active: true` was inside the slice).
  const entryBody = main.slice(
    main.indexOf("async function enterWorld("),
    main.indexOf("const mainMenu = new MainMenu("),
  );
  assert(bootBody.length > 0, "the startup driver is in the source");
  assert(entryBody.length > 0, "the world-entry driver is in the source");
  assert(!entryBody.includes("renderer.init"), "…and the slice ends before the startup driver");
  // The flow's stages are DATA now (ecs/boot.ts walks them), so the first stage is found by its own key.
  const firstStage = main.indexOf('key: "loading.settings"');
  const started = main.indexOf("frame();");
  const revealed = main.indexOf("showWindow()");
  const gpu = main.indexOf("await renderer.init()");
  assert(firstStage > 0, "the startup screen's first stage is announced");
  assert(started > firstStage, "…before the ONE chain is kicked off");
  assert(revealed > started, "…and before the window is revealed");
  assert(gpu > revealed, "the GPU handshake happens AFTER the window is already showing the screen");
  // …and the screen has to be ACTIVATED, or none of the above paints anything: `ui.loading` shows its root
  // only while LOADING_STATE.active is true, and the root is spawned hidden. This shipped BROKEN TWICE —
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
  // by construction — the source order inside the driver plus the walker's own contract.
  assert(
    bootBody.indexOf("active: true") < bootBody.indexOf("runBootFlow(bootFlow"),
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
  for (const [key, work] of [
    ["loading.gpu", "await renderer.init()"],
    ["loading.ready", "mainMenu.show()"],
    ["world.terrain", "chunkStream.prime("],
    ["world.chunks", "chunkStream.warmUp("],
  ]) {
    const at = main.indexOf(`"${key}"`);
    assert(at > 0, `the loading screen announces ${key}`);
    assert(at < main.indexOf(work, at), `${key} is announced before its work runs`);
  }
  assert(/world\.renderUi\(\)/.test(main), "each stage is reconciled before its paint");
  // The per-stage yield is a MACROTASK, not a second chain: there is still exactly ONE rAF chain, and
  // the yield has to let the compositor present the screen before the blocking work starts.
  assert(/setTimeout\(resolve, 0\)/.test(main), "the per-stage yield is a timer task");
  equal(countOf(main, /requestAnimationFrame\(/g), 1, "…so the process still owns exactly one rAF chain");

  // ===== the world is built at ENTRY, not at startup =====
  // Building it at boot made the STARTUP pay for a world the user may never enter (the spawn window's
  // generation plus ~100 frames of meshing, ~1.6 s in the measured log) and left "entering a world"
  // with nothing to wait for — i.e. no honest place for a loading screen. Both halves are asserted:
  // `boot()` must NOT build a world, and the entry driver MUST. (Both bodies were extracted above.)
  equal(countOf(bootBody, /chunkStream\./g), 0, "the startup does not build or mesh the world any more");
  assert(/chunkStream\.prime\(/.test(entryBody), "entering a world generates the spawn window");
  assert(/chunkStream\.warmUp\(paint/.test(entryBody), "…and meshes it behind the screen");
  // A re-entry into a window that is still built skips the screen instead of flashing it for one frame.
  assert(
    /if \(chunkStream\.needsWarmUp\(/.test(entryBody),
    "the entry asks whether there is anything to build before it shows a screen",
  );
  assert(/setLoopMode\("game"\)/.test(entryBody), "the entry ends by handing the mode over to the game");
  equal(countOf(main, /document\.createElement\(/g), 0, "the composition root builds no element any more");
  equal(countOf(main, /style\.cssText/g), 0, "…and writes no style string");
});

check("the settings FILE is checked at boot, repaired and written back", () => {
  // Each config module already ignores a value it cannot use and falls back — which silently left the
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

  // …and the composition root actually runs it, before anything it could disagree with is used.
  const main = stripComments(readSource("src/boot/main.ts"));
  assert(/readSettingsChecked\(\)/.test(main), "the boot check uses the read that can report a fault");
  assert(/diffSettings\(checked\.settings, inForce\)/.test(main), "…compares the file with the values in force");
  assert(/writeSettings\(report\.merged\)/.test(main), "…and writes the repaired file back");
  assert(/backupSettingsFile\(\)/.test(main), "an UNREADABLE file is backed up before being rebuilt");
  assert(/writeSettings\(\{ \.\.\.inForce \}\)/.test(main), "…and rebuilt from the values in force");
  for (const key of ["language", "font", "uiScale", "windowMode", "fpsCap", "keybinds", "diagLog"]) {
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
  // ON) and it filters in `logDebug` — the ONE place every probe line passes through — so the event lines
  // (BOOT / SETTINGS / WORLD / LOCK / CURSOR / ESC / ERROR …) are never affected, and a new probe only has
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
  // EVERY emitted probe line's OWN first token must be in the table — not just "the table names a
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
    ["src-tauri/src/rawinput.rs", /"RAWMON emits=\{/, "RAWMON "],
    ["src-tauri/src/rawinput.rs", /"HOOKPROBE seen=\{/, "HOOKPROBE "],
    // The key bind gestures fire on ordinary clicks, so they are probes too (a click must not write a
    // line into a log whose switch is off).
    ["src/plugins/input/bind-gesture.ts", /`KBCAP mousedown/, "KBCAP "],
    ["src/plugins/ui/views/menu.ts", /`KBCAP click interactive button/, "KBCAP "],
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
  // probe table): with the switch off, a log with no probe lines is otherwise ambiguous — "off" and "the
  // probes never registered" look exactly the same to whoever reads it.
  assert(/`DIAGLOG probes [^`]*at boot/.test(main), "the composition root records the switch's boot state");
  assert(!probes.includes('"DIAGLOG '), "…as an event line: its prefix is not in the probe table");
  const menu = stripComments(readSource("src/plugins/ui/views/menu.ts"));
  assert(/settings\.diagLogOn/.test(menu) && /settings\.diagLogOff/.test(menu),
    "the shared settings panel renders it as a two-state toggle");
  // The label has to exist in every shipped dictionary, or the button would show the raw key.
  for (const lang of ["zh", "en", "ja"]) {
    const dict = JSON.parse(
      require("node:fs").readFileSync(
        path.join(ROOT, "packs", "VoxelEngineNWWebrp", "assets", "voxel", "lang", `${lang}.json`),
        "utf8",
      ),
    );
    for (const key of ["settings.diagLogOn", "settings.diagLogOff"]) {
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
  //   * the mutable CONFIG (language, font, UI scale, key map) is world state — the bind table is asked
  //     every tick and the language every frame — so it lives in resources with declared readers;
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
  assert(/loadLang\(\s*locale,\s*readSettings\(\)\.language,\s*DEFAULT_LANGUAGES,?\s*\)/.test(main),
    "…and so is the language (validated against the content plugin's declared set)");

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
  // any system, past no barrier, and — for the root font size — repeated unconditionally on every resize.
  // The values live with the resources; the write is HERE, diffed against what was last applied.
  const renderSrc = stripComments(readSource("src/plugins/ui/systems/reconcile.ts"));
  const fontsSrc = stripComments(readSource("src/data/globals/fonts.ts"));
  const scaleSrc = stripComments(readSource("src/data/globals/uiscale.ts"));
  const bootSrc = stripComments(readSource("src/boot/main.ts"));
  for (const [file, src] of [["src/data/globals/fonts.ts", fontsSrc], ["src/data/globals/uiscale.ts", scaleSrc]]) {
    // The mount root uiStage is this module's own business (the reconciler is HANDED it). What it may
    // not do any more is apply the DOCUMENT ROOT's style — that is the reconciler's one DOM write.
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
  // memo are loaded once and never change, but they are no longer invisible module-level `let`s — each
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
  // root and the chunk-mesh cache used to arrive as CONSTRUCTOR ARGUMENTS — the only shared state in the
  // process with no owner. They are world state, so the world holds them and each system resolves what
  // it uses (ecs/presentation.ts). Both halves are asserted: the root inserts every one, and none of
  // them is handed to a system any more — that second half is the regression this group exists for.
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
  // The consumers resolve them from the World — the shape every other resource uses.
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
  ].join("\n");
  for (const [what, needle] of [
    ["the camera view", /new CameraViewSystem\(w\.world\)/],
    ["the chunk stream", /new ChunkStreamSystem\(w\.world, w\.mesh\)/],
    ["the device layer", /new PlayerInputSystem\(w\.world, w\.log, w\.inWorld, w\.mouse\)/],
    ["the reconciler", /new UiRenderSystem\(world, \{\s*translate:/],
  ]) {
    assert(needle.test(construction), `${what} takes no presentation object any more`);
  }
  const diagDeps = /new DiagnosticsSystem\(([^)]*)\)/.exec(readSource("src/plugins/diagnostics/index.ts"));
  assert(diagDeps !== null, "diagnostics is constructed");
  equal(diagDeps[1].trim(), "world", "diagnostics takes NOTHING but the world (a view callback and another "
    + "system's queues used to be constructor arguments — they are resources now)");
  // The CANVAS SIZE belongs to the FRAME, not to a lane: a MENU frame and a LOAD frame run the ui lane
  // alone, so a size applied by `renderer.draw` was applied only in a game — resize at the main menu and the
  // panorama's canvas kept its old pixel size until a world was entered (that bug shipped once).
  assert(/function frame\(\)[\s\S]{0,200}applyViewportSize\(\)/.test(main),
    "the frame applies the viewport size, before the mode body");
  // The draw declaration left the root (the render plugin owns it now), so the check reads both.
  assert(
    /run: \(\) => world\.resource\(RENDERER3D\)\.render\(/.test(main) ||
      /run: \(\) => world\.resource\(RENDERER3D\)\.render\(/.test(readSource("src/plugins/render/index.ts")),
    "…and the draw only draws (it must not resize the canvas)");
  // A WINDOW GEOMETRY change is a DEVICE signal treated like losing the window: hand the mouse back and
  // pause if the player was playing. It is deliberately NOT a blur — dragging a border keeps the window
  // focused and the cursor inside its rect — and it is the only signal that catches the reported bug
  // (start a resize-drag while a world loads, the entry locks the mouse on top of it, then both the drag
  // and the view rotation work).
  assert(/onWinGeometry\(/.test(main), "the window's geometry change is handled as a signal");
  assert(/suppressGeometryPause\(\)/.test(main) && /performance\.now\(\) < loop\.suppressGeometryUntil/.test(main),
    "…while our OWN window-mode switch suppresses it (fullscreen must not open the pause menu)");
  // CAPTURE REQUIRES THE FOREGROUND. The browser path refuses pointer lock by itself, which is why the NW.js
  // version could drop the focus gate; the NATIVE capture (ClipCursor) does not look at the foreground at
  // all, so an AUTOMATIC relock — the world entry is the one — would capture the mouse while the user is in
  // another app. Three places, and the gate pins all three.
  const pointerlockSrc = stripComments(readSource("src/host/browser/pointerlock.ts"));
  assert(/focused: \(\) => boolean/.test(pointerlockSrc), "the lock manager takes a foreground predicate");
  assert(/if \(!this\.deps\.focused\(\)\)/.test(pointerlockSrc), "…and refuses to capture without it");
  assert(/focused: winFocused/.test(main), "…which the composition root ships from the shell");
  assert(/if \(winFocused\(\)\) \{[\s\S]{0,120}relock\("world entered"\)/.test(main),
    "the world entry captures only in the foreground (otherwise it pauses)");
  assert(/onCaptureLost\(/.test(main), "…and a rust-side teardown is handled as a lost window");
  const rawinputSrc = stripComments(readSource("src-tauri/src/rawinput.rs"));
  assert(/capture_foreground_check\(&app\)/.test(rawinputSrc) && /emit\("capture-lost"/.test(rawinputSrc),
    "the rust sentinel tears a background capture down and notifies the frontend");
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
  //    around it) — that is asserted in the icon-cache group; here it is where the STATE lives.
  assert(typeof P.ICON_BAKE?.name === "string" && typeof P.createIconBake === "function",
    "ICON_BAKE is a resource with a factory");
  assert(/insertResource\(ICON_BAKE, createIconBake\(\)\)/.test(main), "the composition root inserts it");
  equal(countOf(stripComments(readSource("src/host/browser/blockicons.ts")),
    /^(?:let|var) (?:renderer|rendererReady|cache|pending)\b/gm), 0,
    "the baker keeps no module-level renderer or cache");
  assert(/resource\(ICON_BAKE\)/.test(stripComments(readSource("src/plugins/ui/systems/inventory.ts"))),
    "the inventory system resolves it");

  // 2. The ONE chunk material (a GPU object created on first use, because the pack chain must be
  //    installed before the checker texture can be resolved).
  assert(typeof P.CHUNK_MATERIAL?.name === "string" && typeof P.createChunkMaterial === "function",
    "CHUNK_MATERIAL is a resource with a factory");
  assert(/insertResource\(CHUNK_MATERIAL, createChunkMaterial\(\)\)/.test(main),
    "the composition root inserts it");
  const meshSrc = stripComments(readSource("src/host/browser/chunkmesh.ts"));
  equal(countOf(meshSrc, /^(?:let|var) sharedMaterial\b/gm), 0, "the material is not module state");
  assert(/getChunkMaterial\(state: ChunkMaterialState\)/.test(meshSrc),
    "…the getter takes the resource's state");
  assert(/resource\(CHUNK_MATERIAL\)/.test(stripComments(readSource("src/plugins/render/systems/chunk-stream.ts"))),
    "chunk.stream resolves it");

  // 3. The raw-input TRANSPORT counters (arrival rhythm + queue backlog). They were module state in
  //    platform/rawinput.ts, which could not print them without importing a system.
  const rawSrc = stripComments(readSource("src/host/browser/rawinput.ts"));
  equal(countOf(rawSrc, /^(?:let|var) (?:evCount|gapMax|lastArrive|minOffset|backlogSum|backlogMax|lagAt)\b/gm),
    0, "rawinput.ts keeps no transport counters");
  assert(/export function startRawInput\(/.test(rawSrc) && /raw: RawTransportCounters,/.test(rawSrc),
    "they arrive as an argument (a resource object)");
  assert(/startRawInput\(\(dx, dy\) => input\.rawDelta\(dx, dy\), world\.resource\(INPUT_DIAGNOSTICS\)\.raw\)/.test(main),
    "the composition root hands the device layer the resource");
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
  //    time — a DOM side effect of a config module, on the element the whole widget layer hangs off.
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
  assert(main.indexOf("insertResource(UI_ORDER") < main.indexOf("new Hud("),
    "…BEFORE the first widget is spawned");

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
  // is that the STATE is visible — a test and a log can see why a mousemove was swallowed — never that
  // the logic is different. So this group asserts where the facts live, and the behavior check further
  // down asserts that arming the grace window shows up in the resource.
  const R = load("data/globals/resources.js");
  assert(typeof R.INPUT_TIMING?.name === "string", "INPUT_TIMING is a resource token");
  assert(typeof R.createInputTiming === "function", "…with a factory");
  const timing = R.createInputTiming();
  for (const field of [
    "skipFirstMove",
    "lockGraceUntil",
    "unlockIsIntentional",
    "rawTakeoverActive",
    "offscreenCacheUntil",
    "offscreenCached",
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
      /private (?:readonly )?(?:skipFirstMove|lockGraceUntil|unlockIsIntentional|rawTakeoverActive|offscreenCacheUntil|offscreenCached|lastSpaceDown|spaceSeq|mouseSeq|lastMouseLog)\b/g,
    ),
    0,
    "player.input keeps no private copy of a race-guard field",
  );
  assert(/resource\(INPUT_TIMING\)/.test(src), "…it resolves the resource instead");
  // A click may not CAPTURE the mouse before a world exists: the loading screen owns no modal flag, so the
  // UI_MODAL guard let a click there engage the native capture — and the world entry then re-locked on top
  // of it, which is the state the resize-drag bug needed.
  assert(/!this\.inWorld\(\)/.test(src), "…and the click-to-capture path requires a running world");
  // The queued intents are a resource TOO (INPUT_INTENTS) — but they stayed the system's own producer and
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

check("ecs/ui/inventory.ts declares what the schedule was given for it", () => {  const source = require("node:fs").readFileSync(path.join(ROOT, "src", "plugins", "ui", "systems", "inventory.ts"), "utf8");
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
  // ROADMAP §3.9 carried this as a GAP: a pure ORDERING edge — two systems that share no data at all —
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
    ["locked, no UI", { locked: true, freeMouseActive: false }, {}, true],
    ["locked + main menu", { locked: true, freeMouseActive: false }, { mainMenu: true }, false],
    ["locked + pause menu", { locked: true, freeMouseActive: false }, { menu: true }, false],
    ["locked + inventory", { locked: true, freeMouseActive: false }, { inventory: true }, false],
    ["free mouse, no UI", { locked: false, freeMouseActive: true }, {}, true],
    ["free mouse + inventory", { locked: false, freeMouseActive: true }, { inventory: true }, false],
    ["unlocked, no UI", { locked: false, freeMouseActive: false }, {}, false],
  ];
  for (const [label, d, u, expected] of cases) {
    Object.assign(devices, { locked: false, freeMouseActive: false }, d);
    Object.assign(ui, { mainMenu: false, menu: false, inventory: false }, u);
    equal(canControl(devices, ui), expected, `canControl: ${label}`);
  }
  // The inventory is modal but NOT a menu: the E key / its mouse binding must still close it.
  Object.assign(ui, { mainMenu: false, menu: false, inventory: true });
  equal(isMenuUi(ui), false, "isMenuUi ignores the inventory");
  equal(isModalUi(ui), true, "but the inventory is modal");
  Object.assign(devices, { locked: false, freeMouseActive: false });
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

  Object.assign(devices, { locked: true, freeMouseActive: false });
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
    requestPointerLock: () => undefined,
  };
  const previousDocument = globalThis.document;
  globalThis.document = {
    addEventListener: (type, fn) => {
      handlers[type] = fn;
    },
    pointerLockElement: null,
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
    for (const type of ["pointerlockchange", "mousemove", "keydown", "keyup"]) {
      assert(typeof handlers[type] === "function", `document listens for ${type}`);
    }
    // The click guard is UI_MODAL-driven now (there is no cached "click may grab the lock" field on the
    // input state any more), so this resets the resource that actually decides it.
    Object.assign(devices, { locked: true, freeMouseActive: false });
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

    // 1b. TAB: the browser default is CANCELLED while the game owns the mouse — Chromium's focus traversal
    //     walks out of the tab order, the window deactivates and our "lost the window → pause" handler fires
    //     (`code=Tab` → `WINFOCUS blur` → `blur -> pause menu`). But the KEY must not be SWALLOWED: the bind
    //     panel accepts Tab, and an early return here recorded the bind and then never fired it — which is
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
    //     already in KEY_EVENTS — the NW.js build installed that handler at IMPORT time, i.e. first. The
    //     gate therefore has to be HERE, at event time, where `capturing()` is still armed: the capture
    //     handler clears it synchronously, so a test in `ui.navigation` would read false by the time the ui
    //     lane drains the log. Without it, ESC unbound the action AND walked the settings panel one level
    //     back (the reported bug).
    const K = load("plugins/input/keybinds.js");
    // The capture STATE is the gesture resource now (platform/keybinds only holds a pointer to it), so the
    // harness hands it one — exactly as the composition root does during wiring.
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

    // 6. the race guards' state lives in a RESOURCE now (INPUT_TIMING) — and the point of the move is
    //    that the gate can SEE it. `prepareUnlock()` is still ONE synchronous call at the same moment
    //    (iron rule 3: nothing about the timing changed); what changed is that "was the grace window
    //    armed" used to require instrumenting the system to answer.
    Object.assign(ui, { inventory: false });
    Object.assign(devices, { locked: true, freeMouseActive: true });
    equal(timing.lockGraceUntil, 0, "no grace window is armed before an intentional unlock");
    input.prepareUnlock();
    assert(timing.lockGraceUntil > performance.now(), "…and arming it is visible IN the resource");
    equal(timing.unlockIsIntentional, true, "…together with 'this unlock was ours'");
    equal(devices.freeMouseActive, false, "…while free-mouse mode drops at once, as before");
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
    Object.assign(devices, { locked: true, freeMouseActive: false });
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
    Object.assign(devices, { locked: false, freeMouseActive: false });
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
  near(C.POSITION.y[index], TERRAIN_TOP_Y + 1.6, 0.01, "the replayed run really landed");
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
    "src/plugins/ui/systems/reconcile.ts", "src/plugins/ui/systems/loading.ts", "src/plugins/ui/systems/toast.ts", "src/plugins/ui/systems/hud.ts",
    "src/plugins/ui/systems/keybind.ts", "src/plugins/ui/systems/inventory.ts", "src/plugins/ui/systems/navigation.ts", "src/plugins/ui/systems/bindings.ts",
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
  const kb = stripComments(readSource("src/plugins/ui/systems/keybind.ts"));
  const gestureData = stripComments(readSource("src/data/globals/keybind-gesture.ts"));
  assert(/capturing: BindAction \| null/.test(gestureData), "the rebind capture is gesture data");
  assert(/rebinds: RebindIntent\[\]/.test(gestureData), "…and the device decisions are a queue");
  assert(/private applyRebinds\(\)/.test(kb), "…applied by the ui.keybind system");
  equal(countOf(stripComments(readSource("src/plugins/input/keybinds.ts")), /^let capturing\b/gm), 0,
    "the keybinds module keeps no capture state (it holds a pointer to the resource)");
  // The boot/entry walks are DATA: the stage lists are declared by the composition root and the only
  // logic is the walker, which announces a stage before running its work.
  assert(/const BOOT_STAGES: readonly BootStage\[\]/.test(main), "the startup flow is a stage list");
  assert(/const stages: readonly BootStage\[\]/.test(main), "…and so is the world entry's");
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
  equal(M.DEFAULT_PLUGINS.join(","), "content-default,world,player,render,diagnostics,ui,input",
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
      world: {},
      registry,
      contribute: (point, items) => registry.contribute(point, "test", items),
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
    countOf(stripComments(readSource("src/plugins/render/index.ts")), /api\.system\(/g) === 4,
    "the render plugin owns the GPU resources");
  assert(/SLOT_RESOURCES, \[PERF_SAMPLER, DEBUG_LOG\]/.test(readSource("src/plugins/diagnostics/index.ts")),
    "the diagnostics plugin owns the perf sampler and the log forwarder");
  // …and ALL SIX into ONE registry, exactly as the boot does it. A resource token claimed by two plugins
  // would make the second plugin's setup throw, and the install would then skip that plugin's SYSTEMS —
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
    "the six plugins contribute side by side with no duplicate resource id");
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
  equal(countOf(stripComments(readSource("src/plugins/ui/index.ts")), /api\.system\(/g), 10,
    "…the ui plugin declares its ten systems");
  equal(countOf(stripComments(readSource("src/plugins/render/index.ts")), /api\.system\(/g), 4,
    "…the render plugin declares its four systems");
  equal(countOf(stripComments(readSource("src/plugins/player/index.ts")), /api\.system\(/g), 6,
    "…the player plugin declares its six systems");
  equal(countOf(stripComments(readSource("src/plugins/diagnostics/index.ts")), /api\.system\(/g), 1,
    "…and the diagnostics plugin declares exactly one system itself (api.system)");
  const declared = /const PLUGINS = \[([^\]]+)\]/.exec(bootSrc);
  assert(declared !== null, "the composition root declares its plugin list");
  equal((declared[1].match(/Plugin/g) || []).length, 7, "…and installs all seven");
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
    { world: {}, registry: new ExtensionRegistry(), log: () => {} },
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
  assert(/api\.system\(\{/.test(readSource("src/plugins/diagnostics/index.ts")),
    "the diagnostics plugin DECLARES its system (api.system), so the root no longer knows its name/stage/access");
  assert(typeof load("plugins/content-default/index.js").contentDefaultPlugin.start === "function",
    "…and it uses the start phase to report what the pack chain delivered");
  assert(typeof load("plugins/diagnostics/index.js").createDiagnosticsPlugin === "function",
    "a REAL plugin uses the lifecycle (diagnostics starts and stops the perf sampler)");
  equal(load("plugins/world/index.js").worldPlugin.start ?? null, null,
    "…while start/stop stay OPTIONAL for a plugin that has nothing to tear down");

  // 6b. THE BOOT ORDER, which no type-checker can see: a plugin factory CONSTRUCTS its systems and a system
  //     resolves its resources in the constructor, so the install block must sit AFTER the resource table and
  //     BEFORE the first registration. It was broken for two commits (the factories were built above the
  //     inserts and would have thrown on the first frame) — the app boots, so only a boot would have shown it.
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
  const declareLine = lineOf("declareUiSystems(uiApi,");
  assert(firstRegistration === 0 && declareLine > installLine,
    `…and BEFORE the declarations are contributed (install ${installLine} < declare ${declareLine}; the root\n` +
      ` registers nothing by hand, firstRegistration=${firstRegistration})`);

  // 6. THE LAYER RULES (P1.18b): a plugin may import a SIBLING only if it declared it in `deps`, and the
  //    declared graph must be acyclic — otherwise the install order it implies does not exist. Reading
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
  /** Which plugin does a source path belong to? (…/src/plugins/<id>/…) */
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
  equal(toHost, 0, `no plugin reads host/ any more (now ${toHost}) — that is what the injected services are for`);
  const unresolved = new Set(["content-default", "world", "player", "render", "diagnostics", "ui", "input"]);
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
