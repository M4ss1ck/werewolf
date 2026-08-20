// The desktop half of sign-in. The app listens on 127.0.0.1:<port> and the
// server redirects the browser there with the one-time token, which is the
// shape RFC 8252 section 7.3 prescribes for native apps.
//
// This exists because the werewolf:// deep link it replaces depends on three
// things we do not control and cannot observe when they fail: the OS resolving
// the scheme, the browser agreeing to launch it, and a user gesture to permit
// it. A loopback redirect is an ordinary navigation the browser just follows.
//
// Android keeps the deep link (see deep-link.ts): an intent is the platform
// norm there, and the Rust command below is desktop-only, so `start` returns
// null and the caller falls back on its own.

import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { type AuthDeepLinkResult, exchangeOneTimeToken } from "./deep-link.ts";

/** The event the Rust listener emits once, when the browser arrives. */
const AUTH_CALLBACK_EVENT = "auth://callback";

type AuthCallbackPayload = { ott: string | null; code: string | null };

/** The nonce the listener will demand back, so no other process on this
 * machine can complete our sign-in with a token of its choosing. */
function newState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/**
 * Bind the loopback listener. Returns the query string to hand to
 * /api/auth-start, or null when this build has no such listener (Android, or
 * the web build), in which case the caller uses the deep-link flow.
 */
export async function startLoopbackHandoff(locale: string): Promise<string | null> {
  if (!isTauri()) return null;
  const state = newState();
  try {
    // The locale goes to the listener too: the page it shows the user renders
    // in the browser, outside the app, so it cannot read the app's i18n.
    const port = await invoke<number>("start_auth_handoff", { state, locale });
    return `port=${port}&state=${encodeURIComponent(state)}&locale=${encodeURIComponent(locale)}`;
  } catch {
    // No command on this platform, or the port could not be bound. Neither is
    // worth failing sign-in over while the deep-link path still exists.
    return null;
  }
}

/** Subscribe to the loopback listener's single result. */
export function listenForLoopbackCallback(
  onResult: (result: AuthDeepLinkResult) => void,
): () => void {
  if (!isTauri()) return () => {};

  let unlisten: (() => void) | undefined;
  void listen<AuthCallbackPayload>(AUTH_CALLBACK_EVENT, (event) => {
    const { ott, code } = event.payload;
    if (ott) {
      void exchangeOneTimeToken(ott).then(onResult);
      return;
    }
    onResult({ ok: false, code: code ?? "HANDOFF_FAILED" });
  })
    .then((fn) => {
      unlisten = fn;
    })
    .catch(() => undefined);

  return () => unlisten?.();
}
