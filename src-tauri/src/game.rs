// Game data root, settings.json, logs, the webview's launch arguments — the counterpart of the "filesystem"
// half of the original NW.js build's platform/shell.ts (the nw.Window half lives in win.rs).
//
// Portable layout: in release the exe sits in release\VoxelEngineTauri\ and the data in the sibling
// game\; in dev the exe sits in src-tauri\target\debug\ and the data is taken straight from the repo
// root (no need to stuff it into target on every dev run).
// The VOXEL_GAME_ROOT environment variable can force it, which is handy when diagnosing.
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};

/// Game data root directory (the original took `process.execPath`'s parent + "..", which means the same here)
pub fn game_root() -> PathBuf {
    if let Ok(v) = std::env::var("VOXEL_GAME_ROOT") {
        if !v.is_empty() {
            return PathBuf::from(v);
        }
    }
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."));
    if cfg!(debug_assertions) {
        // dev: the exe is in src-tauri\target\debug\ -> three levels up is the repo root, and the
        // data always goes to <repo root>\game\, **whether or not game\ exists** (scripts/rearrange.mjs
        // creates it there too, so the two must agree)
        if let Some(root) = exe_dir.ancestors().nth(3) {
            return root.join("game");
        }
        return exe_dir.join("game");
    }
    // release: portable layout — game\ next to the exe
    let portable = exe_dir.join("game");
    if portable.is_dir() {
        portable
    } else {
        exe_dir
    }
}

/// The original initShell()'s first step: create all these directories (a failure is not reported)
pub fn ensure_dirs(root: &Path) {
    for d in ["logs", "saves", "config", "mods", "resourcepacks"] {
        let _ = fs::create_dir_all(root.join(d));
    }
}

pub fn settings_path(root: &Path) -> PathBuf {
    root.join("config").join("settings.json")
}

pub fn settings_bad_path(root: &Path) -> PathBuf {
    root.join("config").join("settings.bad.json")
}

pub fn logs_dir(root: &Path) -> PathBuf {
    root.join("logs")
}

// ===== settings.json =====
// The original readSettingsChecked()'s semantics carried over unchanged:
//   * the file does not exist -> a brand-new run, not a fault (problem = None)
//   * the file exists but cannot be read / is not a JSON object / has a JSON syntax error
//     -> problem explains why
// The frontend receives **the same verdict**, and `diffSettings()` (a pure function) stays in TS
// untouched, still covered by check:ecs.
#[derive(Serialize)]
pub struct SettingsRead {
    pub settings: Value,
    pub problem: Option<String>,
}

pub fn read_settings_checked(root: &Path) -> SettingsRead {
    let text = match fs::read_to_string(settings_path(root)) {
        Err(_) => {
            return SettingsRead {
                settings: json!({}),
                problem: None,
            }
        }
        Ok(t) => t,
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(_)) => SettingsRead {
            settings: serde_json::from_str(&text).unwrap_or_else(|_| json!({})),
            problem: None,
        },
        Ok(_) => SettingsRead {
            settings: json!({}),
            problem: Some("it does not hold a JSON object".into()),
        },
        Err(e) => SettingsRead {
            settings: json!({}),
            problem: Some(format!("it is not valid JSON ({e})")),
        },
    }
}

pub fn write_settings(root: &Path, value: &Value) -> bool {
    let text = format!(
        "{}\n",
        serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".into())
    );
    fs::write(settings_path(root), text).is_ok()
}

/// Keeps a copy of the settings.json that is about to be overwritten — a hand-mangled file is
/// exactly what the user wants to look at
pub fn backup_settings(root: &Path) -> String {
    let _ = fs::copy(settings_path(root), settings_bad_path(root));
    "config/settings.bad.json".to_string()
}

// ===== Logs =====
/// channel: "debug" | "renderer". The frontend accumulates a batch before sending it; this side
/// only appends.
pub fn append_log(root: &Path, channel: &str, lines: &[String]) {
    if lines.is_empty() {
        return;
    }
    let name = match channel {
        "renderer" => "renderer.log",
        _ => "debug.log",
    };
    let path = logs_dir(root).join(name);
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = f.write_all(lines.join("\n").as_bytes());
        let _ = f.write_all(b"\n");
    }
}

/// Truncates the logs at startup (the original initShell's behaviour: overwrite with an empty file).
/// boot.log is the **earliest** diagnostic channel (see boot_report in lib.rs): when the frontend
/// dies before initShell, it is the only thing that leaves a trace — in Tauri a frontend crash is
/// the silent failure of "no window, no log".
pub fn truncate_logs(root: &Path) {
    for name in ["debug.log", "renderer.log", "boot.log"] {
        let _ = fs::write(logs_dir(root).join(name), b"");
    }
}

/// Earliest diagnostics: append whatever the frontend reports into logs\boot.log
pub fn append_boot(root: &Path, message: &str) {
    let _ = fs::create_dir_all(logs_dir(root));
    if let Ok(mut f) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(logs_dir(root).join("boot.log"))
    {
        let _ = f.write_all(message.as_bytes());
        let _ = f.write_all(b"\n");
    }
}

// ===== The webview's launch arguments (P1.86) =====
// These are FIXED now, and that is the point: a WebView2 argument can only be supplied before the webview
// exists, so anything the user may switch at runtime must NOT be one. The flag below is what makes that
// possible: **`--disable-frame-rate-limit`** lifts Chromium's OWN display-rate limit, so rAF stops being
// pinned to the panel's refresh and the frame rate becomes something the page decides. The vertical-sync
// switch then lives in the front end (`FPS_CAP.vsync` + `pacingTargetHz`): "synced" paces the loop at the
// display's measured refresh rate, "unsynced" draws on every vblank.
//
// **`--disable-gpu-vsync` IS DELIBERATELY NOT HERE (measured, not assumed).** It makes the compositor submit
// WITHOUT waiting for vertical blank, and with it the synced case measured 55-60fps with 21ms frames — the
// submits land between the panel's vblanks and the panel repeats frames (judder), because the unthrottled
// BeginFrame source delivers ~2 callbacks per refresh and a time-based pacer can only submit on a callback.
// Left OUT, the compositor keeps its vblank-locked presents: the panel shows the newest frame once per
// refresh, which is the smoothness the switch's "synced" state is FOR. The cost is that "unsynced" cannot
// tear (a browser presents through its compositor either way) — what it buys instead is a much higher render
// rate and therefore lower input-to-photon latency.
const EXTRA_BROWSER_ARGS: &str = "--disable-frame-rate-limit";
//
// THE OLD SHAPE, for the record: this read `config/vsync.json` and appended `--disable-gpu-vsync` only when
// it said so, which meant the switch could only ever apply at the next launch - and the setting could not be
// validated by the settings check (`diffSettings` knows settings.json, which this file was not). The file is
// dead now; a `vsync.json` left behind by an older build is ignored.

/// Must be called before `tauri::Builder`: the window host reads its launch arguments from the
/// environment **before the webview exists**, so this is the only moment they can be set.
///
/// The host owns the list (`crate::platform::browser_args_base`). **Publish unconditionally (P1.81)** - the
/// arguments used to live in `tauri.conf.json` as a second copy, so "publish nothing" still meant
/// "the config's list applies". That key is gone now, so a host that takes arguments must always be
/// handed them.
pub fn apply_browser_args() {
    let base = crate::platform::browser_args_base();
    crate::platform::publish_browser_args(&format!("{base} {EXTRA_BROWSER_ARGS}"));
}
