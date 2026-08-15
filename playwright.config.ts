import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  // Electron launch + alive-mode sampling runs are slow; give headroom.
  timeout: 120_000,
  // The suite drives one Electron app instance per test; parallel workers
  // fight over the GPU and flake on CI-class machines.
  workers: 1,
  reporter: [["list"]],
});
