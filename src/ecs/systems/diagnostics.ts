// ===== Diagnostics system (render lane, registered last before the draw) =====
// Owns everything that used to be a free function at the bottom of main.ts: the periodic PHYS log
// line, the incremental forwarding of the input system's diagnostic queues, the GPU timestamp read
// and the F3 panel refresh. It is a system like any other, so main.ts is wiring again instead of
// holding 45 lines of gameplay-adjacent logic.
//
// It READS the player's components directly (POSITION columns, CONTROL/MOTION records) and never
// writes anything: display only.
import type * as THREE from "three/webgpu";
import type { DebugLogForwarder } from "../../platform/debuglog";
import type { PerfSampler } from "../../platform/perf";
import { t } from "../../ui/i18n";
import type { Hud } from "../../ui/hud";
import { BODY, CONTROL, MOTION, POSITION, type ControlC, type MotionC } from "../components/Player";
import { FPS_CAP, LOCAL_PLAYER, VOXEL, type FrameCapState } from "../resources";
import { entityIndex, type SystemAccess, type World } from "../World";
import { UI_TEXT } from "../ui/widgets";
import type { VoxelWorld } from "../../voxel/world";

/** Declared access. Display only: it reads component data and writes the F3 panel's TEXT WIDGET —
 *  which is what forces `ui.widgets` to be ordered after it (both touch UI_TEXT). It no longer writes
 *  the DOM at all: the reconciler does that.
 *
 *  THE EXTERNAL TARGETS ARE PART OF THE DECLARATION, and this one used to lie: it claimed only
 *  `perfSampler` while it also reads the input system's diagnostic queues, reads the block world (for
 *  `top` and the loaded chunk count), reads the GPU's last render timestamp and writes the debug log.
 *  A declared target costs nothing when nobody else claims it (this file is in the render lane and no
 *  same-stage system writes any of them, so no edge is created); an UNDECLARED one is invisible to the
 *  conflict rule, which is the one mistake the scheduler structurally cannot catch.
 *
 *  The FPS cap is NOT in that list any more: it is a RESOURCE (FPS_CAP) now, and resources are shared
 *  state with one owner rather than an external target — the schedule does not model them at all (see
 *  the "Component or resource?" rule in AGENTS.md). It got there because it is read by the frame gate
 *  every frame AND printed here; a closure variable in main.ts could serve neither honestly. */
export const DIAGNOSTICS_ACCESS: SystemAccess = {
  reads: [POSITION, CONTROL, MOTION, BODY],
  writes: [UI_TEXT],
  // …plus the LOCALE resource: the PHYS/log labels are translated with `t()` when it writes them.
  readsExternal: ["inputDiagnosticQueues", "voxelBlocks", "gpuTimestamps", "locale"],
  writesExternal: ["perfSampler", "debugLog"],
};

/** Non-ECS dependencies: the samplers, the HUD and the GPU device. All presentation, none of it
 *  entity data, so they are constructor arguments rather than components. */
export interface DiagnosticsDeps {
  readonly perf: PerfSampler;
  readonly hud: Hud;
  readonly renderer: THREE.WebGPURenderer;
  readonly debugLog: DebugLogForwarder;
  /** The input system's SPACE/MOUSE queues (structural type — this file does not import that system).
   *  Mutable arrays because the HUD renders them into the F3 panel; debuglog.forward() takes them as
   *  readonly. */
  readonly queues: { spaceLog: string[]; mouseLog: string[] };
  readonly logDebug: (line: string) => void;
}

export class DiagnosticsSystem {
  private readonly index: number;
  private readonly voxel: VoxelWorld;
  private readonly frameCap: FrameCapState;
  private readonly control: ControlC;
  private readonly motion: MotionC;

  constructor(
    private readonly world: World,
    private readonly deps: DiagnosticsDeps,
  ) {
    const player = world.resource(LOCAL_PLAYER);
    this.index = entityIndex(player);
    this.voxel = world.resource(VOXEL);
    this.frameCap = world.resource(FPS_CAP);
    this.control = world.get(player, CONTROL)!;
    this.motion = world.get(player, MOTION)!;
  }

  /** Render lane, per frame. Samples once per perf window and returns until the window fills. */
  step(delta: number): void {
    const stats = this.deps.perf.sample(delta);
    if (!stats) return;

    const index = this.index;
    const x = POSITION.x[index];
    const y = POSITION.y[index];
    const z = POSITION.z[index];
    const feet = y - BODY.eyeHeight[index];
    // Surface height of the voxel column under the player, or null when the column is empty
    const top = this.voxel.topSolidY(Math.floor(x), Math.floor(z), Math.floor(feet + 0.5));
    this.deps.logDebug(
      `PHYS mode=${this.control.mode} ground=${this.motion.onGround} vy=${this.motion.vy.toFixed(2)} ` +
        `feet=${feet.toFixed(4)} top=${top === null ? "none" : top.toFixed(4)} ` +
        `gap=${top === null ? "-" : (feet - top).toFixed(4)} ` +
        `gapE=${top === null ? "-" : (feet - top).toExponential(2)} ` +
        `xyz=${x.toFixed(2)}/${y.toFixed(2)}/${z.toFixed(2)}`,
    );

    // Diagnostic queue incremental forwarding (SPACE/MOUSE, implemented in debuglog.ts)
    this.deps.debugLog.forward(this.deps.queues);

    // Read the real GPU render time (ms, last frame's total render pass), EMA-smoothed in perf.ts
    this.deps.renderer
      .resolveTimestampsAsync("render")
      .then((ms) => {
        if (typeof ms === "number" && ms > 0) this.deps.perf.noteGpu(ms);
      })
      .catch(() => {});

    // F3 debug panel (Hud shows it on demand internally)
    this.deps.hud.updateDebug({
      fps: stats.fps,
      fpsCap: this.frameCap.cap,
      x,
      y,
      z,
      chunks: this.voxel.loadedChunkCount,
      gpuMs: stats.gpuMs,
      mode: this.control.mode,
      onGround: this.motion.onGround,
      vy: this.motion.vy,
      feet,
      top,
      logs: [
        { label: t("f3.logMouse"), lines: this.deps.queues.mouseLog },
        { label: t("f3.logSpace"), lines: this.deps.queues.spaceLog },
      ],
    });
  }
}
