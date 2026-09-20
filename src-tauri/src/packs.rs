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
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use base64::Engine;
use serde::Serialize;

/// A pack: either a folder pack (files has content) or a zip pack (zipB64 has content)
#[derive(Serialize, Default)]
pub struct PackEntry {
    pub name: String,
    pub builtin: bool,
    /// Folder pack: relative path (as-is, with either forward or back slashes — the frontend
    /// normalises it) -> base64 bytes
    pub files: BTreeMap<String, String>,
    /// Zip pack: base64 of the whole zip (the frontend unpacks it with fflate)
    #[serde(rename = "zipB64", skip_serializing_if = "Option::is_none")]
    pub zip_b64: Option<String>,
}

#[derive(Serialize)]
pub struct PackSnapshot {
    pub builtin: Option<PackEntry>,
    /// mods directory (medium priority)
    pub mods: Vec<PackEntry>,
    /// resourcepacks directory (highest priority)
    pub resourcepacks: Vec<PackEntry>,
}

const BUILTIN_NAME: &str = "default.zip";

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Recursively collects every file in a folder pack (keys are joined with `/`, and the frontend
/// normalises by the same rule)
fn walk(dir: &Path, base: &str, out: &mut BTreeMap<String, String>) {
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
            Ok(t) if t.is_dir() => walk(&full, &rel, out),
            Ok(_) => {
                if let Ok(bytes) = fs::read(&full) {
                    out.insert(rel, b64(&bytes));
                }
            }
            Err(_) => {}
        }
    }
}

fn read_entry(full: &Path, name: &str, builtin: bool) -> PackEntry {
    let mut entry = PackEntry {
        name: name.to_string(),
        builtin,
        ..Default::default()
    };
    if full.is_dir() {
        walk(full, "", &mut entry.files);
    } else if let Ok(bytes) = fs::read(full) {
        entry.zip_b64 = Some(b64(&bytes));
    }
    entry
}

/// Scans one directory: skips the builtin pack name and returns ascending name order (both folder
/// packs and .zip files count)
fn scan_dir(dir: &Path, skip_builtin: bool) -> Vec<PackEntry> {
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
            out.push(read_entry(&full, &name, false));
        }
    }
    out
}

/// The complete resource pack snapshot (the original scanPacks()'s three sources, in the same order)
pub fn snapshot(game_root: &Path) -> PackSnapshot {
    let packs_dir = game_root.join("resourcepacks");
    let mods_dir = game_root.join("mods");

    let builtin_file = packs_dir.join(BUILTIN_NAME);
    let builtin = if builtin_file.is_file() {
        Some(read_entry(&builtin_file, BUILTIN_NAME, true))
    } else {
        None
    };

    PackSnapshot {
        builtin,
        mods: scan_dir(&mods_dir, false),
        resourcepacks: scan_dir(&packs_dir, true),
    }
}
