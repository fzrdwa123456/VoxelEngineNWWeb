// ===== The boot / world-entry FLOW, as data + one walker =====
// Two drivers in the composition root put the loading screen up and do slow work behind it: the STARTUP
// (settings check -> GPU handshake -> main menu) and a WORLD ENTRY (teleport -> spawn window generated,
// primed and meshed -> play). The screen is widget data (LOADING_STATE + ui.loading, moved by the
// SetLoadingStage command), and both drivers announce a stage BEFORE running its work so what the user
// reads is what the process is doing at that moment.
//
// WHAT WAS WRONG WITH THE OLD SHAPE. The stage sequence lived in the two functions as straight-line async
// code: which stages exist, what each one announces (its progress and its i18n key) and what it does were
// only readable by reading the driver top to bottom, and the one piece of state the sequence produces —
// the settings-check outcome that the SECOND stage reports — was a local variable threaded by hand.
//
// NOW: the stages are DATA (`BootStage[]`, declared by the composition root, which is the only place that
// knows what this app's startup does), the one piece of produced state is data too (the note in
// `BootFlowState`, where a probe or a test can read it), and the only logic left is this walker: announce
// a stage, yield one macrotask so the browser can paint the announcement, then run the stage's work. A
// stage with no work is a pure announcement (a progress step), which is exactly what the bar's intermediate
// steps are.
import { defineResource, type Resource } from "./World";

/** One step of a flow. `run` is optional: a stage that only moves the bar announces and returns. */
export interface BootStage {
  /** Progress the loading bar shows for this stage (0..1) */
  readonly progress: number;
  /** The stage's i18n key; omitted for a stage that only moves the bar */
  readonly key?: string;
  /** Also report the flow's NOTE (the settings check's outcome) with this stage's announcement */
  readonly withNote?: boolean;
  /** The work. Async stages (the GPU handshake, the chunk warm-up) are awaited before the next announce. */
  readonly run?: () => void | Promise<void>;
}

export interface BootFlowState {
  /** Which flow is running, or null when none is */
  flow: "boot" | "world" | null;
  stages: readonly BootStage[];
  /** The stage being announced/run (diagnostics: "what is the startup doing right now") */
  index: number;
  /** When the flow started (ms, `performance.now()`) */
  startedAt: number;
  /** The note the next `withNote` stage reports — the settings check's i18n key + value */
  noteKey: string;
  noteValue: string;
}

export const BOOT_FLOW = defineResource<BootFlowState>("bootFlow");

export function createBootFlow(): BootFlowState {
  return { flow: null, stages: [], index: 0, startedAt: 0, noteKey: "", noteValue: "" };
}

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
