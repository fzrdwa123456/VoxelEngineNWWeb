// ===== Main-menu background mode: the pack's backgrounds/background.json picks static image/panorama =====
// Config sits next to the images (backgrounds/), overridden along the resource pack chain (user packs can swap the whole set).
// Decision chain:
//   mode=panorama and panorama.png exists -> "panorama" (sphere inner wall + slow camera spin, needs a dedicated render loop)
//   mode=static and mainmenu.png exists   -> "static"   (DOM full cover)
//   mode's image missing / no config / bad JSON / invalid value -> "checker" (magenta/black checkerboard)
//   (the static image's own in-chain fallback still goes through resolveTexture: mainmenu.png missing -> missing.png)
import { packsInstalled, resolveBytes } from "../rendering/textures";

export type MenuBgKind = "panorama" | "static" | "checker";

const CONFIG_REL = "backgrounds/background.json";
const PANORAMA_REL = "backgrounds/panorama.png";
const STATIC_REL = "backgrounds/mainmenu.png";

type MenuBgMode = "static" | "panorama";

/** Read the background config; null on missing file/bad JSON/invalid value (= straight to checker) */
function readMode(): MenuBgMode | null {
  const bytes = resolveBytes(CONFIG_REL);
  if (!bytes) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (parsed?.mode === "static" || parsed?.mode === "panorama") return parsed.mode;
  } catch {
        /* Bad file: treat as no config */
  }
  return null;
}

/** The effective background form (shared by mainmenu.ts's DOM layer and the menu frame's background
 *  step). MEMOISED: the answer is derived from the pack chain, which is scanned once per process, while
 *  the menu frame asks for it every frame — without the memo that would be a JSON.parse per frame. */
let cached: MenuBgKind | null = null;

export function menuBgKind(): MenuBgKind {
  if (cached) return cached;
  // 包还没装好时**不缓存**结论 —— 否则这个 memo 会把 "checker" 永久记下来。
  // （正常路径上菜单帧在 boot 之后才跑，这里只是不让它有机会记错。）
  if (!packsInstalled()) return "checker";
  const mode = readMode();
  if (mode === "panorama") {
    cached = resolveBytes(PANORAMA_REL) ? "panorama" : "checker";  // Panorama missing = checkerboard
  } else if (mode === "static") {
    cached = resolveBytes(STATIC_REL) ? "static" : "checker";  // Static missing = checkerboard
  } else {
    cached = "checker";  // No config/bad JSON/invalid value = checkerboard
  }
  return cached;
}
