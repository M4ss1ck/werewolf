import { reticle } from "@reticlehq/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type PluginOption } from "vite";

const SERVER_ORIGIN = process.env.VITE_SERVER_ORIGIN ?? "http://localhost:3000";

export default defineConfig({
  plugins: [reticle() as unknown as PluginOption, react(), tailwindcss()],

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
    // `ws: true` forwards the /api/*/live sockets. This is why the `dev` script
    // runs Vite under node rather than bun: Bun's node:http client reports a
    // 101 as an ordinary response instead of emitting `upgrade`, so Vite's
    // proxy never pipes the socket and then crashes on `socket.destroySoon()`.
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
