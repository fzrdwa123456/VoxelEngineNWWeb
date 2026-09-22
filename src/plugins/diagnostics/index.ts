// ===== Plugin: diagnostics =====
// The F3/perf plumbing: the perf sampler, the diagnostic-queue forwarder and the probe lines. It is the
// plugin a player is most likely to turn OFF in `plugins.json` (it is pure measurement), which is why it
// is its own plugin rather than a corner of `render`.
import { SLOT_RESOURCES } from "../../core/extension/slots";
import { definePlugin } from "../../core/plugin/descriptor";
import { PERF_SAMPLER } from "../../data/globals/gfx";
import { DEBUG_LOG } from "../../data/globals/resources";

export const diagnosticsPlugin = definePlugin({
  id: "diagnostics",
  deps: ["render"],
  setup(api) {
    api.contribute(SLOT_RESOURCES, [PERF_SAMPLER, DEBUG_LOG]);
  },
});
