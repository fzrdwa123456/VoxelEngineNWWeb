import { defineConfig } from "vite";

// Tauri conventions:
//   * the dev server is pinned to 1420 + strictPort — tauri.conf.json's devUrl hardcodes that port,
//     and a port that drifts means a blank window
//   * clearScreen: false — do not wipe cargo's compiler output, or the Rust-side errors are invisible
//   * watch ignores game\ and src-tauri\ — game\ is the runtime data directory (the process holds an
//     exclusive lock on it; the NW.js original was bitten by this: watching it crashes with EBUSY),
//     and src-tauri\ belongs to cargo
export default defineConfig({
  base: "./",
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/data/**", "**/game/**", "**/src-tauri/**", "**/logs/**"],
    },
  },
  build: {
    // WebView2 IS Chromium, so target it directly
    target: "chrome110",
    sourcemap: false,
    chunkSizeWarningLimit: 4096,
  },
});
