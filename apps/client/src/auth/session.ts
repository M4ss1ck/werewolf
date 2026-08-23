import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { apiUrl } from "../api/origin.ts";
import { i18n } from "../i18n/i18n.ts";
import { startLoopbackHandoff } from "./loopback.ts";
import { loadTelegramSdk, startTelegramHandoff, telegramWebApp } from "./telegram.ts";
import { captureAuthToken, clearAuthToken, getAuthToken } from "./token.ts";

export interface SessionUser {
  id: string;
  name?: string;
  username?: string | null;
  email?: string;
  image?: string;
}
export interface Session {
  user: SessionUser;
  session?: unknown;
}

export async function getSession(): Promise<Session | null> {
  try {
    const token = getAuthToken();
    const response = await fetch(apiUrl("/api/auth/get-session"), {
      credentials: "include",
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    });
    captureAuthToken(response);
    if (!response.ok) return null;
    return (await response.json()) as Session | null;
  } catch {
    return null;
  }
}

export async function signInWithGoogle() {
  // The Mini App SDK is injected on demand, only inside a Mini App; make sure
  // it is present before the Telegram branch below asks for it.
  await loadTelegramSdk();

  // The packaged app runs the whole OAuth leg in the system browser. On desktop
  // it first binds a loopback listener and tells the server where to redirect
  // the browser when it is done; on Android there is no such listener and the
  // server falls back to the werewolf:// page. See routes/auth-start.ts. The
  // web path keeps the POST below because there the cookie and the callback are
  // in the same browser.
  if (isTauri()) {
    // The user's language, as chosen in the app — every page in this flow
    // renders outside the app and cannot read its i18n.
    const handoff = await startLoopbackHandoff(i18n.language);
    await openUrl(apiUrl(handoff ? `/api/auth-start?${handoff}` : "/api/auth-start"));
    return;
  }

  // A Telegram Mini App is an embedded webview too, and Google answers OAuth in
  // one with 403 disallowed_useragent. Same problem as the packaged app, same
  // answer: run the leg in a real browser. There is no loopback listener here
  // and no custom scheme, so the token comes back through a polled claim.
  if (telegramWebApp()) {
    await startTelegramHandoff(i18n.language);
    return;
  }

  const token = getAuthToken();
  const callbackURL = globalThis.location.href;
  const response = await fetch(apiUrl("/api/auth/sign-in/social"), {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ provider: "google", callbackURL }),
  });
  captureAuthToken(response);
  if (!response.ok) throw new Error(`Google sign-in failed (${response.status})`);

  const result = (await response.json()) as { redirect?: boolean; url?: string };
  if (result.redirect && result.url) {
    globalThis.location.href = result.url;
  }
}

// Development-only: signs the fixed dev user in through the ordinary
// email+password endpoint, so the session cookie, getSession, the bearer
// plugin and the WebSocket upgrade all behave exactly as in production. The
// button that calls this is stripped from the production bundle, and the
// server only enables the endpoint on a localhost instance. Web-only: no
// Tauri or Telegram branch, no loopback.
export async function signInAsDevUser() {
  const response = await fetch(apiUrl("/api/auth/sign-in/email"), {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "dev@werewolf.local", password: "developer" }),
  });
  captureAuthToken(response);
  if (!response.ok) throw new Error(`Dev sign-in failed (${response.status})`);
  // The Google web path ends in a navigation, which is what re-reads the
  // session. This one answers in place, so nothing would move without a
  // reload — the screen has no refresh callback of its own.
  globalThis.location.reload();
}

export function signOut() {
  const token = getAuthToken();
  return fetch(apiUrl("/api/auth/sign-out"), {
    method: "POST",
    credentials: "include",
    ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
  }).finally(() => clearAuthToken());
}
