// ===== The pack chain's I/O: read the packs from Rust, hand the bytes to the data layer =====
// Reading the resource packs is a file operation, so it belongs to the BOUNDARY (this folder) and not to
// `data/assets/textures.ts`, which is now a pure byte store: `installPacks(bytes)` takes the snapshot and
// returns a summary line, `resolveTexture`/`resolveBytes` answer from memory, and nothing in it touches
// the disk.
//
// A failure is not fatal: the summary says so and every resolution then takes the engine fallback (the
// magenta/black checkerboard), which is why this only logs.
import { invoke } from "@tauri-apps/api/core";
import { adoptWarningSink, installPacks, type PackSnapshotPayload } from "../../data/assets/textures";
import { logDebug, readSettings } from "./shell";

// The data module writes no log of its own: it calls the sink it was handed (this boundary owns the sink).
adoptWarningSink(logDebug);

/** Startup preload: awaited once at the top of main.ts (the Tauri IPC is asynchronous, while every
 *  resolution afterwards has to stay synchronous — see the note in the data module). */
export async function preloadPacks(): Promise<void> {
  try {
    const snap = await invoke<PackSnapshotPayload>("preload_packs");
    // The DISABLED list comes from settings.json (P1.49aa). That is why the boot loads the SHELL before the
    // packs: the chain has to know what the user switched off before anything derives an asset from it.
    logDebug(installPacks(snap, readSettings().disabledPacks));
  } catch (e) {
    logDebug(`PACKS preload failed (engine fallbacks only): ${String(e)}`);
  }
}

/** Warn once when a resolution happens before the packs are in: the caller would otherwise cache the
 *  empty answer forever (that bug shipped once: dictionaries at zh=0 and the UI showing raw keys). */
export function warnPacksNotInstalled(): void {
  logDebug("PACKS not installed yet (preloadPacks() has not finished) — falling back to the engine's built-ins for this resolution, not caching it");
}
