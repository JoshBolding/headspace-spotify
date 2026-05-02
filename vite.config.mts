import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  root: "src/renderer",
  base: "./",
  publicDir: resolve(__dirname, "assets/converted"),
  build: {
    outDir: resolve(__dirname, "dist-renderer"),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
