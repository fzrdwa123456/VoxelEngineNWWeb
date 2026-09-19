// ===== HUD: crosshair + F3 debug panel + toast =====
// These are WIDGETS now, not DOM: this class spawns four widget trees during wiring and afterwards only
// writes component data (text, visibility). The elements belong to ecs/ui/system.ts, so there is no
// createElement, no style string and no CSS literal left in this file.
//
// What is NOT here any more, and where it went: the F3 toggle and its `debugVisible` boolean (the
// panel's own UI_STATE.hidden is the state, and ecs/ui/picker.ts toggles it), and `showToast()` with its
// `setTimeout` (the message and its wall-clock deadline are the TOAST resource, armed by the ShowToast
// command and driven by ecs/ui/toast.ts). Both were "how long / whether" questions owned by a view.
//
// Note what disappeared with the DOM: `onLangChange(refresh)` — the reconciler re-derives every label
// from its i18n key once per frame, so a language switch needs no subscription anywhere.
import type { Entity, World } from "../ecs/World";
import { UI_STATE, setUiText, spawnLabel, spawnPanel } from "../ecs/ui/widgets";
import { t } from "./i18n";

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
  private readonly crosshair: Entity;
  private readonly debugPanel: Entity;
  private readonly debugBody: Entity;
  private readonly toast: Entity;
  private readonly toastBody: Entity;

  /** The toast widgets, for ecs/ui/toast.ts (the system that owns the message's lifetime) */
  get toastPanel(): Entity {
    return this.toast;
  }
  get toastText(): Entity {
    return this.toastBody;
  }
  /** The F3 panel, for ecs/ui/picker.ts (F3 alone toggles it; its UI_STATE IS the shown/hidden state) */
  get debugPanelEntity(): Entity {
    return this.debugPanel;
  }
  /** The crosshair root, for `ui.hud` — the system that hides the GAMEPLAY widgets while no world is
   *  running. It is spawned VISIBLE, like the hotbar, and nothing else writes its visibility. */
  get crosshairEntity(): Entity {
    return this.crosshair;
  }

  constructor(private readonly world: World) {
    // Crosshair: a centred box with two bars in it (the box centres them for us)
    const crosshair = spawnPanel(world, null, "hud.crosshair");
    this.crosshair = crosshair;
    spawnPanel(world, crosshair, "hud.crosshairH");
    spawnPanel(world, crosshair, "hud.crosshairV");

    // F3 debug panel: hidden until toggled, one preformatted text block inside it
    this.debugPanel = spawnPanel(world, null, "debug.panel", { hidden: true });
    this.debugBody = spawnLabel(world, this.debugPanel, "debug.line");

    // Toast: one panel + one text widget, put up and taken down by ecs/ui/toast.ts from the TOAST
    // resource (the message and its deadline are world state now — see the file header).
    this.toast = spawnPanel(world, null, "hud.toast", { hidden: true });
    this.toastBody = spawnLabel(world, this.toast, "text.label");
  }

  /** Called once per stats frame by ecs/systems/diagnostics.ts. Display only: it writes one text
   *  widget and never reads back from it. Whether it is SHOWN is the panel's own UI_STATE — read here,
   *  not mirrored into a field (a second copy is how "the panel was toggled but the text kept
   *  updating/went stale" happens). */
  updateDebug(info: DebugInfo): void {
    if (this.world.get(this.debugPanel, UI_STATE)?.hidden !== false) return;
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
    setUiText(this.world, this.debugBody, text, true);
  }
}
