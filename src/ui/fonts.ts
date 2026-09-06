// ===== Font switching: CSS variables --font-ui / --font-mono, takes effect immediately (no restart) =====
// Every UI's font shorthand references var(--font-ui) / var(--font-mono); changing these two variables swaps fonts globally.

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

let current: FontId = "pixel";
const listeners = new Set<() => void>();

/** Write the current font into the CSS variables (all UI reference var(); updates immediately) */
function applyFont(): void {
  const f = FONTS[current];
  document.documentElement.style.setProperty("--font-ui", f.ui);
  document.documentElement.style.setProperty("--font-mono", f.mono);
}

export function getFontId(): FontId {
  return current;
}

export function setFontId(id: FontId): void {
  if (id === current) return;
  current = id;
  applyFont();
  listeners.forEach((cb) => cb());
}

export function onFontChange(cb: () => void): void {
  listeners.add(cb);
}

/** Load the font from config at startup (invalid values fall back to the pixel font) */
export function loadFont(v: unknown): void {
  if (v === "pixel" || v === "system") current = v;
  applyFont();
}