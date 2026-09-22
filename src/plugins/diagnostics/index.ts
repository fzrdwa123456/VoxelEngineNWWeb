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
});
