// ===== Font switching: CSS variables --font-ui / --font-mono, takes effect immediately (no restart) =====
// Every UI's font shorthand references var(--font-ui) / var(--font-mono); changing these two variables swaps fonts globally.
//
// The font IN FORCE is a RESOURCE (`FONT`, see ecs/resources.ts); the FONTS table below is an asset (the
// two font pair definitions) and stays here.
//
// ===== One Tauri/ECS change: this module no longer writes the DOM itself =====
// It used to own an `applyFont()` that called `documentElement.style.setProperty(...)` from `setFontId()`
// and `loadFont()`. That was a side effect **outside the system** — no barrier, no way to declare what it
// reads, and an unconditional DOM write on every call. The value still lives in the FONT resource, and the
// **DOM write moved to the one DOM writer, the reconciler (`ecs/ui/system.ts`)**, which compares the
// applied value against the resource's current one every frame and writes only when it changed.
// This module does two things only: it owns the value (the resource) and supplies this asset table
// (`currentFontCss()`).
import type { FontState } from "../ecs/resources";

export type FontId = "pixel" | "system";

export interface FontDef {
  ui: string;
  mono: string;
}

const FONTS: Record<FontId, FontDef> = {
  pixel: {
    ui: "'Fusion Pixel 12px Proportional SC',sans-serif",
    mono: "'Fusion Pixel 12px Monospaced SC',monospace",
  },
  system: {
    ui: "'Microsoft YaHei','PingFang SC','Noto Sans SC',sans-serif",
    mono: "Consolas,'Microsoft YaHei',monospace",
  },
};

/** The FONT resource, adopted at boot (null only before `loadFont`, e.g. in a test with no World). */
let state: FontState | null = null;

const listeners = new Set<() => void>();

/** The font in force, validated against the table (the resource is typed `string`) */
function fontOf(): FontId {
  return state?.id === "system" ? "system" : "pixel";
}

/** The CSS values for the font in force. **This is the value; the DOM write is the reconciler's.**
 *  The reconciler calls it every frame and only touches the two CSS variables when they change. */
export function currentFontCss(): FontDef {
  return FONTS[fontOf()];
}

export function getFontId(): FontId {
  return fontOf();
}

/** Switch the font: writes the RESOURCE only — the reconciler applies it on the next frame. */
export function setFontId(id: FontId): void {
  if (id === fontOf()) return;
  if (!state) adoptFont({ id });
  else state.id = id;
  listeners.forEach((cb) => cb());
}

export function onFontChange(cb: () => void): void {
  listeners.add(cb);
}

/** Adopt the FONT resource (idempotent); exposed so the gate can drive this module standalone. */
export function adoptFont(font: FontState): void {
  state = font;
}

/** Load the font from config at startup into the FONT resource (invalid values fall back to the pixel font) */
export function loadFont(font: FontState, v: unknown): void {
  adoptFont(font);
  if (v === "pixel" || v === "system") font.id = v;
}
