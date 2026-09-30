// ===== Main-menu background mode: the pack's backgrounds/background.json picks static image/panorama =====
// Config sits next to the images (backgrounds/), overridden along the resource pack chain (user packs can swap the whole set).
// Decision chain:
//   mode=panorama and panorama.png exists -> "panorama" (sphere inner wall + slow camera spin, needs a dedicated render loop)
//   mode=static and mainmenu.png exists   -> "static"   (DOM full cover)
//   mode's image missing / no config / bad JSON / invalid value -> "checker" (magenta/black checkerboard)
//   (the static image's own in-chain fallback still goes through resolveTexture: mainmenu.png missing -> missing.png)
import { packsInstalled, resolveBytes } from "./textures";
import { defineResource, type Resource } from "../../core/world";

export type MenuBgKind = "panorama" | "static" | "checker";

const CONFIG_REL = "backgrounds/background.json";
/** The panorama's path, EXPORTED because the system that draws it loads its BYTES (a Blob URL) rather than a
 *  `data:` URL — see `plugins/render/systems/menu-background.ts` (P1.18g). */
export const PANORAMA_REL = "backgrounds/panorama.png";
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
 *  world instead of being invisible to everyone but this module.
 *
 *  `signature` is WHAT THE BACKDROP WAS BUILT FROM (P1.18g): the kind plus a hash of the image that kind
 *  draws. It exists so a pack reload can ask "is the backdrop I already have still the right one?" and skip
 *  the rebuild — see `refreshMenuBackground`. */
export interface MenuBgState {
  kind: MenuBgKind | null;
  signature: string;
}

export const MENU_BG_KIND: Resource<MenuBgState> = defineResource<MenuBgState>("menuBgKind");

const state: MenuBgState = { kind: null, signature: "" };

/** The one instance, for the composition root to insert. */
export function menuBgState(): MenuBgState {
  return state;
}

/** FNV-1a (32-bit) over the bytes: the honest answer to "are these the same bytes?".
 *
 *  WHY A HASH AND NOT JUST THE LENGTH: a same-size edit would fool a length check, and the thing this
 *  guards is a 2.2 MB panorama whose rebuild costs ~60-90 ms (base64 into a `data:` URL, PNG decode, GPU
 *  upload) on the main thread, every reload. Hashing 2.8 MB of pixels costs a couple of milliseconds, which
 *  is the whole trade. */
function hashBytes(bytes: Uint8Array | null): string {
  if (!bytes) return "-";
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/** What the backdrop of this `kind` is drawn FROM: the file it resolves, by content. */
function signatureOf(kind: MenuBgKind): string {
  if (kind === "panorama") return `panorama:${hashBytes(resolveBytes(PANORAMA_REL))}`;
  if (kind === "static") return `static:${hashBytes(resolveBytes(STATIC_REL))}`;
  return "checker";
}

/** Re-derive the answer from the chain in force and report whether the BACKDROP ITSELF changed (P1.18g).
 *
 *  The pack reload driver used to forget the memo unconditionally and rebuild: correct, and it cost a full
 *  2.2 MB texture rebuild on EVERY reload — including the ones where nothing about the backdrop had changed
 *  (F7, or toggling a pack that ships no background at all). Now the driver asks this instead, disposes and
 *  re-derives only when it answers true.
 *
 *  Returns true when the kind or the bytes behind it differ from what the current memo was made from. The
 *  first call after boot compares against an empty memo, so the first reload of a session always rebuilds —
 *  conservative on purpose. */
export function refreshMenuBackground(): boolean {
  const before = `${state.kind}|${state.signature}`;
  state.kind = null; // forget, so `menuBgKind()` re-derives (and re-signs) from the chain in force
  const kind = menuBgKind();
  return `${kind}|${state.signature}` !== before;
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
  state.signature = signatureOf(state.kind);
  return state.kind;
}
