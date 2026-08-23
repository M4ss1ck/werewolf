import { isTauri } from "@tauri-apps/api/core";

/** Telegram appends #tgWebAppData=...&tgWebAppPlatform=... on launch, and the
 * in-app webview exposes TelegramWebviewProxy. Read once at module load: the
 * SPA rewrites the URL as it routes, so the hash is gone by the time anything
 * asks. Deliberately does not touch Telegram.WebApp — that SDK is no longer
 * loaded outside a Mini App. */
const inTelegramWebview =
  (typeof location !== "undefined" && location.hash.includes("tgWebApp")) ||
  "TelegramWebviewProxy" in globalThis;

export function isTelegramWebview(): boolean {
  return inTelegramWebview;
}

/** Runtimes whose webview is cross-site to the server and never returns the
 * session cookie. Everywhere else — the web build — authenticates on cookies,
 * and must not request a WebSocket subprotocol: the production edge does not
 * relay Sec-WebSocket-Protocol, so an unacknowledged one fails the handshake. */
export function needsBearerAuth(): boolean {
  return isTauri() || inTelegramWebview;
}
