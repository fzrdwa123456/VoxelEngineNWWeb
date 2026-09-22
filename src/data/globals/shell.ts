// ===== The HOST state, as DATA =====
// The shell's own bookkeeping — the settings snapshot it read at boot, the queued log lines, the
// log-flush deadline, the diagnostic-probe switch and the foreground flag — is state, so it lives here
// under `data/`, not inside the module that happens to write it (that module only holds a POINTER to this
// object).
//
// The object is created at import time on purpose: the inline `bootReport()` in index.html may write a log
// line before main.ts's body runs, and `logDebug` has to be able to answer "are probes enabled?" before
// the World exists. The composition root INSERTS this same object as SHELL_STATE, so the host's data is
// world state like everything else and a probe can read it.
import { defineResource, type Resource } from "../../core/world";

/** What Rust's `preload_shell` returns (the field names match serde's camelCase one for one) */
export interface ShellSnapshot {
  gameRoot: string;
  dev: boolean;
  settings: Record<string, unknown>;
  settingsProblem: string | null;
  windowMode: string;
  vsyncDisabled: boolean;
  focused: boolean;
  browserArgs: string;
  platform: string;
}

export interface ShellState {
  snapshot: ShellSnapshot;
  flushTimer: number | null;
  /** The log lines queued for the next `append_log` (the batch is 64 lines or 200ms). It is the same
   *  mechanism as `flushTimer`, so both halves of the log batching are state and live here, not in the
   *  module that happens to drain them. */
  pending: Record<string, string[]>;
  diagLogEnabled: boolean;
  windowFocused: boolean;
}

export const SHELL_STATE: Resource<ShellState> = defineResource<ShellState>("shellState");

const state: ShellState = {
  snapshot: {
    gameRoot: "(not initialized)",
    dev: false,
    settings: {},
    settingsProblem: null,
    windowMode: "windowed",
    vsyncDisabled: true,
    focused: true,
    browserArgs: "",
    platform: "tauri",
  },
  flushTimer: null,
  pending: { debug: [], renderer: [] },
  diagLogEnabled: true,
  windowFocused: false,
};

/** The one instance: the host module reads and writes it, and the composition root inserts it. */
export function shellState(): ShellState {
  return state;
}

// ===== The log batching's tuning constants =====
// The two halves of the batch rule the queue in `ShellState.pending` obeys: flush when this many lines are
// queued, or after this long, whichever comes first. Data, so they live next to the queue they describe.
export const FLUSH_LINES = 64;
export const FLUSH_MS = 200;
