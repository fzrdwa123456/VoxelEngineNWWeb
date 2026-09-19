// 游戏数据根目录、settings.json、日志、vsync 开关 —— 对应原 NW.js 版 platform/shell.ts 里
// 那一半"文件系统"的职责（nw.Window 那一半在 win.rs）。
//
// 便携布局：release 下 exe 在 release\VoxelEngineTauri\，数据在旁边的 game\；
// dev 下 exe 在 src-tauri\target\debug\，数据直接用仓库根目录（省得每次 dev 都往 target 里塞）。
// VOXEL_GAME_ROOT 环境变量可以强制指定，排查问题时好用。
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};

/// 游戏数据根目录（原版是 `process.execPath` 的上一级 + ".."，这里是同样的意思）
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
        // dev: exe 在 src-tauri\target\debug\ -> 往上数三级是仓库根，数据统一放 <仓库根>\game\，
        // **无论 game\ 在不在**（scripts/rearrange.mjs 也建在那里，两边必须一致）
        if let Some(root) = exe_dir.ancestors().nth(3) {
            return root.join("game");
        }
        return exe_dir.join("game");
    }
    // release: 便携布局 —— exe 旁边的 game\
    let portable = exe_dir.join("game");
    if portable.is_dir() {
        portable
    } else {
        exe_dir
    }
}

/// 原版 initShell() 的第一步：把这些目录都建出来（缺了也不报错）
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
// 原版 readSettingsChecked() 的语义原样搬过来：
//   * 文件不存在 -> 一次全新的运行，不是故障（problem = None）
//   * 文件存在但读不动 / 不是 JSON 对象 / JSON 语法错 -> problem 说明原因
// 前端拿到的是**同一个判定**，`diffSettings()`（纯函数）留在 TS 里没动，check:ecs 还在测它。
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

/// 把即将被覆盖的那份 settings.json 留一份 —— 手改坏的文件正是用户想看的东西
pub fn backup_settings(root: &Path) -> String {
    let _ = fs::copy(settings_path(root), settings_bad_path(root));
    "config/settings.bad.json".to_string()
}

// ===== 日志 =====
/// channel: "debug" | "renderer"。前端攒够一批再发过来，这里只负责追加。
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

/// 启动时清空日志（原版 initShell 的行为：覆盖成空文件）。
/// boot.log 是**最早期**那条诊断通道（见 lib.rs 的 boot_report）：前端在 initShell 之前
/// 就挂掉时，只有它能留下痕迹 —— Tauri 里前端挂掉是"没窗口、没日志"的静默失败。
pub fn truncate_logs(root: &Path) {
    for name in ["debug.log", "renderer.log", "boot.log"] {
        let _ = fs::write(logs_dir(root).join(name), b"");
    }
}

/// 最早期诊断：把前端报上来的东西追加进 logs\boot.log
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

// ===== GPU vsync 开关 =====
// NW.js 原版是把 --disable-gpu-vsync 写进自己的 package.json 的 chromium-args，重启生效。
// Tauri 的 WebView2 参数只能在启动时给，所以这里落一个开关文件，run() 在创建窗口前读它，
// 决定要不要把 --disable-gpu-vsync 塞进 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS。语义一样：重启生效。
// 默认值与 NW.js 版一致：默认是"关掉 vsync"（原 app/package.json 的 chromium-args 里就有这个 flag）。
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
/// 必须在 tauri::Builder 之前调用。tauri.conf.json 里的 additionalBrowserArgs 是**基础**参数，
/// 这里只负责在开关要求时补上 --disable-gpu-vsync。
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
