// GET /api/auth-handoff: the packaged desktop/Android app cannot run Google
// OAuth inside its embedded webview, so it opens the system browser instead.
// That browser ends up holding the session cookie, and the app needs a
// credential of its own. This route mints a one-time token for the session the
// browser just established and hands it back to the app, which exchanges the
// token for a session via /api/auth/one-time-token/verify.
//
// The hand-back is a page with a link the user clicks, not a redirect: a
// browser will not launch a custom scheme from a server redirect that carries
// no user gesture. Chrome drops such a launch silently, which left the app
// waiting for a deep link that never arrived and the user staring at the
// sign-in screen. Clicking the link is the gesture.
//
// The caller is a browser tab the user is looking at, so failures are reported
// on that same page with an error code in the link, never as a 401 JSON body.

import { Hono } from "hono";
import type { createAuth } from "../auth/auth.ts";

// Must match the scheme registered by the Tauri app.
export const APP_SCHEME = "werewolf";

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

/** The page that hands `deepLink` to the app. Spanish when the browser asks for
 * it, English otherwise — this is the one screen of the flow the client cannot
 * translate, because it renders outside the app. */
export function appHandoffPage(deepLink: string, acceptLanguage: string | undefined): string {
  const copy = acceptLanguage?.toLowerCase().startsWith("es") ? COPY.es : COPY.en;
  const href = escapeHtml(deepLink);
  return `<!doctype html>
<html lang="${copy === COPY.es ? "es" : "en"}">
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

export function authHandoffRoutes(auth: ReturnType<typeof createAuth>) {
  const app = new Hono();

  app.get("/auth-handoff", async (c) => {
    const page = (deepLink: string) =>
      c.html(appHandoffPage(deepLink, c.req.header("accept-language")));

    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) {
      return page(`${APP_SCHEME}://auth?error=UNAUTHENTICATED`);
    }

    let token: string | undefined;
    try {
      const generated = await auth.api.generateOneTimeToken({
        headers: c.req.raw.headers,
      });
      token = generated?.token;
    } catch {
      token = undefined;
    }

    if (!token) {
      return page(`${APP_SCHEME}://auth?error=HANDOFF_FAILED`);
    }

    return page(`${APP_SCHEME}://auth?ott=${encodeURIComponent(token)}`);
  });

  return app;
}
