import { isTauri } from "@tauri-apps/api/core";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { apiUrl } from "../api/origin.ts";
import { captureAuthToken } from "./token.ts";

export type AuthDeepLinkResult = { ok: true } | { ok: false; code: string };

/**
 * Complete sign-in from a `werewolf://auth` deep link. The server mints a
 * one-time token in the browser's session and hands it back here; we exchange
 * it for a session and record the bearer token. Anything that is not our auth
 * link is ignored, and a failure is reported as a code rather than thrown.
 */
export async function completeAuthFromUrl(url: string): Promise<AuthDeepLinkResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, code: "IGNORED" };
  }

  if (parsed.protocol !== "werewolf:" || parsed.host !== "auth") {
    return { ok: false, code: "IGNORED" };
  }

  const error = parsed.searchParams.get("error");
  if (error) return { ok: false, code: error };

  const ott = parsed.searchParams.get("ott");
  if (!ott) return { ok: false, code: "NO_TOKEN_IN_LINK" };

  return exchangeOneTimeToken(ott);
}

/**
 * Spend a one-time token on a session of our own and keep the bearer token the
 * server answers with. Shared by both ways the token can arrive: the desktop
 * loopback listener and the Android deep link.
 */
export async function exchangeOneTimeToken(ott: string): Promise<AuthDeepLinkResult> {
  let response: Response;
  try {
    response = await fetch(apiUrl("/api/auth/one-time-token/verify"), {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: ott }),
    });
  } catch {
    // The request never landed: offline, DNS, TLS, wrong server origin.
    return { ok: false, code: "VERIFY_UNREACHABLE" };
  }
  captureAuthToken(response);
  // Distinguish the two failures that used to share one code. A 400 is the
  // token itself (spent already, or past its three minutes); anything else is
  // the server having a bad day.
  if (response.ok) return { ok: true };
  return { ok: false, code: response.status === 400 ? "TOKEN_REJECTED" : "VERIFY_FAILED" };
}

/**
 * Subscribe to auth deep links. On a cold start launched by the link itself the
 * `onOpenUrl` event may never fire, so we also check `getCurrent()` once. The
 * web build never touches the Tauri APIs.
 */
export function listenForAuthDeepLinks(onResult: (r: AuthDeepLinkResult) => void): () => void {
  if (!isTauri()) return () => {};

  const seen = new Set<string>();
  const handle = (url: string) => {
    if (seen.has(url)) return;
    seen.add(url);
    void completeAuthFromUrl(url).then(onResult);
  };

  void getCurrent()
    .then((urls) => urls?.forEach(handle))
    .catch(() => undefined);

  let unlisten: (() => void) | undefined;
  void onOpenUrl((urls) => urls.forEach(handle))
    .then((fn) => {
      unlisten = fn;
    })
    .catch(() => undefined);

  return () => unlisten?.();
}
