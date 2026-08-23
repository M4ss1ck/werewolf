// The packaged Tauri build and the Telegram Mini App webview load from a
// cross-site origin, so their webviews never return the session cookie.
// Better Auth's bearer plugin answers with a `set-auth-token` response header
// instead, and the client holds the token here. The web build must NOT hold a
// bearer token: it would then request a WebSocket bearer subprotocol, and the
// production edge does not relay Sec-WebSocket-Protocol, failing the handshake
// per RFC 6455. Every storage access degrades to null / no-op when a webview
// has storage disabled.

import { needsBearerAuth } from "./runtime.ts";

const TOKEN_KEY = "werewolf.auth-token";

export function getAuthToken(): string | null {
  if (!needsBearerAuth()) return null;
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setAuthToken(token: string): void {
  if (!needsBearerAuth()) return;
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Storage disabled; the web build keeps working on cookies.
  }
}

export function clearAuthToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage disabled; nothing to clear.
  }
}

/** Browsers that already hold a token from an older build must drop it on
 * boot, or the web build would keep requesting the bearer subprotocol. */
export function clearStoredTokenOnCookieRuntime(): void {
  if (!needsBearerAuth()) clearAuthToken();
}

export function captureAuthToken(response: Response): void {
  const token = response.headers.get("set-auth-token");
  if (token) setAuthToken(token);
}

/** Encode the opaque ASCII session token as a WebSocket-safe subprotocol. */
export function webSocketBearerProtocols(token: string): ["bearer", string] {
  return ["bearer", btoa(token).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")];
}
