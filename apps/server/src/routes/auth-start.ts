// GET /api/auth-start: the packaged desktop/Android app cannot run Google OAuth
// inside its embedded webview, so it opens the system browser instead. Better
// Auth binds the OAuth `state` to a signed cookie set on the sign-in response,
// so the whole leg must run in the browser that finishes it. This route starts
// the leg in the system browser by redirecting it to Google and forwarding the
// `set-cookie` headers (the OAuth state cookie) onto that same browser, which
// then receives the callback and holds the cookie it needs.
//
// A desktop client also sends `port` and `state`: it is listening on
// 127.0.0.1:<port> for the token, the way RFC 8252 section 7.3 says a native
// app should. Those two values have to survive a round trip through Google, so
// they ride in a short-lived cookie on this same browser and are read back in
// auth-handoff.ts. Without them the flow falls back to the deep-link page,
// which is still how Android comes home.
//
// The caller is a browser tab the user is looking at, so failures are reported
// on a page that links back to the app, never as a 401 JSON body.

import { Hono } from "hono";
import type { createAuth } from "../auth/auth.ts";
import {
  APP_SCHEME,
  appHandoffPage,
  HANDOFF_COOKIE,
  HANDOFF_LOCALE_COOKIE,
  resolveHandoffLocale,
} from "./auth-handoff.ts";

/** The loopback listener's port and the nonce it will demand back, as the
 * client sent them. Anything malformed is ignored rather than trusted. */
export function parseLoopbackHandoff(
  port: string | undefined,
  state: string | undefined,
): { port: number; state: string } | null {
  if (!port || !state) return null;
  // Only a port number is ever accepted, never a URL or a host. The redirect
  // target is built from a hardcoded 127.0.0.1, so this route cannot be turned
  // into an open redirect.
  if (!/^\d{1,5}$/.test(port)) return null;
  const parsed = Number(port);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) return null;
  // A nonce the client generated with crypto.getRandomValues. Length and
  // charset only: its job is to be unguessable, and we never interpret it.
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(state)) return null;
  return { port: parsed, state };
}

export function authStartRoutes(auth: ReturnType<typeof createAuth>) {
  const app = new Hono();

  app.get("/auth-start", async (c) => {
    const handoff = parseLoopbackHandoff(c.req.query("port"), c.req.query("state"));
    // The language the user picked in the app, not the one their browser is in.
    const appLocale = c.req.query("locale");
    const locale = resolveHandoffLocale(appLocale, c.req.header("accept-language"));

    const response = await auth.api.signInSocial({
      body: { provider: "google", callbackURL: "/api/auth-handoff" },
      asResponse: true,
    });

    const { url } = (await response.json()) as { url?: string };
    if (!url) {
      // A page, not a redirect, for the same reason as auth-handoff: a browser
      // drops a gesture-less redirect into a custom scheme.
      c.header("cache-control", "no-store");
      return c.html(appHandoffPage(`${APP_SCHEME}://auth?error=HANDOFF_FAILED`, locale));
    }

    // Forward the OAuth state cookie onto the system browser that will finish
    // the leg. Without it the callback arrives in a browser that does not hold
    // the cookie Better Auth signed the state with, and it rejects with
    // state_mismatch.
    const redirect = new Response(null, { status: 302, headers: { location: url } });
    for (const cookie of response.headers.getSetCookie()) {
      redirect.headers.append("set-cookie", cookie);
    }

    if (handoff) {
      // Appended to the same Response as the cookies above, deliberately, and
      // NOT via hono/cookie: setting it on the context makes Hono rebuild the
      // set-cookie list on this hand-made Response and the Better Auth state
      // cookie is lost, which is the state_mismatch bug 0217b38 fixed.
      //
      // Lax, because the browser comes back from Google as a top-level GET.
      // Ten minutes covers a slow consent screen and nothing more. Both halves
      // of the value are already validated to digits and [A-Za-z0-9_-], so
      // there is nothing here that could break out of the cookie.
      const secure = new URL(c.req.url).protocol === "https:";
      redirect.headers.append(
        "set-cookie",
        `${HANDOFF_COOKIE}=${handoff.port}.${handoff.state}` +
          `; Max-Age=600; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`,
      );
    }

    // Carried for both paths: the loopback redirect does not render a page,
    // but the Android fallback does, and it must not switch languages on the
    // user just because their browser is set to something else.
    if (appLocale === "en" || appLocale === "es") {
      const secure = new URL(c.req.url).protocol === "https:";
      redirect.headers.append(
        "set-cookie",
        `${HANDOFF_LOCALE_COOKIE}=${appLocale}` +
          `; Max-Age=600; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`,
      );
    }

    return redirect;
  });

  return app;
}
