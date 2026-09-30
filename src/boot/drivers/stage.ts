// ===== The loading-screen STAGE driver: announce, paint, and RUN a flow (P1.18e) =====
// The startup, entering a world and the pack reload all drive the SAME screen the same way: announce a
// stage through the command barrier, let the browser present it, then run the stage's work. That shared
// half lives here, so each driver below owns only what is ITS OWN sequence.
//
// WHY THE COMMAND AND NOT A FLAG: `LOADING_STATE` is world state and the ui lane paints it, so a driver
// that assigned the fields would be a write from outside a lane. `world.renderUi()` is the pump — the
// barrier plus the ui lane and nothing else — which is what makes "announce, then paint, then work" true
// on screen rather than merely in the log.
//
// The yield is a MACROTASK, deliberately: not a second requestAnimationFrame chain (the process owns
// exactly ONE — see the loop in boot/main.ts) and not a microtask, because a timer task boundary is what
// lets the compositor present the screen before the GPU handshake and the chunk meshing block the thread.
import { BOOT_FLOW, type BootStage } from "../../data/globals/boot";
import { runBootFlow, type BootFlowDeps } from "../../core/flow/boot";
import { SetLoadingStage } from "../../data/globals/commands";
import type { World } from "../../core/world";

/** What a driver may ask of the screen. `run` is the flow walker itself (its stage list is the caller's). */
export interface StageDriver {
  /** Announce a stage, reconcile it NOW and let it paint (the stage's own work comes after). */
  announce(stage: BootStage): void;
  /** Yield one macrotask, so what the last frame wrote is on screen. */
  paint(): Promise<void>;
  /** Walk a stage list: each stage is announced and painted BEFORE its `run` executes. */
  run(flow: "boot" | "world", stages: readonly BootStage[]): Promise<void>;
}

export function createStageDriver(world: World): StageDriver {
  const bootFlow = world.resource(BOOT_FLOW);
  const paint = (): Promise<void> =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  /** `key` is omitted for a stage that only moves the bar, `withNote` for the one stage that reports the
   *  settings check's outcome (the note lives in BOOT_FLOW, like every other value the screen shows). */
  const announce = (stage: BootStage): void => {
    world.commands.send(SetLoadingStage, {
      progress: stage.progress,
      ...(stage.key === undefined ? {} : { key: stage.key }),
      ...(stage.withNote ? { noteKey: bootFlow.noteKey, noteValue: bootFlow.noteValue } : {}),
    });
    world.renderUi(); // the barrier + the ui lane: the same pump a menu frame uses
  };
  const deps: BootFlowDeps = { announce, paint, now: () => performance.now() };
  return {
    announce,
    paint,
    run: (flow, stages) => runBootFlow(bootFlow, flow, stages, deps),
  };
}
