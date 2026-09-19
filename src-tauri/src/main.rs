// Windows 下 release 不开控制台（对应原来 launcher.c 的 -mwindows）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    voxelengine_tauri_lib::run()
}
