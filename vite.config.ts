import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  root: "app",
  clearScreen: false,
  server: {
    port: 1421,
    strictPort: true,
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  test: {
    environment: "jsdom",
    setupFiles: ["../tests/setup.ts"],
    include: ["../tests/**/*.test.{ts,tsx}"],
    reporters: ["default"],
    testTimeout: 30_000,
  },
});
