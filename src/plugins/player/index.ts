// ===== Plugin: player =====
// The locally driven body: the component schemas it owns, the resources its systems read, the commands
// that may move it, and (in `boot/main.ts`, tagged with this id) the six fixed-lane systems.
//
// NOTE (P1.18b): the SYSTEMS are still constructed and registered by the composition root, because their
// construction needs the injected wiring (the input system's log sink, the interaction's UI callbacks).
// What this file owns today is the DECLARATION — which components/resources/commands exist because this
// plugin exists — and the id the manifest and the schedule report know it by.
import { SLOT_COMMANDS, SLOT_COMPONENTS, SLOT_RESOURCES } from "../../core/extension/slots";
import { definePlugin } from "../../core/plugin/descriptor";
import type { World } from "../../core/world";
import { SelectSlot, SwapSlots, Teleport } from "../../core/effect/commands";
import { BlockInteractionSystem, INTERACTION_ACCESS } from "./systems/interaction";
import { COLLISION_ACCESS, CollisionSystem } from "./systems/collision";
import { CONTROLLER_ACCESS, PlayerControllerSystem } from "./systems/controller";
import { INPUT_ACCESS, PlayerInputSystem, type MouseCapture } from "./systems/input";
import { MOVEMENT_ACCESS, PlayerMovementSystem } from "./systems/movement";
import { PositionSnapshotSystem, SNAPSHOT_ACCESS } from "./systems/snapshot";
import {
  INPUT_DIAGNOSTICS,
  INPUT_INTENTS,
  INPUT_STATE,
  INPUT_TIMING,
  LOCAL_PLAYER,
  POINTER,
} from "../../data/globals/resources";
import {
  BODY,
  CONTROL,
  INTERACTION,
  INVENTORY,
  MOTION,
  ORIENTATION,
  PLAYER,
  POSITION,
  PREV_POSITION,
  REACH,
  TARGET_HIT,
  VIEW,
} from "./components";

/** What the COMPOSITION ROOT has to hand this plugin: the world, and the three platform capabilities
 *  its systems need (the log sink, the "is a world running" gate, the native mouse capture). The point of
 *  the factory is ownership: the plugin knows which systems it has and how they are built. */
export interface PlayerWiring {
  readonly world: World;
  readonly log: (line: string) => void;
  readonly inWorld: () => boolean;
  readonly mouse: MouseCapture;
}

/** The six fixed-lane systems this plugin owns, constructed here. */
export function createPlayerSystems(w: PlayerWiring) {
  return {
    input: new PlayerInputSystem(w.world, w.log, w.inWorld, w.mouse),
    snapshot: new PositionSnapshotSystem(w.world),
    controller: new PlayerControllerSystem(w.world),
    movement: new PlayerMovementSystem(w.world),
    collision: new CollisionSystem(w.world),
    interaction: new BlockInteractionSystem(w.world),
  };
}

/** The plugin, built with the wiring the root owns: it CONSTRUCTS its six systems and DECLARES them
 *  (name, stage, edges, access, the run closure) — `boot/main.ts` no longer knows any of that. */
export function createPlayerPlugin(w: PlayerWiring) {
  const s = createPlayerSystems(w);
  const plugin = definePlugin({
    id: "player",
    deps: ["world", "input"],
    setup(api) {
      api.contribute(SLOT_COMPONENTS, [
      POSITION, PREV_POSITION, ORIENTATION, VIEW, MOTION, CONTROL, BODY, REACH, INTERACTION, INVENTORY,
      PLAYER, TARGET_HIT,
    ]);
      api.contribute(SLOT_RESOURCES, [LOCAL_PLAYER, INPUT_STATE, INPUT_TIMING, INPUT_INTENTS, INPUT_DIAGNOSTICS, POINTER]);
      api.contribute(SLOT_COMMANDS, [Teleport, SelectSlot, SwapSlots]);
      api.system({
  // The device layer: pointer-lock state machine + mouse/key/bind capture. The DOM listeners decide
  // nothing for the schedule — they queue intents (s.input.ts) — and its `after`/`before` edges below are
  // the REAL ones the conflict rule demands: it writes the VIEW the controller settles, and it reads
  // the ORIENTATION/POSITION/BODY the later systems write for its logs.
  //
  // The edge to `motion.snapshot` is a PESSIMISATION, and deliberately kept: the two commute (disjoint
  // writes), so this costs input its own batch 0 instead of sharing it with the s.snapshot. What it buys
  // is the property the docs state — the drain is the tick's first act — and it leaves the pair
  // `motion.snapshot ~ player.controller`, which the gate replays in both orders, exactly where it was.
  name: "player.input",
  stage: "fixed",
  before: ["motion.snapshot", "player.controller"],
  ...INPUT_ACCESS,
  run: () => s.input.step(),
      });
      api.system({
  name: "motion.snapshot",
  stage: "fixed",
  ...SNAPSHOT_ACCESS,
  run: () => s.snapshot.step(),
      });
      api.system({
  name: "player.controller",
  stage: "fixed",
  ...CONTROLLER_ACCESS,
  run: () => s.controller.step(),
      });
      api.system({
  // BOTH dependencies are real and both are declared: it reads the ORIENTATION that controller
  // writes, and it writes the POSITION that the snapshot had to freeze first. The old single edge
  // (controller after snapshot) ordered the snapshot against the camera instead of against this.
  name: "player.movement",
  stage: "fixed",
  after: ["player.controller", "motion.snapshot"],
  ...MOVEMENT_ACCESS,
  run: (ctx) => s.movement.step(ctx.dt),
      });
      api.system({
  name: "player.collision",
  stage: "fixed",
  after: ["player.movement"],
  ...COLLISION_ACCESS,
  run: () => s.collision.step(),
      });
      api.system({
  name: "player.interaction",
  stage: "fixed",
  after: ["player.collision"],
  ...INTERACTION_ACCESS,
  run: (ctx) => s.interaction.step(ctx.dt),
      });
    },
  });
  // The root still wires a few things straight to these (raw polling, the diagnostics forwarder), so the
  // construction is handed back with the plugin.
  return { plugin, systems: s };
}
