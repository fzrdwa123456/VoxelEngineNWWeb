// ===== The concrete commands: every ECS write that comes from OUTSIDE a system =====
// The UI layer, the DOM event handlers and the composition root do not touch component columns. They send
// one of these, and the next barrier applies it. See core/effect/command-queue.ts for why.
//
// WHY THEY LIVE IN `data/` AND NOT IN `core/` (P1.18d): a command NAME is game vocabulary and its body
// writes a data VALUE (the toast, the frame cap, the loading screen, the pack-reload request, the hot-plug
// toggle), so a kernel file defining them is the mechanism depending on the program. `core/effect` keeps the
// MECHANISM (`defineCommand` + the deferred queue) and the kernel now names no `data/` value at runtime at
// all - `check:ecs` counts that direction and fails on a single runtime import. The shape is the one
// `data/globals/ui-pages.ts` already had: a data module owns a resource AND the command that writes it.
//
// WHAT IS NOT HERE: everything ENTITY-shaped. The four player commands (`SetMode`, `Teleport`, `SelectSlot`,
// `SwapSlots`) are in `plugins/player/commands.ts` (P1.18b), because they write a plugin's own components.
import { defineCommand } from "../../core/world";
import { LOADING_STATE, createWorldSize, FADE_OPTIONS, FPS_CAP, PACK_RELOAD, WORLD_SIZE, sanitizeFrameCap, TOAST, TOAST_MS } from "./resources";
import { hotPlugLabel } from "./hotplug";
import { HOT_PLUG, hotInstall, hotUninstall } from "../../core/plugin/hotplug";
/** Show a toast: `key` is an i18n key unless `raw` is set ("cap set to 60" cannot be a key — see
 *  plugins/ui-toast/systems/toast.ts). The message is world state with a wall-clock deadline, so this command
 *  only arms it; the `ui-toast` plugin's system puts it on screen and takes it down again. It is reachable
 *  whatever plugins are installed, which is why it cannot live in that (optional) plugin — see P1.28. */
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

/** The vertical-sync switch (P1.86). It used to be a WebView2 LAUNCH ARGUMENT, so toggling it wrote a file
 *  and told the user to restart — and a restart-later switch sitting next to instant ones (the cap, the
 *  diagnostic log) reads as a broken button. Chromium's present mode really is launch-only; what is NOT
 *  launch-only is OUR pacing, and that is what the switch drives now (the launch arguments lift the
 *  display-rate limit unconditionally, and `pacingTargetHz` decides the rate on the next frame).
 *
 *  A COMMAND, like the cap: the loop reads the resource every frame, so it is world state, and a UI
 *  callback may not assign it. The settings FILE is written by the caller (config is not world state). */
export const SetVsync = defineCommand<{ vsync: boolean }>(
  "setVsync",
  (world, { vsync }) => {
    world.resource(FPS_CAP).vsync = vsync === true;
  },
);

/** The appearance fades, per ring (P2.01): which of the two tiers fades in/out when its chunks come and go.
 *  A COMMAND for the same reason as the cap and vsync — `chunk-stream` reads the resource every step, so a UI
 *  callback may not assign it. The settings FILE is written by the caller (config is not world state). */
export const SetFadeOption = defineCommand<{ which: "lod" | "chunks"; on: boolean }>(
  "setFadeOption",
  (world, { which, on }) => {
    const fades = world.resource(FADE_OPTIONS);
    if (which === "lod") fades.lod = on === true;
    else fades.chunks = on === true;
  },
);

/** THE WORLD SIZE (P2.02): the lap the noise, the torus and the LOD rings all read. A COMMAND for the same
 *  reason as the fades — the world-entry driver reads the resource to decide whether the lap has to change
 *  before it builds a world, so a UI callback may not assign it. The value is SANITISED here (clamped and
 *  snapped onto the legal grid), so the panel and the entry can never disagree about what a legal size is.
 *
 *  Applying it is NOT part of the command: the entry does that (set the period, reset the voxel map and the
 *  meshes) because it is the only place that knows nothing is streaming yet. */
export const SetWorldSize = defineCommand<{ chunksX: number; chunksZ?: number }>(
  "setWorldSize",
  (world, { chunksX, chunksZ }) => {
    const size = createWorldSize(chunksX, chunksZ ?? chunksX);
    world.resource(WORLD_SIZE).chunksX = size.chunksX;
    world.resource(WORLD_SIZE).chunksZ = size.chunksZ;
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

