// No console in release builds on Windows (matching the original launcher.c -mwindows)
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    voxelengine_tauri_lib::run()
}
