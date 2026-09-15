// ===== Player entity: component definitions + spawn helper =====
// The player is a pure-ECS entity: a bare store id carrying data components. All behavior
// lives in systems (ecs/systems/*) — replaces the old Player class (composition bag).
// Component objects are stable references created once at spawn; systems cache them and mutate
// fields in place (the store holds the same references, so caches never go stale).
import * as THREE from "three/webgpu";
import { componentKey, type EntityId } from "../store";
import type { World } from "../World";

/** Eye height above the feet (view/feet calculations) */
export const EYE_HEIGHT = 1.6;

/** Body box: 0.6 x 1.8 with the eyes EYE_HEIGHT above the feet. Lives here rather than inside a
 *  system because more than one system needs identical dimensions: collision resolution and the
 *  "don't seal yourself inside a block" check in block placement. */
export const PLAYER_HALF_WIDTH = 0.3;
export const PLAYER_HEIGHT = 1.8;

export type MoveMode = "walk" | "fly" | "spectator";
export const MODE_NAMES: Record<MoveMode, string> = {
  walk: "Survival Mode",
  fly: "Creative Mode",
  spectator: "Spectator Mode",
};

/** World-space position (the component record IS the vector — mutate in place) */
export const POSITION = componentKey<THREE.Vector3>("position");

/** Body/view orientation: up = gravity frame (flat world: (0,1,0)), fwd = horizontal heading,
 *  pitch = look angle relative to the local horizon */
export interface OrientationC {
  readonly up: THREE.Vector3;
  readonly fwd: THREE.Vector3;
  pitch: number;
}
export const ORIENTATION = componentKey<OrientationC>("orientation");

/** Walking vertical state (gravity/jump); fly/spectator ignore it */
export interface MotionC {
  vy: number;
  onGround: boolean;
}
export const MOTION = componentKey<MotionC>("motion");

/** Control state: held bind codes + current mode + creative flying sub-state */
export interface ControlC {
  readonly keys: Set<string>;
  mode: MoveMode;
  flying: boolean;
}
export const CONTROL = componentKey<ControlC>("control");

/** Spawn the player entity with its full component set; returns the entity id */
export function spawnPlayer(world: World, at: THREE.Vector3): EntityId {
  const id = world.entities.spawn();
  world.entities.add(id, POSITION, at.clone());
  world.entities.add(id, ORIENTATION, {
    up: new THREE.Vector3(0, 1, 0),
    fwd: new THREE.Vector3(0, 0, -1),
    pitch: 0,
  });
  world.entities.add(id, MOTION, { vy: 0, onGround: false });
  world.entities.add(id, CONTROL, { keys: new Set<string>(), mode: "walk", flying: false });
  return id;
}
