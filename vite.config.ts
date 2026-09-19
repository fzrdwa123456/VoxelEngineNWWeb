import { defineConfig } from "vite";

// Tauri 约定：
//   * dev server 固定 1420 + strictPort —— tauri.conf.json 的 devUrl 写死了这个端口，端口漂了就白屏
//   * clearScreen: false —— 别把 cargo 的编译输出擦掉，不然看不到 Rust 侧的错误
//   * watch 忽略 game\ 和 src-tauri\ —— game\ 是运行时数据目录（会被进程独占锁，
//     原版就被这个坑过：watching it crashes with EBUSY），src-tauri\ 归 cargo 管
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
    // WebView2 就是 Chromium，target 直接按它来
    target: "chrome110",
    sourcemap: false,
    chunkSizeWarningLimit: 4096,
  },
});
