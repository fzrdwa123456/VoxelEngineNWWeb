// ===== The pack chain's I/O: read the packs from Rust, hand the bytes to the data layer =====
// Reading the resource packs is a file operation, so it belongs to the BOUNDARY (this folder) and not to
// `data/assets/textures.ts`, which is now a pure byte store: `installPacks(bytes)` takes the snapshot and
// returns a summary line, `resolveTexture`/`resolveBytes` answer from memory, and nothing in it touches
// the disk.
//
// A failure is not fatal: the summary says so and every resolution then takes the engine fallback (the
// magenta/black checkerboard), which is why this only logs.
import { invoke } from "@tauri-apps/api/core";
import { adoptWarningSink, decodePackSnapshot, installPacks, type PackListingPayload, type PackSnapshotPayload } from "../../data/assets/textures";
import { logDebug, readSettings } from "./shell";

// The data module writes no log of its own: it calls the sink it was handed (this boundary owns the sink).
adoptWarningSink(logDebug);

/** WHICH PACKS EXIST ON DISK right now (P1.49ad) — names and file counts only; no file is opened and nothing is
 *  installed. Called once a second while the pack page is open, so the list follows the folder: a pack dropped
 *  into `resourcepacks/` appears, a deleted one goes.
 *
 *  It is deliberately NOT `rescanPacks()`: that one reads every file of every pack (the chain needs the bytes),
 *  which is far too much work to repeat while somebody is copying a folder into place — and APPLYING a chain is
 *  a decision, not a side effect of looking at the list. */
export async function listPacksOnDisk(): Promise<PackListingPayload> {
  return await invoke<PackListingPayload>("list_packs");
}

/** Re-read the pack folders NOW and hand back a fresh snapshot, WITHOUT installing it (P1.49ab).
 *
 *  Two callers need the raw snapshot rather than "install whatever is on disk":
 *   * the startup (which installs it and KEEPS it, so a reload can roll back to it);
 *   * the pack reload driver (which installs it itself, and on a later failure re-installs the previous one).
 *  The Rust side is stateless — `preload_packs` is `packs::snapshot_blob(&root)` — so a second call really
 *  does re-walk `mods/` and `resourcepacks/`; nothing about the chain is cached in Rust.
 *
 *  IT ANSWERS WITH **BYTES** (P1.18f): one binary body (`[u32 LE header length][header JSON][blob]`) that
 *  `decodePackSnapshot` turns into the engine's shape with zero-copy views. It used to be JSON whose every
 *  value was a base64 string, which this side decoded per byte on the MAIN thread — for a chain the reload
 *  reads in full, so the sample pack's 2.8 MB panorama was paid again on every F7. The command is `(async)`
 *  on the Rust side for the same reason: a sync command runs on the main thread. */
export async function rescanPacks(): Promise<PackSnapshotPayload> {
  const body = await invoke<ArrayBuffer>("preload_packs");
  return decodePackSnapshot(body);
}

/** Startup preload — UNUSED as of P1.49ab and kept only as the one-liner it always was: the boot now goes through
 *  `rescanPacks()` + `installPacks()` itself, because it has to KEEP the snapshot (a failed reload rolls back to
 *  it) and has to resolve the ENABLED list (P1.49ae) before installing. Use those two, not this. */
export async function preloadPacks(): Promise<void> {
  try {
    const snap = await rescanPacks();
    logDebug(installPacks(snap, readSettings().enabledPacks));
  } catch (e) {
    logDebug(`PACKS preload failed (engine fallbacks only): ${String(e)}`);
  }
}

/** Warn once when a resolution happens before the packs are in: the caller would otherwise cache the
 *  empty answer forever (that bug shipped once: dictionaries at zh=0 and the UI showing raw keys). */
export function warnPacksNotInstalled(): void {
  logDebug("PACKS not installed yet (preloadPacks() has not finished) — falling back to the engine's built-ins for this resolution, not caching it");
}
