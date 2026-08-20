// GET /api/auth-handoff: the packaged desktop/Android app cannot run Google
// OAuth inside its embedded webview, so it opens the system browser instead.
// That browser ends up holding the session cookie, and the app needs a
// credential of its own. This route mints a one-time token for the session the
// browser just established and deep-links back into the app, which exchanges
// the token for a session via /api/auth/one-time-token/verify.
//
// The caller is a browser tab the user is looking at, so failures are reported
// as a redirect with an error code in the query string, never as a 401 JSON
// body.

import { Hono } from "hono";
import type { createAuth } from "../auth/auth.ts";

// Must match the scheme registered by the Tauri app.
export const APP_SCHEME = "werewolf";

export function authHandoffRoutes(auth: ReturnType<typeof createAuth>) {
  const app = new Hono();

  app.get("/auth-handoff", async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) {
      return c.redirect(`${APP_SCHEME}://auth?error=UNAUTHENTICATED`);
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
      return c.redirect(`${APP_SCHEME}://auth?error=HANDOFF_FAILED`);
    }

    return c.redirect(`${APP_SCHEME}://auth?ott=${encodeURIComponent(token)}`);
  });

  return app;
}
