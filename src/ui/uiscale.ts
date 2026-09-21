// ===== Web-native UI scaling: DOM fluid rem layout =====
// The root font size (html font-size) scales proportionally with the viewport; all UI sizes/spacing are defined in rem ->
// on window changes the browser reflows, UI scales proportionally and text stays crisp (recommended by the web/Phaser communities).
// Baseline: 1rem = 16px at 1280x720. auto mode: k = min(viewportW/1280, viewportH/720).
// Fixed modes: small/normal/large = 0.75/1/1.5 multipliers.
//
// The mode IN FORCE is a RESOURCE (`UI_SCALE`, see ecs/resources.ts); the factors below are constants.
//
// ===== One Tauri/ECS change: this module no longer writes the DOM itself =====
// It used to own an `applyUIScale()` that assigned `documentElement.style.fontSize = ...` from
// `setUIScaleMode()`, `loadUIScaleMode()` and a resize callback. As in fonts.ts that is a side effect
// outside the system — unconditional, and unable to declare what it reads. It produces the VALUE only now
// (`currentRootFontPx()`), and the reconciler compares that against the value it last applied once per
// frame, so a resize needs no callback to "recompute and write" either: the next frame is the new value.
// (A resize listener + rAF coalescer for the settings panel's scale label used to sit here; the ONE window
//  listener lives in `platform/viewport.ts` now and this duplicate is deleted.)
import type { ScaleState } from "../ecs/resources";

export type UIScaleMode = "small" | "normal" | "large" | "auto";

const BASE_W = 1280;
const BASE_H = 720;
const FONT_MIN = 8;  // px, floor for readability even on extreme small windows
const FONT_MAX = 42;  // px, ceiling for large windows + large mode
const MODE_FACTOR: Record<Exclude<UIScaleMode, "auto">, number> = {
  small: 0.75,
  normal: 1,
  large: 1.5,
};

/** The UI_SCALE resource, adopted at boot (null only before `loadUIScaleMode`, e.g. in a test). */
let state: ScaleState | null = null;
const listeners = new Set<() => void>();

/** The scale mode in force, validated (the resource is typed `string`) */
function modeOf(): UIScaleMode {
  const m = state?.mode;
  return m === "small" || m === "normal" || m === "large" || m === "auto" ? m : "auto";
}

/** Current effective multiplier (auto follows the window live) */
function compute(): number {
  const fit = Math.min(window.innerWidth / BASE_W, window.innerHeight / BASE_H);
  const factor = modeOf() === "auto" ? 1 : MODE_FACTOR[modeOf() as Exclude<UIScaleMode, "auto">];
  return Math.max(FONT_MIN / 16, Math.min(factor * fit, FONT_MAX / 16));
}

/** The root font size the current mode + window size call for (1rem = 16px * multiplier).
 *  **This is the value; the DOM write is the reconciler's** — it compares this against what it last
 *  applied and only then touches `documentElement.style.fontSize`. */
export function currentRootFontPx(): number {
  return compute() * 16;
}

/** Current effective multiplier (shown in the settings panel) */
export function getCurrentScale(): number {
  return compute();
}

export function getUIScaleMode(): UIScaleMode {
  return modeOf();
}

/** Switch the mode: writes the RESOURCE only — the reconciler applies it on the next frame. */
export function setUIScaleMode(m: UIScaleMode): void {
  if (m === modeOf()) return;
  if (!state) adoptUIScale({ mode: m });
  else state.mode = m;
  listeners.forEach((cb) => cb());
}

export function onUIScaleModeChange(cb: () => void): void {
  listeners.add(cb);
}

/** Adopt the UI_SCALE resource (idempotent); exposed so the gate can drive this module standalone. */
export function adoptUIScale(scale: ScaleState): void {
  state = scale;
}

/** Load the scale mode from config at startup into the UI_SCALE resource (invalid values fall back to auto) */
export function loadUIScaleMode(scale: ScaleState, v: unknown): void {
  adoptUIScale(scale);
  if (v === "small" || v === "normal" || v === "large" || v === "auto") scale.mode = v;
}

// The UI MOUNT ROOT is not here any more. This module used to CREATE the stage div (`export const
// uiStage`) and append it to `document.body` at IMPORT time — a DOM side effect of a config module, on
// the one element the whole widget layer hangs off. It is world state like the canvas host, so the
// composition root creates it (`ecs/presentation.ts::createUiMount()`) and inserts it as UI_MOUNT, and
// the reconciler mounts its roots there.

// (The resize coalescer that used to sit here — a second `window` resize listener feeding the settings
//  panel's scale label — is GONE: the ONE listener lives in platform/viewport.ts and the label subscribes
//  through `onViewportChange` there. The root font size never needed either of them.)
