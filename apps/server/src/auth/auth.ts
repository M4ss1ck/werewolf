import type { Db } from "@werewolf/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import type { Env } from "../env.ts";
import { authSchema } from "./schema.ts";

export type ViewerContext = { userId: string };

export function createAuth(db: Db, env: Env) {
  return betterAuth({
    database: drizzleAdapter(db, { provider: "sqlite", schema: authSchema }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    socialProviders: {
      google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
    },
    advanced: {
      // The app always runs behind a reverse proxy, so the socket address is
      // the proxy's. Without this every request shares one rate-limit bucket
      // and one abusive client throttles everybody.
      ipAddress: { ipAddressHeaders: ["x-forwarded-for", "x-real-ip"] },
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
  return session?.user?.id ? { userId: session.user.id } : null;
}
