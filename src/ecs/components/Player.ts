// ===== Entity components + spawn helpers =====
// Ten of the components below are ENTITY-AGNOSTIC — position, previous position, orientation,
// buffered view deltas, motion, control, body box, reach, interaction cooldowns and inventory. Any
// entity can carry them; nothing in their definition says "player". Only the PLAYER marker and
// spawnPlayer() are player-specific, which is why the spawn helpers are split:
//
//   attachMovable / spawnMovable  a physical body that movement and collision act on
//   spawnPlayer                   that, plus the parts only a locally driven entity has
//
// Everything the old Player class held is now one of these components. The split to keep in mind
// when adding state: does it belong to THIS entity (component) or to the process (resource)? See
// ecs/resources.ts for the singleton half.
//
// STORAGE KIND IS PART OF THE DEFINITION, and the two kinds have different access rules:
//
//   POSITION / PREV_POSITION / ORIENTATION / VIEW / BODY / REACH / INTERACTION / PLAYER are SOA.
//   They are typed arrays per field, indexed by entity index: `POSITION.x[index]`. Never cache
//   `POSITION.x` across a structural change (the array is re-allocated when the entity count
//   outgrows it) — inside one system step it is safe, because structural changes only happen at a
//   barrier. PLAYER has NO fields at all: it is pure membership, so it costs one sparse slot.
//
//   MOTION / CONTROL / INVENTORY are RECORDs: one plain object per entity, identity stable while
//   attached. `world.get(entity, CONTROL)` may be cached for the system's whole lifetime (iron
//   rule 2). INVENTORY is a record because slot contents are objects, not numbers.
//
// The `index` in `POSITION.x[index]` comes from entityIndex(entity) — components are addressed by
// ROW, entities are addressed by HANDLE. See ecs/core/entity.ts.
import { defineComponent, defineRecord, entityIndex, type Entity, type World } from "../World";

/** A world position to place an entity at */
export interface SpawnPoint {
  x: number;
  y: number;
  z: number;
}

/** Body box + eye height: the numbers collision and the placement check read */
export interface BodyDims {
  halfWidth: number;
  height: number;
  eyeHeight: number;
}

/** Spawn DEFAULTS for a humanoid body — not state. Every entity carries its own numbers in the BODY
 *  component; this exists only so the composition root and the spawn helpers agree on the initial
 *  ones. Named for the BODY it describes, not for the player, because any entity can have one. */
export const HUMANOID_BODY: BodyDims = { halfWidth: 0.3, height: 1.8, eyeHeight: 1.6 };

/** Spawn DEFAULT block reach, in blocks (MC creative is 5). Per-entity data lives in REACH. */
export const DEFAULT_REACH = 6;

export type MoveMode = "walk" | "fly" | "spectator";
export const MODE_NAMES: Record<MoveMode, string> = {
  walk: "Survival Mode",
  fly: "Creative Mode",
  spectator: "Spectator Mode",
};

// ===== carried items =====
/** A block type id from the block registry (src/blockregistry.ts) */
export type BlockTypeId = string;

/** One inventory stack */
export interface InvItem {
  type: BlockTypeId;
  count: number;
}

export const HOTBAR_SLOTS = 9;
/** hotbar + backpack */
export const INVENTORY_SLOTS = HOTBAR_SLOTS + 27;

// ===== components =====

/** World-space position (feet-relative; the eyes sit BODY.eyeHeight above it) */
export const POSITION = defineComponent("position", { x: "f32", y: "f32", z: "f32" });

/** Position at the START of the current fixed step. Written by the camera snapshot system, which
 *  runs FIRST in the fixed lane, and read by two consumers that used to keep private copies:
 *  the render interpolation (camera-view) and the collision sweep origin (collision). */
export const PREV_POSITION = defineComponent("prevPosition", { x: "f32", y: "f32", z: "f32" });

/** Body/view orientation: up = gravity frame (flat world: (0,1,0)), fwd = horizontal heading,
 *  pitch = look angle relative to the local horizon. Flat numbers, not Vector3s: component data
 *  stays plain data, so nothing in the ECS holds an object with methods. */
export const ORIENTATION = defineComponent("orientation", {
  fwdX: "f32",
  fwdY: "f32",
  fwdZ: "f32",
  upX: "f32",
  upY: "f32",
  upZ: "f32",
  pitch: "f32",
});

/** Buffered view deltas: written by the input system's event handlers (as often as the OS delivers
 *  mouse events) and drained once per fixed step by the controller. This is a COMPONENT rather than
 *  input-system state so the controller never has to import the input system. */
export const VIEW = defineComponent("view", { yawDelta: "f32", pitchDelta: "f32" });

/** Walking vertical state (gravity/jump); fly/spectator ignore it */
export interface MotionC {
  vy: number;
  onGround: boolean;
}
export const MOTION = defineRecord<MotionC>("motion", () => ({ vy: 0, onGround: false }));

/** Control state: held bind codes + current mode + creative flying sub-state */
export interface ControlC {
  readonly keys: Set<string>;
  mode: MoveMode;
  flying: boolean;
}
export const CONTROL = defineRecord<ControlC>("control", () => ({
  keys: new Set<string>(),
  mode: "walk",
  flying: false,
}));

/** Body box + eye height. Per ENTITY, not a global constant: collision resolution, the
 *  "don't seal yourself inside a block" placement check and the F3 panel all read the numbers of
 *  the entity they are processing, so a small mob and a tall player can coexist. */
export const BODY = defineComponent("body", {
  halfWidth: "f32",
  height: "f32",
  eyeHeight: "f32",
});

/** How far this entity can reach, in blocks (MC creative is 5) */
export const REACH = defineComponent("reach", { distance: "f32" });

/** Break/place rate limiting, per entity. These used to be private fields on the interaction
 *  system, which is only correct while there is exactly one entity that can edit blocks. */
export const INTERACTION = defineComponent("interaction", {
  breakCooldown: "f32",
  placeCooldown: "f32",
});

/** Carried items. A RECORD because slot contents are objects, and because the DOM view renders this
 *  very array — one owner, no mirrored copy. */
export interface InventoryC {
  readonly slots: Array<InvItem | null>;
  selected: number;
}
export const INVENTORY = defineRecord<InventoryC>("inventory", () => ({
  slots: new Array<InvItem | null>(INVENTORY_SLOTS).fill(null),
  selected: 0,
}));

/** Marker: this entity is driven by a LOCAL player's input. Zero-size — it carries membership only.
 *  Read where "the local player" has to be distinguished from every other entity: movement and
 *  interaction freeze an uncontrolled player but must leave NPCs running. */
export const PLAYER = defineComponent("player", {});

/** The block this entity's ray currently hits, as DATA: `active` plus the voxel coordinate of the
 *  highlighted block. The interaction system (FIXED lane) writes it; `block.outline`
 *  (rendering/outline.ts, RENDER lane) draws the wireframe box from it.
 *
 *  It exists because the outline is a three.js object: the fixed lane used to write its transform
 *  directly (`writesExternal: ["outline"]`), i.e. presentation state mutated from the simulation tick.
 *  A hit result is per-entity state, so it is a component — the lane boundary is crossed by data, and
 *  only the render lane touches the mesh. Only the LOCAL player carries it (spawnPlayer inserts it):
 *  one wireframe for one playable view. */
export const TARGET_HIT = defineComponent("targetHit", {
  /** 0 = nothing targeted (the box is hidden) */
  active: "u8",
  x: "i32",
  y: "i32",
  z: "i32",
});

/** Place an entity: POSITION and PREV_POSITION MUST agree, because PREV_POSITION is the origin the
 *  next collision sweep starts from. Every spawn path and the Teleport command go through here, so
 *  the two can never drift apart. */
export function placeEntity(world: World, entity: Entity, at: SpawnPoint): void {
  const index = entityIndex(entity);
  POSITION.x[index] = at.x;
  POSITION.y[index] = at.y;
  POSITION.z[index] = at.z;
  if (!world.has(entity, PREV_POSITION)) return; // nothing to keep in step with
  PREV_POSITION.x[index] = at.x;
  PREV_POSITION.y[index] = at.y;
  PREV_POSITION.z[index] = at.z;
}

/** Attach everything a physical, locomotion-driven body needs, with a fresh control frame at the
 *  origin. THIS FUNCTION IS THE DECLARATION of that requirement set — the queries it has to satisfy
 *  are movement's (CONTROL+POSITION+ORIENTATION+MOTION), collision's
 *  (CONTROL+POSITION+MOTION+BODY+PREV_POSITION) and the `motion.snapshot` system's
 *  (POSITION+PREV_POSITION). Change one of those and change this; the Node assertion suite pins the
 *  three together. */
export function attachMovable(world: World, entity: Entity, body: BodyDims = HUMANOID_BODY): void {
  world.insert(entity, POSITION);
  world.insert(entity, PREV_POSITION);
  world.insert(entity, ORIENTATION, {
    fwdX: 0,
    fwdY: 0,
    fwdZ: -1,
    upX: 0,
    upY: 1,
    upZ: 0,
    pitch: 0,
  });
  world.insert(entity, MOTION);
  world.insert(entity, CONTROL);
  world.insert(entity, BODY, {
    halfWidth: body.halfWidth,
    height: body.height,
    eyeHeight: body.eyeHeight,
  });
}

/** Spawn a generic movable entity — an NPC, a physics-driven prop, anything that walks and collides.
 *  It carries no PLAYER marker (so the input freeze never applies to it) and no REACH/INTERACTION/
 *  INVENTORY (so it cannot edit blocks). Add those to make an editor. */
export function spawnMovable(world: World, at: SpawnPoint, body: BodyDims = HUMANOID_BODY): Entity {
  const entity = world.spawn();
  attachMovable(world, entity, body);
  placeEntity(world, entity, at);
  return entity;
}

/** Spawn the local player: a movable body plus the parts only a locally driven entity has.
 *  `startingItems` fills the hotbar with the first block ids (the composition root passes the
 *  registry's ids, so the ECS layer never imports the registry). */
export function spawnPlayer(
  world: World,
  at: SpawnPoint,
  startingItems: readonly BlockTypeId[] = [],
): Entity {
  const entity = spawnMovable(world, at);
  world.insert(entity, VIEW); // buffered mouse deltas: only a local input device produces them
  world.insert(entity, REACH, { distance: DEFAULT_REACH });
  world.insert(entity, INTERACTION); // break/place rate limits
  world.insert(entity, INVENTORY);
  world.insert(entity, PLAYER); // marker: driven by local input, so the input freeze applies
  world.insert(entity, TARGET_HIT); // the block its ray hits: written by interaction, drawn by block.outline
  const inventory = world.get(entity, INVENTORY)!;
  startingItems.slice(0, HOTBAR_SLOTS).forEach((type, slot) => {
    inventory.slots[slot] = { type, count: 64 };
  });
  return entity;
}
