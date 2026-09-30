// Resource pack / mod scan — the counterpart of the "read the directory" half of the original
// NW.js build's rendering/textures.ts.
//
// The split is deliberate:
//   * Rust only does "list the directory + read file bytes" (the little Node's fs did); it does no
//     MC namespace normalisation at all;
//   * normalisation (assets/<ns>/textures/... -> block/dirt.png), priority and layering all stay in
//     TS, because that is already pure logic already covered by check:ecs, and moving it here would
//     only add risk.
//
// zip packs are **not** unpacked: Rust hands the raw zip bytes straight to the frontend — the
// frontend already has fflate (unzipSync), so the Rust side needs no extra dependency.
//
// The ordering is copied from TS too: entries in each directory are returned in **ascending name
// order**, and the TS side walks them back to front (later loads win).
use std::fs;
use std::path::Path;

use serde::Serialize;

/// Where one file's bytes live in the snapshot blob.
#[derive(Serialize)]
struct BlobRef {
    name: String,
    off: usize,
    len: usize,
}

/// One pack, as places in the blob (`zip` for a zip pack, `files` for a folder pack).
#[derive(Serialize, Default)]
struct BlobEntry {
    name: String,
    builtin: bool,
    files: Vec<BlobRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    zip: Option<BlobRef>,
}

/// What the front end parses out of the header, before it makes views into the blob.
#[derive(Serialize)]
struct BlobHeader {
    builtin: Option<BlobEntry>,
    mods: Vec<BlobEntry>,
    resourcepacks: Vec<BlobEntry>,
}

const BUILTIN_NAME: &str = "default.zip";

/// A folder pack's own `assets.zip` is SKIPPED, because that key is DEAD.
///
/// WHY: a folder pack is walked file by file and the front end normalises every name; `assets.zip`
/// normalises to itself, and nothing in the engine ever asks for that path (resolutions go through
/// `block/dirt.png`, `lang/zh.json`, ...). So its bytes were carried to the front end, encoded, parsed and
/// decoded on the main thread for nothing — and the sample resource pack's zip is **2.8 MB**, a copy of the
/// loose tree sitting next to it. A pack that shipped ONLY this zip resolved nothing before and resolves
/// nothing now; a zip at the pack ROOT is the zip-pack layout and goes through `read_entry` as before.
const DEAD_FOLDER_ZIP: &str = "assets.zip";

/// Recursively collects every file in a folder pack: the bytes go into `blob`, and the place they landed
/// goes into `out` (keys are joined with `/`, and the frontend normalises by the same rule).
fn walk(dir: &Path, base: &str, blob: &mut Vec<u8>, out: &mut Vec<BlobRef>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    let mut items: Vec<_> = entries.flatten().collect();
    items.sort_by_key(|e| e.file_name());
    for e in items {
        let name = e.file_name().to_string_lossy().to_string();
        let full = e.path();
        let rel = if base.is_empty() {
            name.clone()
        } else {
            format!("{base}/{name}")
        };
        match e.file_type() {
            Ok(t) if t.is_dir() => walk(&full, &rel, blob, out),
            Ok(_) => {
                if base.is_empty() && name == DEAD_FOLDER_ZIP {
                    continue;
                }
                if let Ok(bytes) = fs::read(&full) {
                    let off = blob.len();
                    let len = bytes.len();
                    blob.extend_from_slice(&bytes);
                    out.push(BlobRef { name: rel, off, len });
                }
            }
            Err(_) => {}
        }
    }
}

fn read_entry(full: &Path, name: &str, builtin: bool, blob: &mut Vec<u8>) -> BlobEntry {
    let mut entry = BlobEntry {
        name: name.to_string(),
        builtin,
        ..Default::default()
    };
    if full.is_dir() {
        walk(full, "", blob, &mut entry.files);
    } else if let Ok(bytes) = fs::read(full) {
        let off = blob.len();
        let len = bytes.len();
        blob.extend_from_slice(&bytes);
        entry.zip = Some(BlobRef {
            name: name.to_string(),
            off,
            len,
        });
    }
    entry
}

/// Scans one directory: skips the builtin pack name and returns ascending name order (both folder
/// packs and .zip files count)
fn scan_dir(dir: &Path, skip_builtin: bool, blob: &mut Vec<u8>) -> Vec<BlobEntry> {
    let mut out = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return out,
    };
    let mut items: Vec<_> = entries.flatten().collect();
    items.sort_by_key(|e| e.file_name());
    for e in items {
        let name = e.file_name().to_string_lossy().to_string();
        if skip_builtin && name == BUILTIN_NAME {
            continue;
        }
        let full = e.path();
        let is_zip = name.to_ascii_lowercase().ends_with(".zip");
        if full.is_dir() || is_zip {
            out.push(read_entry(&full, &name, false, blob));
        }
    }
    out
}

/// The complete pack snapshot (the original scanPacks()'s three sources, in the same order) as ONE binary
/// body: `[u32 LE header length][header JSON][blob]`.
///
/// WHY BYTES AND NOT JSON+base64: the walk used to encode every file into a JSON string, which cost +33% on
/// the wire and made the front end `atob` + loop over every byte ON ITS MAIN THREAD — and the reload re-reads
/// the whole chain, so the sample pack's 2.8 MB panorama was paid again on every F7. The front end now makes
/// zero-copy views into this buffer (`decodePackSnapshot`).
pub fn snapshot_blob(game_root: &Path) -> Vec<u8> {
    let packs_dir = game_root.join("resourcepacks");
    let mods_dir = game_root.join("mods");
    let mut blob: Vec<u8> = Vec::new();

    let builtin_file = packs_dir.join(BUILTIN_NAME);
    let builtin = if builtin_file.is_file() {
        Some(read_entry(&builtin_file, BUILTIN_NAME, true, &mut blob))
    } else {
        None
    };
    let mods = scan_dir(&mods_dir, false, &mut blob);
    let resourcepacks = scan_dir(&packs_dir, true, &mut blob);

    let header = serde_json::to_vec(&BlobHeader {
        builtin,
        mods,
        resourcepacks,
    })
    .unwrap_or_else(|_| b"{}".to_vec());

    let mut out = Vec::with_capacity(4 + header.len() + blob.len());
    out.extend_from_slice(&(header.len() as u32).to_le_bytes());
    out.extend_from_slice(&header);
    out.extend_from_slice(&blob);
    out
}

// ===== The LISTING: which packs exist on disk right now (P1.49ad) =====
// The pack SCREEN has to follow the folder while it is open — a pack dropped in appears, a deleted one goes —
// and doing that with `preload_packs` would mean reading (and base64-ing) every file of every pack once a
// second. This is the cheap half of MC's split: `PackRepository.reload()` lists what is AVAILABLE without
// loading it, and only `createReload` actually reads the resources.
//
// So this walk reads NAMES and counts files; it never opens one. `file_count` is therefore EXACT for a folder
// pack and -1 for a .zip (counting a zip's entries would mean unpacking it) — the frontend shows a negative
// count as blank, which is the same thing it already does for a switched-off pack.
#[derive(Serialize)]
pub struct PackListingEntry {
    pub name: String,
    pub builtin: bool,
    /// Folder pack: how many files it holds. Zip pack: -1 (never opened).
    #[serde(rename = "fileCount")]
    pub file_count: i64,
    /// Is it a .zip? (the frontend only uses this for the log line)
    pub zip: bool,
}

#[derive(Serialize)]
pub struct PackListing {
    /// The built-in pack, when it is on disk (name + the same fields as the others).
    pub builtin: Option<PackListingEntry>,
    pub mods: Vec<PackListingEntry>,
    pub resourcepacks: Vec<PackListingEntry>,
}

/// Count the files under `dir` WITHOUT reading any of them.
fn count_files(dir: &Path) -> i64 {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return 0,
    };
    let mut n = 0i64;
    for e in entries.flatten() {
        match e.file_type() {
            Ok(t) if t.is_dir() => n += count_files(&e.path()),
            Ok(_) => n += 1,
            Err(_) => {}
        }
    }
    n
}

fn listing_entry(full: &Path, name: &str, builtin: bool) -> PackListingEntry {
    let is_dir = full.is_dir();
    PackListingEntry {
        name: name.to_string(),
        builtin,
        file_count: if is_dir { count_files(full) } else { -1 },
        zip: !is_dir,
    }
}

/// The packs that exist on disk right now, in the same order and with the same filters as `snapshot`.
pub fn listing(game_root: &Path) -> PackListing {
    let packs_dir = game_root.join("resourcepacks");
    let mods_dir = game_root.join("mods");

    let list_dir = |dir: &Path, skip_builtin: bool| -> Vec<PackListingEntry> {
        let mut out = Vec::new();
        let entries = match fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return out,
        };
        let mut items: Vec<_> = entries.flatten().collect();
        items.sort_by_key(|e| e.file_name());
        for e in items {
            let name = e.file_name().to_string_lossy().to_string();
            if skip_builtin && name == BUILTIN_NAME {
                continue;
            }
            let full = e.path();
            let is_zip = name.to_ascii_lowercase().ends_with(".zip");
            if full.is_dir() || is_zip {
                out.push(listing_entry(&full, &name, false));
            }
        }
        out
    };

    PackListing {
        builtin: if packs_dir.join(BUILTIN_NAME).is_file() {
            Some(listing_entry(&packs_dir.join(BUILTIN_NAME), BUILTIN_NAME, true))
        } else {
            None
        },
        mods: list_dir(&mods_dir, false),
        resourcepacks: list_dir(&packs_dir, true),
    }
}
