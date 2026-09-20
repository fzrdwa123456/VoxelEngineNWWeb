// Game data root, settings.json, logs, the vsync switch — the counterpart of the "filesystem" half
// of the original NW.js build's platform/shell.ts (the nw.Window half lives in win.rs).
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

fn vsync_path(root: &Path) -> PathBuf {
    root.join("config").join("vsync.json")
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

// ===== GPU vsync switch =====
// The original NW.js build wrote --disable-gpu-vsync into its own package.json's chromium-args, which
// takes effect on restart. Tauri's WebView2 arguments can only be supplied at launch, so this leaves a
// switch file that run() reads before creating the window to decide whether to stuff
// --disable-gpu-vsync into WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS. Same semantics: effective on restart.
// The default matches the NW.js build: vsync is off by default (the original app/package.json's
// chromium-args already carried this flag).
pub fn read_vsync_disabled(root: &Path) -> bool {
    match fs::read_to_string(vsync_path(root)) {
        Ok(t) => serde_json::from_str::<Value>(&t)
            .ok()
            .and_then(|v| v.get("disabled").and_then(Value::as_bool))
            .unwrap_or(true),
        Err(_) => true,
    }
}

pub fn write_vsync_disabled(root: &Path, disabled: bool) -> bool {
    let body = json!({ "disabled": disabled });
    fs::write(
        vsync_path(root),
        format!("{}\n", serde_json::to_string_pretty(&body).unwrap()),
    )
    .is_ok()
}
/// Must be called before tauri::Builder. additionalBrowserArgs in tauri.conf.json are the **base**
/// arguments; this only appends --disable-gpu-vsync when the switch asks for it.
pub fn apply_browser_args(root: &Path) {
    if !read_vsync_disabled(root) {
        return;
    }
    const BASE: &str = "--autoplay-policy=no-user-gesture-required \
--no-user-gesture-required --enable-gpu-rasterization --ignore-gpu-blocklist \
--disable-gesture-requirement-for-presentation \
--disable-blink-features=RateLimitPointerLockRequests";
    std::env::set_var(
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        format!("{BASE} --disable-gpu-vsync"),
    );
}
