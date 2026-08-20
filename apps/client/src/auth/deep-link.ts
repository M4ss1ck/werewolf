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
  if (!ott) return { ok: false, code: "HANDOFF_FAILED" };

  try {
    const response = await fetch(apiUrl("/api/auth/one-time-token/verify"), {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: ott }),
    });
    captureAuthToken(response);
    return response.ok ? { ok: true } : { ok: false, code: "HANDOFF_FAILED" };
  } catch {
    return { ok: false, code: "HANDOFF_FAILED" };
  }
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
