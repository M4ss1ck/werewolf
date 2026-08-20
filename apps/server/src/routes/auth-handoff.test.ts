// GET /api/auth-handoff: the packaged app's sign-in handoff. A real Better Auth
// instance is built over a temp-file database with the auth tables applied and
// a user + session seeded, then the route is driven through createApp with the
// session presented as a bearer credential (the bearer plugin turns it into the
// session cookie on the request headers, exactly as the packaged client would).
//
// The route is mounted before the requireViewer block, so an unauthenticated
// call must redirect to the app scheme rather than answer a 401 JSON body.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, type Db } from "@werewolf/db";
import { drizzle } from "drizzle-orm/libsql";
import { createApp } from "../app.ts";
import { createAuth } from "../auth/auth.ts";
import { authSchema, createAuthTables } from "../auth/schema.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "werewolf-handoff-test-"));
  const { client, db } = createDb(`file:${join(dir, "test.db")}`);
  cleanups.push(() => {
    client.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const authDb = drizzle(client, { schema: authSchema });
  return { client, db, authDb };
}

const env = {
  PORT: 3000,
  TURSO_DATABASE_URL: "file:test.db",
  BETTER_AUTH_SECRET: "test-secret-that-is-long-enough-for-hmac",
  BETTER_AUTH_URL: "http://localhost:3000",
  BETTER_AUTH_TRUSTED_ORIGINS: [],
  GOOGLE_CLIENT_ID: "google-id",
  GOOGLE_CLIENT_SECRET: "google-secret",
};

async function seedSession(authDb: ReturnType<typeof drizzle<typeof authSchema>>) {
  const now = Date.now();
  await authDb.insert(authSchema.user).values({
    id: "user-1",
    name: "Alice",
    username: "alice",
    email: "alice@example.com",
    emailVerified: true,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  });
  await authDb.insert(authSchema.session).values({
    id: "session-1",
    token: "session-token-1",
    expiresAt: new Date(now + 60_000),
    createdAt: new Date(now),
    updatedAt: new Date(now),
    userId: "user-1",
  });
  return "session-token-1";
}

function bearerHeaders(token: string) {
  return { authorization: `Bearer ${token}` };
}

test("with a valid session, GET /api/auth-handoff redirects to the app with a non-empty ott", async () => {
  const { client, authDb } = setup();
  await createAuthTables(client);
  const token = await seedSession(authDb);
  const auth = createAuth(authDb as unknown as Db, env);
  const app = createApp({ auth });

  const response = await app.request("/api/auth-handoff", {
    headers: bearerHeaders(token),
  });

  expect(response.status).toBe(302);
  const location = response.headers.get("location") ?? "";
  expect(location.startsWith("werewolf://auth?ott=")).toBe(true);
  const ott = new URLSearchParams(location.split("?")[1] ?? "").get("ott") ?? "";
  expect(ott.length).toBeGreaterThan(0);
});

test("with no session, GET /api/auth-handoff redirects to UNAUTHENTICATED, not a 401 body", async () => {
  const { client, authDb } = setup();
  await createAuthTables(client);
  const auth = createAuth(authDb as unknown as Db, env);
  // A coordinator must be supplied, otherwise the block that registers
  // sessionMiddleware and requireViewer is never mounted and this asserts
  // nothing about interception. With it mounted, requireViewer guards every
  // other /api/* path, so this proves the handoff route really is registered
  // ahead of it.
  const app = createApp({ auth, coordinator: {} as never });

  const response = await app.request("/api/auth-handoff");

  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("werewolf://auth?error=UNAUTHENTICATED");
  expect(response.headers.get("content-type") ?? "").not.toContain("application/json");

  // Control: a sibling /api route under the same app IS intercepted by
  // requireViewer, so the 302 above is the route's own answer and not an
  // artefact of requireViewer being absent.
  const guarded = await app.request("/api/games/g-1");
  expect(guarded.status).toBe(401);
  expect(await guarded.json()).toEqual({ error: { code: "UNAUTHENTICATED" } });
});

test("the ott from the handoff is genuinely usable: it verifies to the seeded user", async () => {
  const { client, authDb } = setup();
  await createAuthTables(client);
  const token = await seedSession(authDb);
  const auth = createAuth(authDb as unknown as Db, env);
  const app = createApp({ auth });

  const response = await app.request("/api/auth-handoff", {
    headers: bearerHeaders(token),
  });
  const location = response.headers.get("location") ?? "";
  const ott = new URLSearchParams(location.split("?")[1] ?? "").get("ott") ?? "";

  const verified = await auth.api.verifyOneTimeToken({ body: { token: ott } });
  expect(verified?.user?.id).toBe("user-1");
});
