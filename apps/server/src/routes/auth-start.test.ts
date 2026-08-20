// GET /api/auth-start: the packaged app's OAuth start. A real Better Auth
// instance is built over a temp-file database with the auth tables applied, then
// the route is driven through createApp. No user or session is seeded — starting
// OAuth requires no session, and no network call is made: signInSocial builds the
// Google authorization URL locally.
//
// The route is mounted before the requireViewer block, so an unauthenticated
// call must redirect to Google rather than answer a 401 JSON body.

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
  const dir = mkdtempSync(join(tmpdir(), "werewolf-auth-start-test-"));
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

test("GET /api/auth-start redirects to Google and forwards the OAuth state cookie", async () => {
  const { client, authDb } = setup();
  await createAuthTables(client);
  const auth = createAuth(authDb as unknown as Db, env);
  const app = createApp({ auth });

  const response = await app.request("/api/auth-start");

  expect(response.status).toBe(302);
  const location = response.headers.get("location") ?? "";
  expect(location.startsWith("https://accounts.google.com/")).toBe(true);

  // The regression that caused the bug: the OAuth state cookie must reach the
  // browser that finishes the leg. Assert it directly.
  const setCookies = response.headers.getSetCookie();
  const stateCookie = setCookies.find((cookie) => cookie.split("=")[0]!.includes("state"));
  expect(stateCookie).toBeDefined();
  const stateCookieValue = stateCookie!.split(";")[0]!.split("=").slice(1).join("=");
  expect(stateCookieValue.length).toBeGreaterThan(0);

  // Better Auth signs the cookie as <value>.<signature>, and the value is the
  // same `state` it put in the authorization URL.
  const state = new URL(location).searchParams.get("state") ?? "";
  expect(state.length).toBeGreaterThan(0);
  expect(stateCookieValue.startsWith(state)).toBe(true);
});

test("GET /api/auth-start answers unauthenticated, mounted ahead of requireViewer", async () => {
  const { client, authDb } = setup();
  await createAuthTables(client);
  const auth = createAuth(authDb as unknown as Db, env);
  // A coordinator must be supplied, otherwise the block that registers
  // sessionMiddleware and requireViewer is never mounted and this asserts
  // nothing about interception. With it mounted, requireViewer guards every
  // other /api/* path, so this proves the auth-start route really is registered
  // ahead of it.
  const app = createApp({ auth, coordinator: {} as never });

  const response = await app.request("/api/auth-start");

  expect(response.status).toBe(302);
  expect((response.headers.get("location") ?? "").startsWith("https://accounts.google.com/")).toBe(
    true,
  );

  // Control: a sibling /api route under the same app IS intercepted by
  // requireViewer, so the 302 above is the route's own answer and not an
  // artefact of requireViewer being absent.
  const guarded = await app.request("/api/games/g-1");
  expect(guarded.status).toBe(401);
  expect(await guarded.json()).toEqual({ error: { code: "UNAUTHENTICATED" } });
});
