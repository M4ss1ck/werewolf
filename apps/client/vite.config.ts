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
    // Bind all interfaces so the dev server is reachable from outside the
    // container when running the Docker development stack.
    host: true,
    // Bind mounts do not deliver filesystem events into the container, so fall
    // back to polling when the container asks for it.
    watch: {
      ignored: ["**/src-tauri/**"],
      ...(process.env.VITE_POLL ? { usePolling: true, interval: 300 } : {}),
    },
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
