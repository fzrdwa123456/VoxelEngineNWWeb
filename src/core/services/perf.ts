// ===== Performance sampling =====
// FPS stats (fixed window) + GPU render-time EMA smoothing, extracted from the main.ts render loop.

export interface PerfWindow {
    /** Average FPS within the window */
  fps: number;
    /** Latest GPU render time ms (EMA; null when timestamp-query is unsupported) */
  gpuMs: number | null;
}

export class PerfSampler {
  private fpsFrames = 0;
  private fpsTimer = 0;
  private gpuRenderMs = 0;
  private gpuSamples = 0;

    /** Per-frame call (delta seconds). Returns stats once the window fills and resets; null otherwise */
  sample(delta: number, windowSec = 0.5): PerfWindow | null {
    this.fpsTimer += delta;
    this.fpsFrames++;
    if (this.fpsTimer < windowSec) return null;
    const fps = this.fpsFrames / this.fpsTimer;
    this.fpsFrames = 0;
    this.fpsTimer = 0;
    return { fps, gpuMs: this.gpuSamples > 0 ? this.gpuRenderMs : null };
  }

  /** The GPU render time in force (EMA; null until the first sample, or when timestamp-query is unsupported).
   *  The `FRAME` line prints it next to `avg=`, which is what answers "is this frame CPU-bound or GPU-bound":
   *  a `gpu=` close to `avg=` is a GPU-bound frame, and a `gpu=` well under a large `avg=` means the main thread
   *  is what the frame is waiting on. */
  get gpuMs(): number | null {
    return this.gpuSamples > 0 ? this.gpuRenderMs : null;
  }

    /** Async GPU render-time collection (renderer.resolveTimestampsAsync callback), EMA-smoothed */
  noteGpu(ms: number): void {
    this.gpuSamples++;
    this.gpuRenderMs = this.gpuSamples === 1 ? ms : this.gpuRenderMs * 0.7 + ms * 0.3;
  }
}
