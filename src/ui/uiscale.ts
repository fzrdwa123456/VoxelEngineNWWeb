// ===== Web-native UI scaling: DOM fluid rem layout =====
// The root font size (html font-size) scales proportionally with the viewport; all UI sizes/spacing are defined in rem ->
// on window changes the browser reflows, UI scales proportionally and text stays crisp (recommended by the web/Phaser communities).
// Baseline: 1rem = 16px at 1280x720. auto mode: k = min(viewportW/1280, viewportH/720).
// Fixed modes: small/normal/large = 0.75/1/1.5 multipliers.
//
// The mode IN FORCE is a RESOURCE (`UI_SCALE`, see ecs/resources.ts); the factors below are constants.
//
// ===== Tauri/ECS 化的一处改动：这个模块不再自己写 DOM =====
// 以前这里有个 `applyUIScale()`：`setUIScaleMode()` / `loadUIScaleMode()` / 一个 resize 回调里
// 直接 `documentElement.style.fontSize = ...`。同 fonts.ts：那是系统之外的副作用，而且是无条件写。
// 现在只提供**值**（`currentRootFontPx()`），写 DOM 的活由协调器每帧比对后做 ——
// 于是 resize 也不需要单独的回调来"重算并写入"，下一帧自然就是新值。
// （这里原本还留着一个 resize 监听 + rAF 合并器，给设置面板那行缩放标签用；现在那唯一的窗口监听
//  搬去了 `platform/viewport.ts`，这份重复的已经删掉。）
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

// (The resize coalescer that used to sit here — a second `window` resize listener feeding the settings
//  panel's scale label — is GONE: the ONE listener lives in platform/viewport.ts and the label subscribes
//  through `onViewportChange` there. The root font size never needed either of them.)
