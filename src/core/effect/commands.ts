// ===== Concrete commands: every ECS write that comes from OUTSIDE a system =====
// The UI layer, the DOM event handlers and the composition root do not touch component columns.
// They send one of these, and the next barrier applies it. See core/effect/command-queue.ts for why.
//
// WHAT LIVES HERE: only the commands that are about the WORLD as a whole and name no entity — the toast,
// the frame cap, the loading screen and the hot-plug toggle. Everything ENTITY-shaped belongs to the plugin
// that owns those components: the four player commands (`SetMode`, `Teleport`, `SelectSlot`, `SwapSlots`)
// are in `plugins/player/commands.ts` (P1.18b), because a file under `core/` may not import `plugins/`.
import { defineCommand } from "../world";
import { LOADING_STATE, FPS_CAP, PACK_RELOAD, sanitizeFrameCap, TOAST, TOAST_MS } from "../../data/globals/resources";
import { hotPlugLabel } from "../../data/globals/hotplug";
import { HOT_PLUG, hotInstall, hotUninstall } from "../plugin/hotplug";

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
 *  found, and finally that it is over. Sent by the three drivers in main.ts (the startup, entering a
 *  world, and the pack reload) — a partial update, because a stage usually advances the bar and renames
 *  the line but has nothing to report.
 *
 *  A COMMAND rather than a resource assignment for the same reason as the frame cap above: the
 *  composition root does not write world state directly, and the barrier is where the ui lane that
 *  paints the screen begins — so a stage that is sent and then awaited is on screen one frame later,
 *  which is the whole point of announcing it BEFORE its work runs. */
/** Ask for a RESOURCE PACK RELOAD — the MC-shaped "F3+T" (P1.49ab).
 *
 *  The command only RAISES the request (`PACK_RELOAD.requested`); the composition root's per-frame check runs
 *  the driver. Why the split: the work is ASYNCHRONOUS (Rust rescans the folders and hands back a new
 *  snapshot) and it re-derives tables a lane may not touch, so it can be neither a command body (a command
 *  must be cheap and synchronous at a barrier) nor a system. The request is a value, exactly like every other
 *  cross-lane intent.
 *
 *  Raise it and nothing else: the driver announces its own stages on the loading screen — MC's overlay. */
export const ReloadPacks = defineCommand<void>("reloadPacks", (world) => {
  world.resource(PACK_RELOAD).requested = true;
});

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
