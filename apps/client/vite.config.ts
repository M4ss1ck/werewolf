import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const SERVER_ORIGIN = process.env.VITE_SERVER_ORIGIN ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react(), tailwindcss()],

  // Tauri expects a fixed dev port and ignores its own Rust sources.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
    proxy: {
      "/api": { target: SERVER_ORIGIN, changeOrigin: true, ws: true },
    },
  },

  build: {
    outDir: "dist",
    sourcemap: true,
  },

  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
  },
});
