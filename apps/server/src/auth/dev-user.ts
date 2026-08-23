// Development-only sign-in. The dev user is created through the ordinary
// Better Auth email+password endpoint and signs in through it too, so cookie
// handling, getSession, the bearer plugin and the WebSocket upgrade all behave
// exactly as in production. The single gate is the BETTER_AUTH_URL hostname:
// only a localhost instance gets the credentials path at all, and a real
// deployment's hostname turns it off. The seed CREATES, NEVER UPDATES: it runs
// on every startup, and re-asserting the username would undo a rename made
// through the profile page on the next `docker compose up`. "Developer" is the
// value the user is BORN with, not one it is held to.

import type { Db } from "@werewolf/db";
import { normalizeMentionSearch } from "@werewolf/protocol";
import { eq } from "drizzle-orm";
import type { Env } from "../env.ts";
import type { createAuth } from "./auth.ts";
import { authUser } from "./schema.ts";

export const DEV_USER_EMAIL = "dev@werewolf.local";
export const DEV_USER_PASSWORD = "developer";
export const DEV_USER_NAME = "Developer";

/** True when BETTER_AUTH_URL points at this machine. The single gate that
 *  decides whether the dev credentials path exists at all. */
export function isLocalInstance(betterAuthUrl: string): boolean {
  try {
    const hostname = new URL(betterAuthUrl).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

export async function seedDevUser(
  auth: ReturnType<typeof createAuth>,
  db: Db,
  env: Env,
): Promise<void> {
  if (!isLocalInstance(env.BETTER_AUTH_URL)) return;

  const existing = await db
    .select({ id: authUser.id })
    .from(authUser)
    .where(eq(authUser.email, DEV_USER_EMAIL));
  if (existing.length > 0) return;

  await auth.api.signUpEmail({
    body: { email: DEV_USER_EMAIL, password: DEV_USER_PASSWORD, name: DEV_USER_NAME },
  });
  // `username` is an additionalFields entry with `input: false`, so signUpEmail
  // cannot set it, and App.tsx short-circuits to the username screen when it is
  // falsy. Write it directly, exactly as PATCH /me/username does.
  await db
    .update(authUser)
    .set({
      username: DEV_USER_NAME,
      usernameSearch: normalizeMentionSearch(DEV_USER_NAME),
      updatedAt: new Date(),
    })
    .where(eq(authUser.email, DEV_USER_EMAIL));
}
