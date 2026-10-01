// ===== The RESOURCE PACK RELOAD driver (driver) =====
// Extracted from boot/main.ts in P1.18e. The root KEEPS only the seed it takes at startup (the snapshot a
// failed reload rolls back to) and the LOG SINK; everything else the driver needs is a world resource,
// and the listing poll's own state (deadline, in-flight flag, last signature) is now a CLOSURE here.
// The prose below is the original design note, kept with the code it explains.
import { installPacks, getEnabledPacks, updatePackListing, packChainGeneration, type PackListingPayload, type PackSnapshotPayload } from "../../data/assets/textures";
import { listPacksOnDisk, rescanPacks } from "../../host/desktop/packs";
import { readSettings } from "../../host/desktop/shell";
import { invalidateDictionaries, loadLang } from "../../data/assets/i18n";
import { declaredLanguages } from "../../data/assets/languages";
import { resetBlockRegistry, buildBlockRegistry, allBlockIds } from "../../data/assets/blockregistry";
import { discoverBlockEntries } from "../../data/assets/blocks";
import { refreshMenuBackground, menuBgKind } from "../../data/assets/background";
import { notifyConfigChange } from "../../core/services/bus";
import { CHUNK_MATERIAL, ICON_BAKE, MENU_BACKGROUND } from "../../data/globals/gfx";
import { UI_PAINT } from "../../data/globals/paint";
import { PACK_RELOAD, UI_MODAL, LOOP_STATE, type LoopState, type LocaleState } from "../../data/globals/resources";
import { SetLoadingStage, ShowToast } from "../../data/globals/commands";
import type { VoxelWorld } from "../../data/world/world";
import type { World } from "../../core/world";
import type { StageDriver } from "./stage";
import * as THREE from "three/webgpu";

/** What the reload reaches that the ROOT owns: the seed snapshot, the menu backdrop (a VIEW the root
 *  spawns) and the loop mode. Everything else is read from the world. */
export interface PackReloadDeps {
  readonly world: World;
  readonly log: (line: string) => void;
  readonly stage: StageDriver;
  readonly loop: LoopState;
  readonly locale: LocaleState;
  readonly voxel: VoxelWorld;
  readonly setLoopMode: (mode: "load" | "game" | "menu") => void;
  readonly refreshMenuBackdrop: () => void;
  /** The chain in force right now (null before the startup install): the rollback target. */
  readonly lastGoodSnapshot: () => PackSnapshotPayload | null;
  readonly noteSnapshot: (snap: PackSnapshotPayload) => void;
}

export interface PackReloadDriver {
  /** The per-frame check: at most ONE reload at a time, never started from inside a lane (F7, a pack
   *  toggle). And the pack page's live listing, which never installs anything. */
  maybeReload(): void;
  maybePollListing(): void;
}

export function createPackReloadDriver(deps: PackReloadDeps): PackReloadDriver {
// ===== The RESOURCE PACK RELOAD driver (P1.49ab) — Minecraft's resource reload, adapted =====
// WHAT IT COPIES FROM MC, in the order MC does it:
//   1. THE TRIGGER IS EXPLICIT AND THE REQUEST IS A FLAG. F7 (ui.navigation) only raises
//      `PACK_RELOAD.requested`; a per-frame check starts the driver — `Minecraft.pendingReload` + `runTick`,
//      not a tick state machine.
//   2. RESCAN AND REBUILD ARE TWO STEPS. `PackRepository.reload()` only re-walks the folders; loading the
//      resources is a separate act. Here: `rescanPacks()` re-reads `mods/` + `resourcepacks/` and returns a
//      fresh snapshot, then `installPacks` puts it in force.
//   3. THE CONTENT PHASE IS RE-RUN, then the caches are dropped — in that order, so nothing answers with the
//      previous chain's bytes afterwards.
//   4. THE WORLD IS NOT REBUILT. Success only marks every loaded chunk STALE, and the chunk stream re-resolves
//      their LOOKS in place, `RESTYLE_BUDGET_PER_FRAME` a frame (P1.18i) — MC's `allChanged()` -> "invalidate
//      compiled geometry" -> rebuild over the following frames, minus the rebuild: a new chain changes what a
//      block LOOKS like, while a mesh's vertices depend on the voxels alone (every uv is a per-face constant),
//      so the geometry survives a reload untouched and only its look -> material list is resolved again.
//   5. A FAILURE KEEPS THE OLD CHAIN: the previous snapshot is re-installed and re-derived before the error is
//      reported — MC's `rollbackResourcePacks`. Nothing is ever left half-applied.
//   6. THE PLAYER SEES AN OVERLAY, not a frozen frame: the LOADING SCREEN is raised through the same
//      `SetLoadingStage` command the startup and the world entry use, one announce-paint-yield per stage.
// WHAT IT DELIBERATELY DOES NOT COPY YET: MC's prepare/apply split across a worker pool (this engine is
// single-threaded by design, AGENTS.md iron rule 4) and MC's shared-state dependency graph between reload
// listeners (there is ONE producer here — the chain — so the order is written out below).

/** Re-derive everything the pack chain declares, in dependency order, and return a one-line summary.
 *  Reads whatever chain is in force; each step is the same call the startup makes. */
const rebuildDerivedFromChain = (): string => {
  // 1. the LANGUAGES the chain delivers, and the dictionaries built for them (the set is the cache key, and
  //    the invalidation is what makes a pack that only EDITED lang/zh.json take effect).
  invalidateDictionaries();
  const langLine = loadLang(deps.locale, readSettings().language, declaredLanguages());
  // 2. the BLOCK TABLE, from the entries the chain delivers (the content plugin's discovery, re-run).
  resetBlockRegistry();
  const blockLine = buildBlockRegistry(discoverBlockEntries());
  // 3. the PALETTE — merged, never replaced: a voxel stores a number (see VoxelWorld.mergePalette).
  const merged = deps.voxel.mergePalette(allBlockIds());
  return (
    `${langLine}; ${blockLine}; palette ${merged.total} block(s)` +
    (merged.added.length > 0 ? `, ${merged.added.length} new: [${merged.added.join(", ")}]` : "")
  );
}

/** Drop every cache that holds a RESULT derived from the chain. Called after the new chain is in force. */
const dropPackDerivedCaches = (): void => {
  // Chunk materials are cached per block LOOK and the key is the resolved texture path, so the map has to go:
  // the re-mesh asks again and resolves the new chain's images.
  const material = deps.world.resource(CHUNK_MATERIAL);
  for (const made of material.materials.values()) made.dispose();
  material.materials.clear();
  material.material?.dispose();
  material.material = null;
  // Baked block ICONS are pictures of block looks (the inventory and the hotbar read them). Clearing the cache
  // is only HALF of it — see the consumers' memory below, which is what decides whether a slot is drawn again.
  const icons = deps.world.resource(ICON_BAKE);
  icons.cache.clear();
  icons.pending.clear();
  // ===== THE CONSUMERS' MEMORY, not just the data (P1.49ac) =====
  // `ui.inventory` draws a slot only when its SIGNATURE changes, and that signature is "block type + count" — it
  // says nothing about the ICON. So after a reload it kept the previous chain's baked icon forever: no redraw,
  // and therefore no new bake either (the request lives at the END of the draw path). The sentinel below is the
  // same one `collectFinishedBakes` uses to force exactly one redraw, because no real signature equals "\u0000".
  const inventoryPaint = deps.world.resource(UI_PAINT).inventory;
  inventoryPaint.drawn.fill("\u0000");
  inventoryPaint.waiting.fill(0);
  // …and the surfaces that LIST the chain (the settings panel's pack rows: names + file counts) hear about the
  // new install through the config bus, the same way a value-composed label hears about its value changing.
  notifyConfigChange("packs");
  // The MENU BACKGROUND — TWO halves, because it is drawn two different ways (P1.49ab):
  //   * the PANORAMA is a three.js scene the menu frame renders. Drop it (so the next menu frame rebuilds it
  //     from the new chain) AND dispose its GPU objects first: dropping the reference alone leaks a texture,
  //     a geometry and a material per reload.
  //   * the IMAGE / checker backdrop is a WIDGET whose recipe and UI_IMAGE were decided when the menu was
  //     BUILT, so the view that owns them re-derives them — that is the bug this fixes: a reload used to leave
  //     the old picture up (the recipe still said `menu.backdropImage`, the URL was the previous chain's) and
  //     could not show the new one.
  // ONLY WHEN THE BACKDROP ITSELF CHANGED (P1.18g). Forgetting the memo and rebuilding unconditionally was
  // correct and cost a full texture rebuild every time: the sample panorama is 2.2 MB, so F7 — or toggling a
  // pack that ships no background at all — paid ~60-90 ms of base64 + PNG decode + GPU upload on the main
  // thread for a picture that had not changed. `refreshMenuBackground()` re-derives from the chain in force
  // and answers whether the kind OR the bytes behind it differ.
  const backdropChanged = refreshMenuBackground();
  if (backdropChanged) {
    const bg = deps.world.resource(MENU_BACKGROUND);
    if (bg.scene) {
      bg.scene.traverse((object) => {
        const drawable = object as THREE.Mesh;
        drawable.geometry?.dispose?.();
        const material = drawable.material as THREE.Material | THREE.Material[] | undefined;
        for (const one of Array.isArray(material) ? material : material ? [material] : []) {
          (one as THREE.MeshBasicMaterial).map?.dispose();
          one.dispose();
        }
      });
      bg.scene = null;
    }
    bg.camera = null;
    bg.appliedAspect = Number.NaN;
    deps.refreshMenuBackdrop();
  }
  deps.log(
    `PACKS menu backdrop ${backdropChanged ? "re-derived" : "kept (unchanged)"}: kind=${menuBgKind()}; ` +
      `inventory memory cleared (${inventoryPaint.drawn.length} slot signature(s)), ` +
      `chain gen ${packChainGeneration()}`,
  );
}

/** ONE reload, start to finish. Returns the summary line; throws when the reload AND its rollback failed. */
const reloadPacksNow = async (): Promise<string> => {
  const previous = deps.lastGoodSnapshot();
  try {
    // ---- 1. RESCAN: the folders, from Rust (stateless, so this really re-walks them) ----
    deps.stage.announce({ progress: 0.05, key: "loading.packs.scan" });
    await deps.stage.paint();
    const snap = await rescanPacks();
    // ---- 2. REBUILD: install the chain and re-run the content phase ----
    deps.stage.announce({ progress: 0.35, key: "loading.packs.build" });
    await deps.stage.paint();
    const chainLine = installPacks(snap, getEnabledPacks());
    const derivedLine = rebuildDerivedFromChain();
    // ---- 3. DROP the caches that hold the previous chain's results ----
    deps.stage.announce({ progress: 0.7, key: "loading.packs.apply" });
    await deps.stage.paint();
    dropPackDerivedCaches();
    // ---- 4. MARK THE WORLD STALE (do NOT rebuild or re-mesh it here) ----
    deps.stage.announce({ progress: 0.85, key: "loading.packs.mesh" });
    await deps.stage.paint();
    const stale = deps.voxel.markAllStale();
    deps.noteSnapshot(snap);
    return `${chainLine}; ${derivedLine}; ${stale} chunk(s) queued for a restyle (looks only, no re-mesh)`;
  } catch (err) {
    // ROLLBACK: put the last good chain back and re-derive from it, so a bad pack leaves the engine exactly
    // as it was (MC's rollbackResourcePacks) instead of half-swapped.
    if (previous) {
      installPacks(previous, getEnabledPacks());
      rebuildDerivedFromChain();
      dropPackDerivedCaches();
      deps.voxel.markAllStale();
      deps.noteSnapshot(previous);
    }
    throw err;
  }
}

/** The per-frame check: at most ONE reload at a time, and never started from inside a lane. */
const maybeReloadPacks = (): void => {
  const req = deps.world.resource(PACK_RELOAD);
  if (!req.requested || req.running) return;
  req.requested = false;
  req.running = true;
  const previousMode = deps.loop.mode;
  deps.setLoopMode("load"); // the loading screen is the overlay: nothing simulates or draws under it
  deps.world.commands.send(SetLoadingStage, { active: true, progress: 0, key: "loading.packs.scan" });
  void reloadPacksNow()
    .then((summary) => {
      req.count += 1;
      deps.log(`PACKS reloaded #${req.count}: ${summary}`);
      deps.world.commands.send(ShowToast, { key: `pack reload OK — ${summary}`, raw: true });
    })
    .catch((err) => {
      const why = String((err as Error)?.message || err);
      deps.log(`PACKS reload FAILED (the previous chain is still in force): ${why}`);
      deps.world.commands.send(ShowToast, { key: `pack reload FAILED — ${why}`, raw: true });
    })
    .finally(() => {
      // Take the screen down in the SAME ui lane the last stage painted in, then hand the mode back.
      deps.world.commands.send(SetLoadingStage, { active: false, progress: 1, key: "loading.ready" });
      deps.world.renderUi();
      req.running = false;
      deps.setLoopMode(previousMode);
    });
}

// ===== The PACK PAGE'S LIVE LISTING (P1.49ad) =====
// The pack screen follows the FOLDER while it is open, the way MC's does: a pack dropped into `resourcepacks/`
// appears, a deleted one goes, and a file added inside a pack updates its count. This is the CHEAP half of MC's
// split — `PackRepository.reload()` lists what is AVAILABLE without loading it — so it walks the directories
// only (Rust's `list_packs` opens no file) and it NEVER installs a chain: applying stays a decision, taken by
// the reload driver above (F7, entering a world, or toggling a pack, which is a selection change).
//
// MC puts the same poll in its pack SCREEN's tick, with a one-second debounce; the equivalent here is the
// per-frame check below, which does nothing at all unless that page is the selected settings section.
const PACK_LISTING_POLL_MS = 1000;
/** When the next poll is due. Reset to 0 when the page is closed, so RE-opening it lists at once. */
let listingNextAt = 0;
let listingInFlight = false;
/** A listing that arrived from Rust and has not been applied yet (an IPC result may not write module state from
 *  a promise continuation — it lands here and the next frame applies it, the `ICON_BAKE` shape). */
let listingResult: PackListingPayload | null = null;
/** The signature of the last listing the screen was told about, so an unchanged folder is silent. */
let listingLast = "";

const maybePollPackListing = (): void => {
  // 1. APPLY a listing that landed since the last frame, at a frame boundary.
  if (listingResult) {
    const listing = listingResult;
    listingResult = null;
    const signature = updatePackListing(listing, getEnabledPacks());
    if (signature !== listingLast) {
      listingLast = signature;
      deps.log(`PACKS listing from disk: ${signature === "" ? "(empty)" : signature}`);
      // The pack page re-renders on this (its `packs` subscription) — the list is PUSHED data, so a change has to
      // be announced rather than polled for by the view.
      notifyConfigChange("packs");
    }
  }
  // 2. POLL only while the pack page is up.
  if (deps.world.resource(UI_MODAL).settings !== "pack") {
    listingNextAt = 0;
    return;
  }
  const now = performance.now();
  if (listingInFlight || now < listingNextAt) return;
  listingInFlight = true;
  listingNextAt = now + PACK_LISTING_POLL_MS;
  listPacksOnDisk()
    .then((listing) => {
      listingResult = listing;
    })
    .catch(() => {
      // A failed listing keeps the previous one: it is a directory read, and there is nothing to tell the player.
    })
    .finally(() => {
      listingInFlight = false;
    });
}
  return { maybeReload: maybeReloadPacks, maybePollListing: maybePollPackListing };
}
