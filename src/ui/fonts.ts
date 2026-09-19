// ===== Font switching: CSS variables --font-ui / --font-mono, takes effect immediately (no restart) =====
// Every UI's font shorthand references var(--font-ui) / var(--font-mono); changing these two variables swaps fonts globally.
//
// The font IN FORCE is a RESOURCE (`FONT`, see ecs/resources.ts); the FONTS table below is an asset (the
// two font pair definitions) and stays here.
import type { FontState } from "../ecs/resources";

export type FontId = "pixel" | "system";

interface FontDef {
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

/** Write the current font into the CSS variables (all UI reference var(); updates immediately) */
function applyFont(): void {
  const f = FONTS[fontOf()];
  document.documentElement.style.setProperty("--font-ui", f.ui);
  document.documentElement.style.setProperty("--font-mono", f.mono);
}

export function getFontId(): FontId {
  return fontOf();
}

export function setFontId(id: FontId): void {
  if (id === fontOf()) return;
  if (!state) adoptFont({ id });
  else state.id = id;
  applyFont();
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
  applyFont();
}