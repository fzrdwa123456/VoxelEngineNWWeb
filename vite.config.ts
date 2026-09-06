import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  server: {
    // data/ is the NW.js user-data dir (exclusively locked while the game runs); watching it crashes with EBUSY
    watch: { ignored: ["**/data/**"] },
  },
});