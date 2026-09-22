// ===== The boot / world-entry WALKER =====
// Two drivers put the loading screen up and do slow work behind it: the STARTUP (settings check -> GPU
// handshake -> main menu) and a WORLD ENTRY (teleport -> spawn window generated, primed and meshed -> play).
// The screen is widget data (LOADING_STATE + ui.loading, moved by the SetLoadingStage command), and both
// flows announce a stage BEFORE running its work so what the user reads is what the process is doing.
//
// The STAGE LISTS are data (`data/globals/boot.ts`); all the logic there is is this walker: announce a
// stage, yield one macrotask so the browser can paint the announcement, then run the stage's work. A stage
// with no work is a pure announcement (a progress step), which is what the bar's intermediate steps are.
//
// WHY IT IS NOT A SYSTEM: a system cannot await, and these stages await the GPU handshake and the chunk
// warm-up. What a system would buy (being listed in a lane and ordered against others) is not needed here:
// the flows run while nothing else does — `load` mode runs the ui lane alone.
import type { BootFlowState, BootStage } from "../../data/globals/boot";

/** Everything the walker needs from the composition root (it drives the loading screen through the
 *  command barrier, which only the root may do). */
export interface BootFlowDeps {
  /** Publish a stage (progress + key + optional note) and pump the ui lane so it reaches the DOM */
  readonly announce: (stage: BootStage) => void;
  /** Yield one MACROTASK so the browser can present what `announce` wrote. Deliberately not a second
   *  rAF chain (the process owns exactly ONE) and not a microtask: a timer boundary is what lets the
   *  compositor present the screen before the GPU handshake or the chunk meshing blocks the thread. */
  readonly paint: () => Promise<void>;
  readonly now: () => number;
}

/** Walk a flow: announce each stage, paint it, run its work. The sequence is the DATA; this is all the
 *  logic there is. Returns when the last stage's work has settled. */
export async function runBootFlow(
  state: BootFlowState,
  name: "boot" | "world",
  stages: readonly BootStage[],
  deps: BootFlowDeps,
): Promise<void> {
  state.flow = name;
  state.stages = stages;
  state.startedAt = deps.now();
  for (state.index = 0; state.index < stages.length; state.index++) {
    const stage = stages[state.index];
    deps.announce(stage);
    await deps.paint();
    if (stage.run) await stage.run();
  }
  state.index = stages.length;
  state.flow = null;
}
