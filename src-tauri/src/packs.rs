// 资源包 / mod 扫描 —— 对应原 NW.js 版 rendering/textures.ts 里那一半"读目录"的职责。
//
// 分工是刻意的：
//   * Rust 只做"列目录 + 读文件字节"（Node 的 fs 干的那点事），不做任何 MC 命名空间归一化；
//   * 归一化（assets/<ns>/textures/... -> block/dirt.png）、优先级、layering 全部留在 TS 里，
//     因为它已经是纯逻辑、已经被 check:ecs 覆盖，搬过来只会引入风险。
//
// zip 包**不解**，Rust 直接把 zip 的原始字节丢给前端 —— 前端本来就有 fflate（unzipSync），
// 这样 Rust 侧一个额外依赖都不用加。
//
// 顺序也照抄 TS：每个目录里的条目按**名字升序**返回，TS 侧从后往前遍历（后加载的优先级高）。
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use base64::Engine;
use serde::Serialize;

/// 一个包：要么是文件夹包（files 里有内容），要么是 zip 包（zipB64 有内容）
#[derive(Serialize, Default)]
pub struct PackEntry {
    pub name: String,
    pub builtin: bool,
    /// 文件夹包：相对路径（原样，带正/反斜杠都行，前端会归一化）-> base64 字节
    pub files: BTreeMap<String, String>,
    /// zip 包：整个 zip 的 base64（前端 fflate 解压）
    #[serde(rename = "zipB64", skip_serializing_if = "Option::is_none")]
    pub zip_b64: Option<String>,
}

#[derive(Serialize)]
pub struct PackSnapshot {
    pub builtin: Option<PackEntry>,
    /// mods 目录（中等优先级）
    pub mods: Vec<PackEntry>,
    /// resourcepacks 目录（最高优先级）
    pub resourcepacks: Vec<PackEntry>,
}

const BUILTIN_NAME: &str = "default.zip";

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// 递归收集一个文件夹包里的所有文件（key 用 `/` 连接，前端按同样的规则归一化）
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

/// 扫一个目录：跳过内置包名，按名字升序返回（文件夹包和 .zip 都算）
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

/// 完整的资源包快照（原版 scanPacks() 的那三个来源，同一个顺序）
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
