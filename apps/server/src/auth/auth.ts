import type { Db } from "@werewolf/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import type { Env } from "../env.ts";
import { authSchema } from "./schema.ts";

export type ViewerContext = { userId: string; username: string | null };

export function createAuth(db: Db, env: Env) {
  // A deployment is genuinely cross-site when any trusted origin lives on a
  // different HOSTNAME than BETTER_AUTH_URL. Compare hostname, not origin: in
  // development BETTER_AUTH_URL is http://localhost:3000 and the trusted
  // origin is http://localhost:1420 — a different origin but the same site —
  // and dev must keep working exactly as it does today. Only a real cross-site
  // deployment needs SameSite=None + Secure cookies.
  const crossSite = env.BETTER_AUTH_TRUSTED_ORIGINS.some((origin) => {
    try {
      return new URL(origin).hostname !== new URL(env.BETTER_AUTH_URL).hostname;
    } catch {
      return false;
    }
  });

  return betterAuth({
    database: drizzleAdapter(db, { provider: "sqlite", schema: authSchema }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins: env.BETTER_AUTH_TRUSTED_ORIGINS,
    socialProviders: {
      google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
    },
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

export async function resolveAuthSession(auth: ReturnType<typeof createAuth>, request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  return session?.user?.id
    ? {
        userId: session.user.id,
        username: (session.user as { username?: string | null }).username ?? null,
      }
    : null;
}
