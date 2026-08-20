// GET /api/auth-start: the packaged desktop/Android app cannot run Google OAuth
// inside its embedded webview, so it opens the system browser instead. Better
// Auth binds the OAuth `state` to a signed cookie set on the sign-in response,
// so the whole leg must run in the browser that finishes it. This route starts
// the leg in the system browser by redirecting it to Google and forwarding the
// `set-cookie` headers (the OAuth state cookie) onto that same browser, which
// then receives the callback and holds the cookie it needs. The app comes back
// via the werewolf://auth deep link (see auth-handoff.ts).
//
// The caller is a browser tab the user is looking at, so failures are reported
// as a redirect with an error code in the query string, never as a 401 JSON
// body.

import { Hono } from "hono";
import type { createAuth } from "../auth/auth.ts";
import { APP_SCHEME, appHandoffPage } from "./auth-handoff.ts";

export function authStartRoutes(auth: ReturnType<typeof createAuth>) {
  const app = new Hono();

  app.get("/auth-start", async (c) => {
    const response = await auth.api.signInSocial({
      body: { provider: "google", callbackURL: "/api/auth-handoff" },
      asResponse: true,
    });

    const { url } = (await response.json()) as { url?: string };
    if (!url) {
      // A page, not a redirect, for the same reason as auth-handoff: a browser
      // drops a gesture-less redirect into a custom scheme.
      return c.html(
        appHandoffPage(
          `${APP_SCHEME}://auth?error=HANDOFF_FAILED`,
          c.req.header("accept-language"),
        ),
      );
    }

    // Forward the OAuth state cookie onto the system browser that will finish
    // the leg. Without it the callback arrives in a browser that does not hold
    // the cookie Better Auth signed the state with, and it rejects with
    // state_mismatch.
    const redirect = new Response(null, { status: 302, headers: { location: url } });
    for (const cookie of response.headers.getSetCookie()) {
      redirect.headers.append("set-cookie", cookie);
    }
    return redirect;
  });

  return app;
}
