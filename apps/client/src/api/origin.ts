// Resolves API and WebSocket URLs against a configured server origin.
//
// An EMPTY origin means same-origin: the server hosts the SPA in production,
// and Vite proxies /api (and the /api/*/live sockets) in development, so the
// client can always talk to the server through its own origin. Only a packaged
// Tauri desktop/Android build loads from tauri://localhost or
// http://tauri.localhost and reaches nothing, so it needs an absolute origin
// baked in at build time via VITE_SERVER_ORIGIN.

import { isTauri } from "@tauri-apps/api/core";

const configured = String(import.meta.env.VITE_SERVER_ORIGIN ?? "");

/** The origin used in share links for the current runtime. */
export function serverOrigin(origin: string = configured): string {
  // A web invitation must resolve against the page that is serving the SPA.
  // VITE_SERVER_ORIGIN points at the API in Docker and is not necessarily the
  // origin recipients can open in their browser.
  if (!isTauri()) {
    const candidate = window.location.origin;
    if (!candidate.startsWith("http://") && !candidate.startsWith("https://"))
      throw new Error("A web server origin is required for invitation links");
    return candidate.replace(/\/+$/, "");
  }

  const candidate = origin.trim();
  if (!candidate.startsWith("https://"))
    throw new Error("A web server origin is required for invitation links");
  return candidate.replace(/\/+$/, "");
}

export function invitationUrl(code: string, origin?: string): string {
  return `${serverOrigin(origin)}/join?code=${encodeURIComponent(code)}`;
}

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
