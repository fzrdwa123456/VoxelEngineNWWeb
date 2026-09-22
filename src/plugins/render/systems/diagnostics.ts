// ===== Diagnostics system (render lane, registered last before the draw) =====
// Owns everything that used to be a free function at the bottom of main.ts: the periodic PHYS log
// line, the incremental forwarding of the input system's diagnostic queues, the GPU timestamp read
// and the F3 panel refresh. It is a system like any other, so main.ts is wiring again instead of
// holding 45 lines of gameplay-adjacent logic.
//
// It READS the player's components directly (POSITION columns, CONTROL/MOTION records) and never
// writes anything: display only.
import type * as THREE from "three/webgpu";
import type { PerfSampler } from "../../../core/services/perf";
import { t } from "../../../data/assets/i18n";
import { BODY, CONTROL, MOTION, POSITION, type ControlC, type MotionC } from "../../player/components";
import { PERF_SAMPLER, RENDERER3D } from "../../../data/globals/gfx";
import {
  DEBUG_LOG,
  F3_PANEL,
  FPS_CAP,
  INPUT_DIAGNOSTICS,
  LOCAL_PLAYER,
  VOXEL,
  type DebugLogSink,
  type F3Panel,
  type FrameCapState,
  type InputDiagnostics,
} from "../../../data/globals/resources";
import { entityIndex, type SystemAccess, type World } from "../../../core/world";
import { setUiText, UI_STATE, UI_TEXT } from "../../ui/components";
import type { VoxelWorld } from "../../../data/world/world";

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
  reads: [POSITION, CONTROL, MOTION, BODY, UI_STATE],
  writes: [UI_TEXT],
  // …plus the LOCALE resource: the PHYS/log labels are translated with `t()` when it writes them.
  readsExternal: ["inputDiagnosticQueues", "voxelBlocks", "gpuTimestamps", "locale"],
  writesExternal: ["perfSampler", "debugLog"],
};

/** The F3 panel's contents. It is built here rather than in a view: the numbers ARE this system's
 *  output, and it used to hand them to `Hud.updateDebug()` — a render-lane system calling into a view,
 *  which is also why a change to the panel's layout could not be made without touching both. */
interface F3Stats {
  fps: number;
  fpsCap: number;
  x: number;
  y: number;
  z: number;
  chunks: number;
  /** null when the device does not support timestamp-query */
  gpuMs: number | null;
  mode: string;
  onGround: boolean;
  vy: number;
  feet: number;
  /** Nearest block top below; null when none */
  top: number | null;
  logs: Array<{ label: string; lines: string[] }>;
}

/** NO CONSTRUCTOR DEPENDENCIES ANY MORE. Everything this system touches is world state: the sampler, the
 *  renderer, the frame cap, the voxel world, the input diagnostic log and the F3 panel's two widget
 *  handles are all RESOURCES now, and the debug-log sink is one too (structurally typed, so the ECS needs
 *  no platform import). What used to be `DiagnosticsDeps` — a sampler, the HUD view, the GPU device, the
 *  log forwarder and another system's queues — was five constructor arguments, three of which were
 *  reachable from the world already. */
export class DiagnosticsSystem {
  private readonly index: number;
  private readonly voxel: VoxelWorld;
  private readonly frameCap: FrameCapState;
  private readonly control: ControlC;
  private readonly motion: MotionC;
  /** The frame-time sampler and the renderer whose timestamps feed it — RESOURCES (ecs/presentation.ts) */
  private readonly perf: PerfSampler;
  private readonly renderer: THREE.WebGPURenderer;
  /** The input system's SPACE/MOUSE log (it writes, this reads) and the log-file sink */
  private readonly diag: InputDiagnostics;
  private readonly debugLog: DebugLogSink;
  /** The F3 panel's widget handles, spawned by the HUD view during wiring */
  private readonly f3: F3Panel;

  constructor(private readonly world: World) {
    const player = world.resource(LOCAL_PLAYER);
    this.index = entityIndex(player);
    this.voxel = world.resource(VOXEL);
    this.frameCap = world.resource(FPS_CAP);
    this.perf = world.resource(PERF_SAMPLER);
    this.renderer = world.resource(RENDERER3D);
    this.diag = world.resource(INPUT_DIAGNOSTICS);
    this.debugLog = world.resource(DEBUG_LOG);
    this.f3 = world.resource(F3_PANEL);
    this.control = world.get(player, CONTROL)!;
    this.motion = world.get(player, MOTION)!;
  }

  /** Render lane, per frame. Samples once per perf window and returns until the window fills. */
  step(delta: number): void {
    const stats = this.perf.sample(delta);
    if (!stats) return;

    const index = this.index;
    const x = POSITION.x[index];
    const y = POSITION.y[index];
    const z = POSITION.z[index];
    const feet = y - BODY.eyeHeight[index];
    // Surface height of the voxel column under the player, or null when the column is empty
    const top = this.voxel.topSolidY(Math.floor(x), Math.floor(z), Math.floor(feet + 0.5));
    this.debugLog.line(
      `PHYS mode=${this.control.mode} ground=${this.motion.onGround} vy=${this.motion.vy.toFixed(2)} ` +
        `feet=${feet.toFixed(4)} top=${top === null ? "none" : top.toFixed(4)} ` +
        `gap=${top === null ? "-" : (feet - top).toFixed(4)} ` +
        `gapE=${top === null ? "-" : (feet - top).toExponential(2)} ` +
        `xyz=${x.toFixed(2)}/${y.toFixed(2)}/${z.toFixed(2)}`,
    );

    // Diagnostic queue incremental forwarding (SPACE/MOUSE, implemented in debuglog.ts)
    this.debugLog.forward(this.diag);

    // Read the real GPU render time (ms, last frame's total render pass), EMA-smoothed in perf.ts
    this.renderer
      .resolveTimestampsAsync("render")
      .then((ms) => {
        if (typeof ms === "number" && ms > 0) this.perf.noteGpu(ms);
      })
      .catch(() => {});

    // The F3 panel's text. Its VISIBILITY is the panel's own UI_STATE (ui.picker toggles it) — read here,
    // not mirrored into a field, because a second copy is how "the panel was toggled but the text kept
    // updating / went stale" happens.
    this.renderF3Panel({
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
        { label: t("f3.logMouse"), lines: this.diag.mouseLog },
        { label: t("f3.logSpace"), lines: this.diag.spaceLog },
      ],
    });
  }

  /** The F3 debug text: one preformatted string written into the panel's label widget. Moved here from
   *  the HUD view — the numbers are this system's output, and a render-lane system calling into a view was
   *  the last non-ECS edge in this file. */
  private renderF3Panel(info: F3Stats): void {
    if (this.world.get(this.f3.panel, UI_STATE)?.hidden !== false) return;
    const topFinite = info.top !== null && Number.isFinite(info.top);
    const topStr = topFinite ? (info.top as number).toFixed(4) : t("f3.none");
    const diff = topFinite ? (info.feet - (info.top as number)).toFixed(4) : "-";
    const diffE = topFinite ? (info.feet - (info.top as number)).toExponential(2) : "-";
    let text =
      `FPS: ${info.fps.toFixed(1)} (${t("f3.cap")} ${info.fpsCap === 0 ? t("f3.unlimited") : info.fpsCap})\n` +
      `XYZ: ${info.x.toFixed(2)} / ${info.y.toFixed(2)} / ${info.z.toFixed(2)}\n` +
      `${t("f3.chunks")}: ${info.chunks}\n` +
      (info.gpuMs !== null
        ? `GPU: ${info.gpuMs.toFixed(2)} ms ≈ ${t("f3.maxFps")} ${Math.round(1000 / info.gpuMs)} FPS\n`
        : `GPU: ${t("f3.gpuNa")}\n`) +
      `${t("f3.phys")}: ${t("f3.mode")}=${t(`mode.${info.mode}`)} ${t("f3.ground")}=${info.onGround} ` +
      `vy=${info.vy.toFixed(2)} feet=${info.feet.toFixed(4)} ${t("f3.top")}=${topStr} ` +
      `${t("f3.diff")}=${diff} ${t("f3.diffE")}=${diffE}\n`;
    for (const l of info.logs) {
      if (l.lines.length > 0) text += `${l.label}(${t("f3.recent")}${l.lines.length}):\n${l.lines.join("\n")}\n`;
    }
    setUiText(this.world, this.f3.body, text, true);
  }
}
