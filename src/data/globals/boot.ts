// ===== The boot / world-entry FLOW, as DATA =====
// The stage list of both flows is DECLARED BY THE COMPOSITION ROOT (main.ts) — it is the only place that
// knows what this app's startup does — and the ONE walker that runs them is
// `logic/engine/boot.ts::runBootFlow`. This module holds the shapes and the resource: which flow is
// running, its stage list, the index being announced, when it started and the NOTE the second stage
// reports (the settings check's outcome).
//
// The note being a FIELD is the point of the whole split: it is state the sequence produces and a later
// stage consumes, so it is written down in the world instead of being threaded through a local variable.
import { defineResource, type Resource } from "../../core/world";

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
