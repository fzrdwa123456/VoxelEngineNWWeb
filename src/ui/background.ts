// ===== Main-menu background mode: the pack's backgrounds/background.json picks static image/panorama =====
// Config sits next to the images (backgrounds/), overridden along the resource pack chain (user packs can swap the whole set).
// Decision chain:
//   mode=panorama and panorama.png exists -> "panorama" (sphere inner wall + slow camera spin, needs a dedicated render loop)
//   mode=static and mainmenu.png exists   -> "static"   (DOM full cover)
//   mode's image missing / no config / bad JSON / invalid value -> "checker" (magenta/black checkerboard)
//   (the static image's own in-chain fallback still goes through resolveTexture: mainmenu.png missing -> missing.png)
import { packsInstalled, resolveBytes } from "../rendering/textures";
import { defineResource, type Resource } from "../ecs/World";

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

/** The MEMO of that answer, as DATA. It used to be a module-level `let cached`; the object exists at
 *  import time (the menu frame and the view builder may ask before the World does) and the composition
 *  root INSERTS it as MENU_BG_KIND, so "which background this pack chain picked" is readable from the
 *  world instead of being invisible to everyone but this module. */
export interface MenuBgState {
  kind: MenuBgKind | null;
}

export const MENU_BG_KIND: Resource<MenuBgState> = defineResource<MenuBgState>("menuBgKind");

const state: MenuBgState = { kind: null };

/** The one instance, for the composition root to insert. */
export function menuBgState(): MenuBgState {
  return state;
}

export function menuBgKind(): MenuBgKind {
  if (state.kind) return state.kind;
  // Do NOT cache the answer until the packs are installed — the memo would otherwise record "checker"
  // forever. (On the normal path the menu frame runs only after boot; this just denies it the chance.)
  if (!packsInstalled()) return "checker";
  const mode = readMode();
  if (mode === "panorama") {
    state.kind = resolveBytes(PANORAMA_REL) ? "panorama" : "checker";  // Panorama missing = checkerboard
  } else if (mode === "static") {
    state.kind = resolveBytes(STATIC_REL) ? "static" : "checker";  // Static missing = checkerboard
  } else {
    state.kind = "checker";  // No config/bad JSON/invalid value = checkerboard
  }
  return state.kind;
}
