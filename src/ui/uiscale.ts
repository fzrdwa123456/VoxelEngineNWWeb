// ===== Web-native UI scaling: DOM fluid rem layout =====
// The root font size (html font-size) scales proportionally with the viewport; all UI sizes/spacing are defined in rem ->
// on window changes the browser reflows, UI scales proportionally and text stays crisp (recommended by the web/Phaser communities).
// Baseline: 1rem = 16px at 1280x720. auto mode: k = min(viewportW/1280, viewportH/720).
// Fixed modes: small/normal/large = 0.75/1/1.5 multipliers.
//
// The mode IN FORCE is a RESOURCE (`UI_SCALE`, see ecs/resources.ts); the factors below are constants.
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

/** UI mount root: all components mount here (fixed elements inside the stage are viewport-positioned, sized by rem, no transform needed) */
export const uiStage = document.createElement("div");
uiStage.style.cssText = "position:fixed;inset:0;overflow:hidden;z-index:1;";
document.body.appendChild(uiStage);

/** Current effective multiplier (auto follows the window live) */
function compute(): number {
  const fit = Math.min(window.innerWidth / BASE_W, window.innerHeight / BASE_H);
  const factor = modeOf() === "auto" ? 1 : MODE_FACTOR[modeOf() as Exclude<UIScaleMode, "auto">];
  return Math.max(FONT_MIN / 16, Math.min(factor * fit, FONT_MAX / 16));
}

/** Update the root font size for the current mode + window size (1rem = 16px * multiplier) */
export function applyUIScale(): void {
  document.documentElement.style.fontSize = `${compute() * 16}px`;
}

/** Current effective multiplier (shown in the settings panel) */
export function getCurrentScale(): number {
  return compute();
}

export function getUIScaleMode(): UIScaleMode {
  return modeOf();
}

export function setUIScaleMode(m: UIScaleMode): void {
  if (m === modeOf()) return;
  if (!state) adoptUIScale({ mode: m });
  else state.mode = m;
  applyUIScale();
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

// Resize coalescing: continuous scaling fires resize at high frequency; coalesce into rAF (at most once per frame)
const resizeCbs = new Set<() => void>();
let resizeScheduled = false;
window.addEventListener("resize", () => {
  if (resizeScheduled) return;
  resizeScheduled = true;
  requestAnimationFrame(() => {
    resizeScheduled = false;
    resizeCbs.forEach((cb) => cb());
  });
});

/** Register the window-scale handler (coalesced into rAF; high-frequency resize runs at most once per frame) */
export function onResizeMerged(cb: () => void): void {
  resizeCbs.add(cb);
}

// Update the root font size live on window resize
onResizeMerged(() => applyUIScale());