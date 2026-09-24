// ===== Concrete commands: every ECS write that comes from OUTSIDE a system =====
// The UI layer, the DOM event handlers and the composition root do not touch component columns.
// They send one of these, and the next barrier applies it. See ecs/core/commands.ts for why.
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
} from "../../plugins/player/components";
import { entityIndex, defineCommand, type Entity } from "../world";
import { LOADING_STATE, FPS_CAP, sanitizeFrameCap, TOAST, TOAST_MS } from "../../data/globals/resources";
import { hotPlugLabel } from "../../data/globals/hotplug";
import { HOT_PLUG, hotInstall, hotUninstall } from "../plugin/hotplug";

/** Switch the movement mode: resets flying and clears the vertical state, exactly as the F3+F4
 *  gamemode picker needs. Sent by ecs/ui/picker.ts (the picker reads CONTROL.mode itself). */
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

/** Select a hotbar slot. The hotbar highlight is NOT drawn here — the `ui.inventory` render system
 *  reconciles the DOM from this component every frame, so the UI never owns a copy of the selection. */
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

/** Show a toast: `key` is an i18n key unless `raw` is set ("cap set to 60" cannot be a key — see
 *  ecs/ui/toast.ts). The message is world state with a wall-clock deadline, so this command only arms
 *  it; the ui lane's `ui.toast` system puts it on screen and takes it down again. */
export const ShowToast = defineCommand<{ key: string; raw?: boolean }>(
  "showToast",
  (world, { key, raw }) => {
    const toast = world.resource(TOAST);
    toast.key = key;
    toast.raw = raw === true;
    toast.until = performance.now() + TOAST_MS;
  },
);

/** Set the frame-rate cap (0 = unlimited), the one setting that is ALSO world state: the frame gate
 *  reads the resource every frame. Sent by the settings panels through main.ts, which used to assign
 *  `frameCap.cap` straight from a UI callback — a world value changed outside any system run, in the
 *  one place that is not allowed to change components either. The setting FILE is still written by the
 *  caller (config is not world state); only the world's copy goes through the barrier. */
export const SetFpsCap = defineCommand<{ cap: number }>(
  "setFpsCap",
  (world, { cap }) => {
    world.resource(FPS_CAP).cap = sanitizeFrameCap(cap);
  },
);

/** HOT-PLUG one plugin: install it if it is not installed, uninstall it if it is (P1.24).
 *
 *  Assembly as a COMMAND, which is the whole point: installing a plugin adds systems to the schedule and
 *  re-resolves it, and the barrier between two frames is the only place that is legal. The key edge that
 *  raises this is a device event in the ui lane, so the request is queued and applied before the next lane
 *  runs — the schedule is never changed underneath a running system.
 *
 *  The OUTCOME becomes a toast: a window with no console has no other way to say "that plugin is gone now,
 *  and F3/F4 will do nothing". The toast is sent as a further command, so it is armed at the NEXT barrier
 *  (one frame later) — it is a notification, not part of the change. */
export const HotPlugPlugin = defineCommand<string>("hotPlugPlugin", (world, id) => {
  const host = world.resource(HOT_PLUG);
  const outcome = host.installed().includes(id) ? hotUninstall(host, id) : hotInstall(host, id);
  const label = hotPlugLabel(id);
  const text = outcome.ok
    ? `${label}: ${outcome.action === "install" ? "ON" : "OFF"} — ${outcome.systems.length} system(s) ` +
      `${outcome.action === "install" ? "added to" : "removed from"} the schedule`
    : `${label}: FAILED — ${outcome.reason}`;
  world.commands.send(ShowToast, { key: text, raw: true });
});

/** Move the loading screen along: which stage is running, how far it is, what the settings check
 *  found, and finally that it is over. Sent by the two drivers in main.ts (the startup, and entering
 *  a world) — a partial update, because a stage usually advances the bar and renames the line but has
 *  nothing to report.
 *
 *  A COMMAND rather than a resource assignment for the same reason as the frame cap above: the
 *  composition root does not write world state directly, and the barrier is where the ui lane that
 *  paints the screen begins — so a stage that is sent and then awaited is on screen one frame later,
 *  which is the whole point of announcing it BEFORE its work runs. */
export const SetLoadingStage = defineCommand<{
  key?: string;
  progress?: number;
  noteKey?: string;
  noteValue?: string;
  active?: boolean;
}>("setLoadingStage", (world, patch) => {
  const loading = world.resource(LOADING_STATE);
  if (patch.key !== undefined) loading.key = patch.key;
  if (patch.progress !== undefined) {
    loading.progress = Number.isFinite(patch.progress) ? Math.min(1, Math.max(0, patch.progress)) : 0;
  }
  if (patch.noteKey !== undefined) loading.noteKey = patch.noteKey;
  if (patch.noteValue !== undefined) loading.noteValue = patch.noteValue;
  if (patch.active !== undefined) loading.active = patch.active;
});
