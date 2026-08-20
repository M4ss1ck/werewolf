// The packaged Tauri desktop/Android build loads from tauri://localhost, which
// is cross-site to the server, so its webview never returns the session cookie.
// Better Auth's bearer plugin answers with a `set-auth-token` response header
// instead, and the client holds the token here. The web build never receives
// the header in practice and keeps using cookies, so every storage access
// degrades to null / no-op when a webview has storage disabled.

const TOKEN_KEY = "werewolf.auth-token";

export function getAuthToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setAuthToken(token: string): void {
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

export function captureAuthToken(response: Response): void {
  const token = response.headers.get("set-auth-token");
  if (token) setAuthToken(token);
}

/** Encode the opaque ASCII session token as a WebSocket-safe subprotocol. */
export function webSocketBearerProtocols(token: string): ["bearer", string] {
  return ["bearer", btoa(token).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")];
}
