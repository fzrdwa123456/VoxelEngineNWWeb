// ===== ui-keybind, as a DISCOVERED plugin (P1.40), and it CONSTRUCTS ITSELF now (P1.18c) =====
// It used to take TWO host instances (the system bag and the entry array) around a rubber-band widget the ROOT
// spawned. The widget, the drag wiring and the system are this plugin's, so they are built here, at wiring time
// (a `setup` may NOT change the entity structure — iron rule 1, an install is not a barrier). `hot: true` -> F9.
//
// WHAT IT STILL TAKES FROM THE HOST, and why:
//   * `keybindEntries` — the entry BUTTONS one per settings panel are spawned by the menus (root-built views),
//     which push them into this array; it is wiring data the root owns and the plugin reads by reference, the
//     same shape as `uiTrees`;
//   * nothing else: the bind table (`plugins/input/keybinds`), the gesture resource, its own view helpers and the
//     reconciler's hit test (`UI_HANDLES`, read lazily when the drag asks) are all reachable from here — the
//     first because `input` is a DECLARED dep of this plugin, the others because they are data.
import type { DiscoveredPlugin, PluginHost } from "../../core/plugin/host";
import { KEYBIND_GESTURE } from "../../data/globals/keybind-gesture";
import { UI_HANDLES } from "../../data/globals/ui-handles";
import { endCapture, getBind, getCapturing, setBind } from "../input/keybinds";
import { createKeybindSystem, createUiKeybindPlugin } from "./index";
import { bindKeybindDrag, boundCodes, keycapAtPoint, spawnKeybindLine } from "./views/keybind";

type Entries = Parameters<typeof createUiKeybindPlugin>[1];

export function createPlugin(host: PluginHost): DiscoveredPlugin {
  const world = host.world;
  const entries = host.instances.keybindEntries as Entries;
  // The rubber band the drag draws: the VIEW spawns it, the system writes its geometry every frame.
  const line = spawnKeybindLine(world);
  const uiKeybind = createKeybindSystem(world, {
    boundCodes,
    capturing: getCapturing,
    bindOf: getBind,
    // The bind itself is applied by THIS system (it drains the queued device decisions), so the writes are
    // injected like the reads: the event listener only reports what happened.
    setBind,
    endCapture,
    log: host.log,
    line,
    entries,
    keycapAt: keycapAtPoint,
  });
  // The drag asks the UI SYSTEM what is under the cursor (only the reconciler owns the elements), through the
  // handle the ui plugin publishes — resolved when the drag asks, long after every plugin was installed.
  bindKeybindDrag({
    log: host.log,
    world,
    hitTest: (x, y) => world.resource(UI_HANDLES).uiRender.hitTest(x, y),
    gesture: world.resource(KEYBIND_GESTURE),
  });
  return { hot: true, plugin: createUiKeybindPlugin({ uiKeybind }, entries) };
}
