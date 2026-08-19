// Resolves API and WebSocket URLs against a configured server origin.
//
// An EMPTY origin means same-origin: the server hosts the SPA in production,
// and Vite proxies /api (and the /api/*/live sockets) in development, so the
// client can always talk to the server through its own origin. Only a packaged
// Tauri desktop/Android build loads from tauri://localhost or
// http://tauri.localhost and reaches nothing, so it needs an absolute origin
// baked in at build time via VITE_SERVER_ORIGIN.

const configured = String(import.meta.env.VITE_SERVER_ORIGIN ?? "");

/** Resolve an API path (always starting with "/") against an origin. */
export function apiUrl(path: string, origin: string = configured): string {
  if (!origin) return path;
  return `${origin.replace(/\/+$/, "")}${path}`;
}

/** Resolve a WebSocket path (always starting with "/") against an origin. */
export function wsUrl(path: string, origin: string = configured): string {
  if (!origin) {
    return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${path}`;
  }
  const base = origin.replace(/\/+$/, "");
  const scheme = base.startsWith("https:") ? "wss:" : "ws:";
  return `${scheme}//${base.replace(/^https?:\/\//, "")}${path}`;
}
