// No console in release builds on Windows (matching the original launcher.c -mwindows)
#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

fn main() {
    voxelengine_tauri_lib::run()
}
