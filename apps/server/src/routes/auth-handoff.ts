// GET /api/auth-handoff: the packaged desktop/Android app cannot run Google
// OAuth inside its embedded webview, so it opens the system browser instead.
// That browser ends up holding the session cookie, and the app needs a
// credential of its own. This route mints a one-time token for the session the
// browser just established and hands it back to the app, which exchanges the
// token for a session via /api/auth/one-time-token/verify.
//
// There are two ways to hand it back, and which one is used depends on what
// the client asked for in auth-start.ts.
//
// DESKTOP — a redirect to the app's own loopback listener
// (http://127.0.0.1:<port>/callback). This is the RFC 8252 section 7.3 shape
// and what desktop CLIs that log in through a browser actually do. It is an
// ordinary HTTP navigation, so the browser simply follows it: no custom
// scheme to register with the OS, no user gesture, no permission prompt, and
// nothing for a browser to refuse. The `state` the client generated is echoed
// back so its listener can tell our callback from any other local process's.
//
// ANDROID — the werewolf:// page below, clicked by the user. An intent is the
// platform norm there. It is a page rather than a redirect because a browser
// will not launch a custom scheme from a redirect that carries no user
// gesture; Chrome drops such a launch silently.
//
// The caller is a browser tab the user is looking at, so failures are reported
// on that same page, or as an `error` on the loopback redirect, never as a 401
// JSON body.

import { Hono } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import type { createAuth } from "../auth/auth.ts";

// Must match the scheme registered by the Tauri app.
export const APP_SCHEME = "werewolf";

/** Carries the desktop client's loopback port and nonce across the Google
 * round trip. Set in auth-start.ts, consumed here, never seen by the app. */
export const HANDOFF_COOKIE = "werewolf.handoff";

/** Carries the language the user picked *in the app* across the same trip. The
 * browser's Accept-Language is a different setting and is regularly a different
 * language; showing this page in it contradicts the app the user just came
 * from. The app's choice wins, and Accept-Language is only the fallback. */
export const HANDOFF_LOCALE_COOKIE = "werewolf.handoff-locale";

export type HandoffLocale = keyof typeof COPY;

/** The app's locale if it sent one, else whatever the browser asks for. */
export function resolveHandoffLocale(
  appLocale: string | undefined,
  acceptLanguage: string | undefined,
): HandoffLocale {
  if (appLocale === "es" || appLocale === "en") return appLocale;
  return acceptLanguage?.toLowerCase().startsWith("es") ? "es" : "en";
}

const COPY = {
  en: { open: "Open Werewolf", body: "Click to finish signing in." },
  es: { open: "Abrir Werewolf", body: "Haz clic para terminar de iniciar sesión." },
};

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"]/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character] ?? "",
  );
}

/** The page that hands `deepLink` to the app. This is the one screen of the
 * flow the client cannot translate, because it renders outside the app, so the
 * locale has to be carried here (see resolveHandoffLocale). */
export function appHandoffPage(deepLink: string, locale: HandoffLocale): string {
  const copy = COPY[locale];
  const href = escapeHtml(deepLink);
  return `<!doctype html>
<html lang="${locale}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Werewolf</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#14110f;color:#e9e5da;font:16px/1.5 system-ui,sans-serif;text-align:center}
main{padding:2rem}p{color:#a49c8e;margin:0 0 1.75rem}
a{display:inline-block;padding:.9rem 1.6rem;border-radius:.6rem;background:#e9e5da;color:#14110f;
font-weight:600;text-decoration:none}
</style></head>
<body><main><p>${copy.body}</p><a href="${href}">${copy.open}</a></main></body></html>`;
}

/** Read back what auth-start.ts stored. Shape is re-validated here rather than
 * trusted: the cookie is ours, but the port still ends up in a redirect. */
export function readHandoffCookie(
  value: string | undefined,
): { port: number; state: string } | null {
  if (!value) return null;
  const separator = value.indexOf(".");
  if (separator <= 0) return null;
  const port = Number(value.slice(0, separator));
  const state = value.slice(separator + 1);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return null;
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(state)) return null;
  return { port, state };
}

/** The app's loopback listener. Host is hardcoded so this can never become an
 * open redirect: only the port ever varies, and only within 1024-65535. */
export function loopbackUrl(port: number, state: string, params: Record<string, string>): string {
  const url = new URL(`http://127.0.0.1:${port}/callback`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set("state", state);
  return url.toString();
}

export function authHandoffRoutes(auth: ReturnType<typeof createAuth>) {
  const app = new Hono();

  app.get("/auth-handoff", async (c) => {
    const handoff = readHandoffCookie(getCookie(c, HANDOFF_COOKIE));
    if (handoff) deleteCookie(c, HANDOFF_COOKIE, { path: "/" });
    const locale = resolveHandoffLocale(
      getCookie(c, HANDOFF_LOCALE_COOKIE),
      c.req.header("accept-language"),
    );
    deleteCookie(c, HANDOFF_LOCALE_COOKIE, { path: "/" });

    // One reply, two shapes: a loopback redirect for desktop, the clickable
    // page for Android. Both carry the same outcome.
    const answer = (params: Record<string, string>) => {
      c.header("cache-control", "no-store");
      if (handoff) return c.redirect(loopbackUrl(handoff.port, handoff.state, params), 302);
      const query = params.ott
        ? `ott=${encodeURIComponent(params.ott)}`
        : `error=${encodeURIComponent(params.error ?? "HANDOFF_FAILED")}`;
      return c.html(appHandoffPage(`${APP_SCHEME}://auth?${query}`, locale));
    };

    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return answer({ error: "UNAUTHENTICATED" });

    let token: string | undefined;
    try {
      const generated = await auth.api.generateOneTimeToken({
        headers: c.req.raw.headers,
      });
      token = generated?.token;
    } catch {
      token = undefined;
    }

    if (!token) return answer({ error: "HANDOFF_FAILED" });

    return answer({ ott: token });
  });

  return app;
}
