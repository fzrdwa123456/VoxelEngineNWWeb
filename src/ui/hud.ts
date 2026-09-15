// ===== HUD: crosshair + F3 debug panel + bottom toast (pure DOM, no external dependencies) =====
import { t } from "./i18n";
import { uiStage } from "./uiscale";

export interface DebugLog {
  label: string;
  lines: string[];
}

export interface DebugInfo {
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
  logs: DebugLog[];
}

export class Hud {
  private debugVisible = false;
  private readonly debug: HTMLDivElement;
  private toastTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly toast: HTMLDivElement;

  constructor() {
        // Crosshair (DOM HUD)
    const hud = document.createElement("div");
    hud.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:10;";
    const hLine = document.createElement("div");
    hLine.style.cssText =
      "position:absolute;left:50%;top:50%;width:1.25rem;height:0.125rem;background:#fff;transform:translate(-50%,-50%);box-shadow:0 0 0.125rem rgba(0,0,0,.8);";
    const vLine = document.createElement("div");
    vLine.style.cssText =
      "position:absolute;left:50%;top:50%;width:0.125rem;height:1.25rem;background:#fff;transform:translate(-50%,-50%);box-shadow:0 0 0.125rem rgba(0,0,0,.8);";
    hud.append(hLine, vLine);
    uiStage.appendChild(hud);

        // F3 debug panel (hidden by default)
    this.debug = document.createElement("div");
    this.debug.style.cssText =
      "position:fixed;top:0.5rem;left:0.5rem;z-index:20;color:#fff;font:0.75rem/1.7 var(--font-mono);background:rgba(0,0,0,.55);padding:0.375rem 0.625rem;border-radius:0.25rem;display:none;white-space:pre;";
    uiStage.appendChild(this.debug);

        // Bottom centered toast: feedback for settings actions, auto-dismisses after ~2.5s
    this.toast = document.createElement("div");
    this.toast.style.cssText =
      "position:fixed;left:50%;bottom:3.75rem;transform:translateX(-50%);z-index:60;color:#fff;" +
      "font:0.875rem/1.6 var(--font-ui);background:rgba(0,0,0,.8);padding:0.5rem 1.125rem;border-radius:0.375rem;" +
      "display:none;max-width:80vw;text-align:center;white-space:pre-wrap;";
    uiStage.appendChild(this.toast);
  }

  toggleDebug(): void {
    this.debugVisible = !this.debugVisible;
    this.debug.style.display = this.debugVisible ? "block" : "none";
  }

  showToast(msg: string): void {
    if (this.toastTimer !== undefined) clearTimeout(this.toastTimer);
    this.toast.textContent = msg;
    this.toast.style.display = "block";
    this.toastTimer = setTimeout(() => {
      this.toast.style.display = "none";
    }, 2500);
  }

  updateDebug(info: DebugInfo): void {
    if (!this.debugVisible) return;
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
    this.debug.textContent = text;
  }
}