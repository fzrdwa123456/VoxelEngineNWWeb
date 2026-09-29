// ===== The PLAYER's commands: every write to this plugin's own components, from outside a system =====
// These four used to live in `core/effect/commands.ts`, and that was the LAST place the kernel knew a game
// word: `SetMode`/`Teleport`/`SelectSlot`/`SwapSlots` all read or write the PLAYER's component schemas
// (CONTROL, MOTION, POSITION, VIEW, INVENTORY), so a file inside `core/` had to import
// `plugins/player/components` — the one import the layer table forbids ("core/ must never import plugins/").
//
// WHAT MOVED AND WHAT DID NOT: the MECHANISM stayed (`defineCommand` in `core/effect/command-queue.ts`,
// the deferred queue, the barrier that applies it); only the four player-shaped DEFINITIONS moved here,
// next to the components they touch. `plugins/player/index.ts` contributes them into `SLOT_COMMANDS`, so
// "which commands exist because this plugin exists" is now a statement the plugin makes about itself.
//
// The kernel keeps the commands that are about the world as a whole and name no entity: `ShowToast`,
// `SetFpsCap`, `SetLoadingStage` and `HotPlugPlugin`.
import { defineCommand, entityIndex, type Entity } from "../../core/world";
import {
  CONTROL,
  INVENTORY,
  INVENTORY_SLOTS,
  MOTION,
  placeEntity,
  POSITION,
  VIEW,
  type MoveMode,
  type SpawnPoint,
} from "./components";

/** Switch the movement mode: resets flying and clears the vertical state, exactly as the F3+F4
 *  gamemode picker needs. Sent by ui-debug's picker (which reads CONTROL.mode itself). */
export const SetMode = defineCommand<{ entity: Entity; mode: MoveMode }>(
  "setMode",
  (world, { entity, mode }) => {
    if (!world.has(entity, CONTROL)) return; // entity is not a controllable player any more
    const control = world.get(entity, CONTROL)!;
    const motion = world.get(entity, MOTION);
    control.mode = mode;
    control.flying = false;
    if (motion) {
      motion.vy = 0;
      motion.onGround = false;
    }
  },
);

/** Hard move (world entry / respawn). Goes through placeEntity, so POSITION and PREV_POSITION move
 *  together — a Teleport that updated only POSITION would leave the next collision sweep starting
 *  from the old place. The buffered view deltas are reset too, so the render interpolation cannot
 *  sweep across the world for one frame. */
export const Teleport = defineCommand<{ entity: Entity } & SpawnPoint>(
  "teleport",
  (world, { entity, x, y, z }) => {
    if (!world.has(entity, POSITION)) return;
    placeEntity(world, entity, { x, y, z });
    const index = entityIndex(entity);
    if (world.has(entity, VIEW)) {
      VIEW.yawDelta[index] = 0;
      VIEW.pitchDelta[index] = 0;
    }
    const motion = world.get(entity, MOTION);
    if (motion) {
      motion.vy = 0;
      motion.onGround = false;
    }
  },
);

/** Select a hotbar slot. The hotbar highlight is NOT drawn here — `ui.inventory` reconciles the DOM from
 *  this component every frame, so the UI never owns a copy of the selection. */
export const SelectSlot = defineCommand<{ entity: Entity; slot: number }>(
  "selectSlot",
  (world, { entity, slot }) => {
    const inventory = world.get(entity, INVENTORY);
    if (!inventory) return;
    if (!Number.isInteger(slot) || slot < 0 || slot >= INVENTORY_SLOTS) return;
    inventory.selected = slot;
  },
);

/** Move a stack between two slots (the backpack grid click, and later any drag/drop). */
export const SwapSlots = defineCommand<{ entity: Entity; a: number; b: number }>(
  "swapSlots",
  (world, { entity, a, b }) => {
    const inventory = world.get(entity, INVENTORY);
    if (!inventory) return;
    const slots = inventory.slots;
    if (a === b) return;
    if (a < 0 || a >= slots.length || b < 0 || b >= slots.length) return;
    const held = slots[a];
    slots[a] = slots[b];
    slots[b] = held;
  },
);
