// ===== Plugin: diagnostics =====
// The F3/perf plumbing: the perf sampler, the diagnostic-queue forwarder and the probe lines. It is the
// plugin a player is most likely to turn OFF in `plugins.json` (it is pure measurement), which is why it
// is its own plugin rather than a corner of `render`.
import type { World } from "../../core/world";
import { SLOT_RESOURCES } from "../../core/extension/slots";
import { DiagnosticsSystem } from "../render/systems/diagnostics";
import { definePlugin } from "../../core/plugin/descriptor";
import { PERF_SAMPLER } from "../../data/globals/gfx";
import { DEBUG_LOG } from "../../data/globals/resources";

/** The perf/F3 system, constructed here: the file lives in the render plugin (it reads player and ui
 *  components), and this plugin depends on that one, which is why the import is legal. */
export function createDiagnosticsSystems(world: World) {
  return { diagnostics: new DiagnosticsSystem(world) };
}

export const diagnosticsPlugin = definePlugin({
  id: "diagnostics",
  deps: ["render"],
  setup(api) {
    api.contribute(SLOT_RESOURCES, [PERF_SAMPLER, DEBUG_LOG]);
  },
  /** The lifecycle's first real user: the perf sampler only means something once the world is assembled and
   *  the loop is about to run, and one line at each end of the session is exactly what `start`/`stop` are
   *  for. (It is also why the phases exist: `setup` runs while the schedule is still being assembled.) */
  start(api) {
    api.log("perf sampler live - the F3 panel and the PHYS/FRAME probes are fed from here");
  },
  stop(api) {
    api.log("perf sampler stopping");
  },
});
