// The Telegram Mini App half of sign-in. A Mini App is an embedded webview,
// and Google answers OAuth in one with 403 disallowed_useragent, so it opens
// the leg in a real external browser the way the packaged app does. But a
// webview can neither bind a loopback port nor register werewolf://, so the
// token comes home through a nonce the Mini App polls for. Telegram's own
// openLink() escapes to a real browser and does not close the Mini App, which
// is what makes polling possible.

import { apiUrl } from "../api/origin.ts";
import { type AuthDeepLinkResult, exchangeOneTimeToken } from "./deep-link.ts";

type TelegramWebApp = { initData: string; openLink: (url: string) => void };

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 300_000;

/** The Mini App SDK, and only when this really is a Mini App: the script tag
 * also loads in an ordinary browser tab, where initData is the empty string. */
export function telegramWebApp(): TelegramWebApp | null {
  const webApp = (globalThis as { Telegram?: { WebApp?: unknown } }).Telegram?.WebApp;
  if (
    typeof webApp !== "object" ||
    webApp === null ||
    typeof (webApp as TelegramWebApp).initData !== "string" ||
    (webApp as TelegramWebApp).initData.length === 0 ||
    typeof (webApp as TelegramWebApp).openLink !== "function"
  ) {
    return null;
  }
  return webApp as TelegramWebApp;
}

/** The nonce the server will park the token under, so no other process can
 * complete our sign-in with a token of its choosing. */
function newState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

let sink: ((result: AuthDeepLinkResult) => void) | undefined;
let polling = false;

/** Subscribe to the polled claim's single result. */
export function listenForTelegramCallback(onResult: (r: AuthDeepLinkResult) => void): () => void {
  sink = onResult;
  return () => {
    sink = undefined;
  };
}

export async function startTelegramHandoff(locale: string): Promise<void> {
  const app = telegramWebApp();
  if (!app || polling) return;

  const state = newState();
  app.openLink(
    apiUrl(`/api/auth-start?tg=${encodeURIComponent(state)}&locale=${encodeURIComponent(locale)}`),
  );
  polling = true;
  try {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      let response: Response;
      try {
        response = await fetch(apiUrl(`/api/auth-claim?state=${encodeURIComponent(state)}`));
      } catch {
        // Offline while the user is in the browser: treat as pending rather
        // than ending the poll.
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      if (!response.ok) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      const body = (await response.json()) as
        | { status: "pending" }
        | { status: "ready"; ott: string }
        | { status: "error"; code: string };
      if (body.status === "ready") {
        sink?.(await exchangeOneTimeToken(body.ott));
        return;
      }
      if (body.status === "error") {
        sink?.({ ok: false, code: body.code });
        return;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    sink?.({ ok: false, code: "HANDOFF_TIMEOUT" });
  } finally {
    polling = false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
