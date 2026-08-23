import type { Db } from "@werewolf/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins/bearer";
import { oneTimeToken } from "better-auth/plugins/one-time-token";
import type { MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import type { Env } from "../env.ts";
import { isLocalInstance } from "./dev-user.ts";
import { allowedOrigins } from "./origins.ts";
import { authSchema } from "./schema.ts";

export type ViewerContext = { userId: string; username: string | null };

export function createAuth(db: Db, env: Env) {
  // A deployment is genuinely cross-site when any trusted origin lives on a
  // different HOSTNAME than BETTER_AUTH_URL. Compare hostname, not origin: in
  // development BETTER_AUTH_URL is http://localhost:3000 and the trusted
  // origin is http://localhost:1420 — a different origin but the same site —
  // and dev must keep working exactly as it does today. Only a real cross-site
  // deployment needs SameSite=None + Secure cookies.
  // Deliberately the CONFIGURED origins only, not the packaged-app ones: the
  // packaged clients authenticate with a bearer token and never rely on this
  // cookie, so their always-present origins must not drag every deployment
  // (including local development) onto SameSite=None.
  const crossSite = env.BETTER_AUTH_TRUSTED_ORIGINS.some((origin) => {
    try {
      return new URL(origin).hostname !== new URL(env.BETTER_AUTH_URL).hostname;
    } catch {
      return false;
    }
  });

  return betterAuth({
    database: drizzleAdapter(db, { provider: "sqlite", schema: authSchema }),
    // Accept an `Authorization: Bearer <token>` header as a session credential
    // so the packaged desktop/Android clients can authenticate without cookies.
    // Our own routes resolve the viewer through auth.api.getSession({ headers }),
    // and the bearer plugin's before-hook turns that header into the session
    // cookie on those headers — so this single line authenticates werewolf's own
    // API routes too, not just /api/auth/*. sessionMiddleware needs no change.
    // The plugin also sets a `set-auth-token` response header whenever a Better
    // Auth response sets the session cookie; that is how a client learns its token.
    plugins: [
      bearer(),
      // One-time tokens let the packaged app exchange the session cookie the
      // system browser holds for a credential of its own (see
      // routes/auth-handoff.ts). Exposes auth.api.generateOneTimeToken and
      // auth.api.verifyOneTimeToken, plus the /api/auth/one-time-token/*
      // endpoints.
      oneTimeToken(),
    ],
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins: allowedOrigins(env.BETTER_AUTH_URL, env.BETTER_AUTH_TRUSTED_ORIGINS),
    socialProviders: {
      google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
    },
    // Server-side gate for the dev sign-in: the email+password endpoint exists
    // only on a localhost instance, and a real deployment's hostname turns it
    // off. The dev user signs in through this ordinary endpoint, so every auth
    // path behaves exactly as in production.
    emailAndPassword: { enabled: isLocalInstance(env.BETTER_AUTH_URL) },
    // Exposed on the session so the game layer can name players without a
    // second query. Written only through PATCH /api/me/username, never by the
    // client directly.
    user: { additionalFields: { username: { type: "string", required: false, input: false } } },
    advanced: {
      // The app always runs behind a reverse proxy, so the socket address is
      // the proxy's. Without this every request shares one rate-limit bucket
      // and one abusive client throttles everybody.
      ipAddress: { ipAddressHeaders: ["x-forwarded-for", "x-real-ip"] },
      ...(crossSite
        ? { defaultCookieAttributes: { sameSite: "none" as const, secure: true } }
        : {}),
    },
  });
}

export function sessionMiddleware(
  resolve: (request: Request) => Promise<ViewerContext | null>,
): MiddlewareHandler {
  return createMiddleware(async (c, next) => {
    const viewer = await resolve(c.req.raw);
    if (viewer) c.set("viewer", viewer);
    await next();
  });
}

export const requireViewer = createMiddleware(async (c, next) => {
  if (!c.get("viewer")) return c.json({ error: { code: "UNAUTHENTICATED" } }, 401);
  await next();
});

// A browser cannot set an Authorization header on a WebSocket handshake, so the
// live sockets carry a base64url encoding of the token in the subprotocol
// instead. The encoding matters: Better Auth tokens contain `/` and `=`, which
// browsers reject in WebSocket protocol names. When the protocol is present
// (and no Authorization header is), rebuild the headers with the decoded token
// as a bearer credential so the bearer plugin can authenticate the handshake.
function withWebSocketBearer(request: Request): Headers {
  if (request.headers.has("authorization")) return request.headers;
  const protocol = request.headers.get("sec-websocket-protocol");
  if (!protocol) return request.headers;
  const [scheme, encodedToken, ...rest] = protocol.split(",").map((part) => part.trim());
  if (scheme?.toLowerCase() !== "bearer" || !encodedToken || rest.length > 0)
    return request.headers;
  const base64 = encodedToken.replaceAll("-", "+").replaceAll("_", "/");
  if (base64.length % 4 === 1) return request.headers;
  let token: string;
  try {
    token = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "="));
  } catch {
    return request.headers;
  }
  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${token}`);
  return headers;
}

export async function resolveAuthSession(auth: ReturnType<typeof createAuth>, request: Request) {
  const session = await auth.api.getSession({ headers: withWebSocketBearer(request) });
  return session?.user?.id
    ? {
        userId: session.user.id,
        username: (session.user as { username?: string | null }).username ?? null,
      }
    : null;
}
