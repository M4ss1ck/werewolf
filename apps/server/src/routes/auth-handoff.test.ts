// GET /api/auth-handoff: the packaged app's sign-in handoff. A real Better Auth
// instance is built over a temp-file database with the auth tables applied and
// a user + session seeded, then the route is driven through createApp with the
// session presented as a bearer credential (the bearer plugin turns it into the
// session cookie on the request headers, exactly as the packaged client would).
//
// The route is mounted before the requireViewer block, so an unauthenticated
// call must answer its app-handoff page rather than a 401 JSON body.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, type Db } from "@werewolf/db";
import { drizzle } from "drizzle-orm/libsql";
import { createApp } from "../app.ts";
import { createAuth } from "../auth/auth.ts";
import { authSchema, createAuthTables } from "../auth/schema.ts";
import {
  HANDOFF_COOKIE,
  HANDOFF_LOCALE_COOKIE,
  loopbackUrl,
  readHandoffCookie,
  resolveHandoffLocale,
} from "./auth-handoff.ts";

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

test("with a valid session, GET /api/auth-handoff answers a page linking to the app with a non-empty ott", async () => {
  const { client, authDb } = setup();
  await createAuthTables(client);
  const token = await seedSession(authDb);
  const auth = createAuth(authDb as unknown as Db, env);
  const app = createApp({ auth });

  const response = await app.request("/api/auth-handoff", {
    headers: bearerHeaders(token),
  });

  // A page with a link the user clicks, NOT a redirect. A browser refuses to
  // launch a custom scheme from a server redirect without a user gesture, so
  // the 302 this route used to answer was dropped on the floor and the app
  // never heard back. The click supplies the gesture.
  expect(response.status).toBe(200);
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("cache-control")).toBe("no-store");
  const html = await response.text();
  const href = html.match(/href="(werewolf:\/\/auth\?ott=[^"]+)"/)?.[1] ?? "";
  expect(href.length).toBeGreaterThan(0);
  const ott = new URLSearchParams(href.split("?")[1] ?? "").get("ott") ?? "";
  expect(ott.length).toBeGreaterThan(0);
});

test("with no session, GET /api/auth-handoff answers UNAUTHENTICATED as a page, not a 401 body", async () => {
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

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type") ?? "").not.toContain("application/json");
  // The error reaches the app the same way the token does, through a link the
  // user clicks. A redirect would be dropped and the app would sit on the
  // sign-in screen with nothing to show for it.
  expect(await response.text()).toContain('href="werewolf://auth?error=UNAUTHENTICATED"');

  // Control: a sibling /api route under the same app IS intercepted by
  // requireViewer, so the 200 above is the route's own answer and not an
  // artefact of requireViewer being absent.
  const guarded = await app.request("/api/games/g-1");
  expect(guarded.status).toBe(401);
  expect(await guarded.json()).toEqual({ error: { code: "UNAUTHENTICATED" } });
});

test("the ott completes the packaged-client HTTP exchange and authenticates the next request", async () => {
  const { client, authDb } = setup();
  await createAuthTables(client);
  const token = await seedSession(authDb);
  const auth = createAuth(authDb as unknown as Db, env);
  const app = createApp({ auth, trustedOrigins: ["tauri://localhost"] });

  const response = await app.request("/api/auth-handoff", {
    headers: bearerHeaders(token),
  });
  const html = await response.text();
  const href = html.match(/href="(werewolf:\/\/auth\?ott=[^"]+)"/)?.[1] ?? "";
  const ott = new URLSearchParams(href.split("?")[1] ?? "").get("ott") ?? "";

  const verified = await app.request("/api/auth/one-time-token/verify", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "tauri://localhost" },
    body: JSON.stringify({ token: ott }),
  });
  expect(verified.status).toBe(200);
  const authToken = verified.headers.get("set-auth-token") ?? "";
  expect(authToken.length).toBeGreaterThan(0);

  const session = await app.request("/api/auth/get-session", {
    headers: { authorization: `Bearer ${authToken}`, origin: "tauri://localhost" },
  });
  expect(session.status).toBe(200);
  const sessionBody = (await session.json()) as { user: { id: string } };
  expect(sessionBody.user.id).toBe("user-1");
});

// The desktop handoff: a redirect to the app's own loopback listener instead
// of a page the user has to click. These are security tests as much as
// behaviour tests — the port ends up in a redirect the browser will follow.

test("readHandoffCookie refuses anything that could redirect off the loopback", () => {
  expect(readHandoffCookie(undefined)).toBeNull();
  expect(readHandoffCookie("")).toBeNull();
  // No port, no separator, or a port outside the unprivileged range.
  expect(readHandoffCookie("nonsense")).toBeNull();
  expect(readHandoffCookie(".abcdefghijklmnopqrstuvwxyz012345")).toBeNull();
  expect(readHandoffCookie("80.abcdefghijklmnopqrstuvwxyz012345")).toBeNull();
  expect(readHandoffCookie("99999.abcdefghijklmnopqrstuvwxyz012345")).toBeNull();
  // A host smuggled in where the port belongs.
  expect(readHandoffCookie("evil.example.com.abcdefghijklmnopqrstuvwxyz012345")).toBeNull();
  // A state that is too short to be a nonce, or carries punctuation.
  expect(readHandoffCookie("41234.short")).toBeNull();
  expect(readHandoffCookie("41234.abcdefghijklmnopqrstuvwxyz01234/")).toBeNull();
  expect(readHandoffCookie("41234.abcdefghijklmnopqrstuvwxyz012345")).toEqual({
    port: 41234,
    state: "abcdefghijklmnopqrstuvwxyz012345",
  });
});

test("loopbackUrl always points at 127.0.0.1, whatever it is handed", () => {
  const url = new URL(loopbackUrl(41234, "state-value", { ott: "tok en/+=" }));
  expect(url.protocol).toBe("http:");
  expect(url.hostname).toBe("127.0.0.1");
  expect(url.port).toBe("41234");
  expect(url.pathname).toBe("/callback");
  // The token round-trips through the query string untouched.
  expect(url.searchParams.get("ott")).toBe("tok en/+=");
  expect(url.searchParams.get("state")).toBe("state-value");
});

test("with a handoff cookie, the desktop client is redirected to its listener", async () => {
  const { client, authDb } = setup();
  await createAuthTables(client);
  const token = await seedSession(authDb);
  const auth = createAuth(authDb as unknown as Db, env);
  const app = createApp({ auth });

  const response = await app.request("/api/auth-handoff", {
    headers: {
      ...bearerHeaders(token),
      cookie: `${HANDOFF_COOKIE}=41234.abcdefghijklmnopqrstuvwxyz012345`,
    },
  });

  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location") ?? "");
  expect(location.hostname).toBe("127.0.0.1");
  expect(location.port).toBe("41234");
  expect(location.searchParams.get("state")).toBe("abcdefghijklmnopqrstuvwxyz012345");
  expect((location.searchParams.get("ott") ?? "").length).toBeGreaterThan(0);
  expect(response.headers.get("cache-control")).toBe("no-store");
  // The cookie is spent: it must not survive to a second handoff.
  expect(response.headers.get("set-cookie") ?? "").toContain(HANDOFF_COOKIE);
});

test("with no session, the desktop client is redirected with a code, not a page", async () => {
  const { client, authDb } = setup();
  await createAuthTables(client);
  const auth = createAuth(authDb as unknown as Db, env);
  const app = createApp({ auth });

  const response = await app.request("/api/auth-handoff", {
    headers: { cookie: `${HANDOFF_COOKIE}=41234.abcdefghijklmnopqrstuvwxyz012345` },
  });

  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location") ?? "");
  expect(location.hostname).toBe("127.0.0.1");
  expect(location.searchParams.get("error")).toBe("UNAUTHENTICATED");
  expect(location.searchParams.get("state")).toBe("abcdefghijklmnopqrstuvwxyz012345");
});

test("a malformed handoff cookie falls back to the page rather than redirecting", async () => {
  const { client, authDb } = setup();
  await createAuthTables(client);
  const token = await seedSession(authDb);
  const auth = createAuth(authDb as unknown as Db, env);
  const app = createApp({ auth });

  const response = await app.request("/api/auth-handoff", {
    headers: { ...bearerHeaders(token), cookie: `${HANDOFF_COOKIE}=80.evil` },
  });

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/html");
});

// The page renders outside the app, so it has to be told which language the
// user picked there. Before this it followed Accept-Language, which is a
// different setting and regularly a different language.
test("the handoff page follows the app's locale, not the browser's", () => {
  expect(resolveHandoffLocale("es", "en-US,en;q=0.9")).toBe("es");
  expect(resolveHandoffLocale("en", "es-ES,es;q=0.9")).toBe("en");
  // No app locale: the browser is the fallback, not the other way round.
  expect(resolveHandoffLocale(undefined, "es-ES,es;q=0.9")).toBe("es");
  expect(resolveHandoffLocale(undefined, "en-US")).toBe("en");
  // A locale we do not ship is ignored rather than rendered blank.
  expect(resolveHandoffLocale("fr", "en-US")).toBe("en");
});

test("with a Spanish app locale the page is Spanish even for an English browser", async () => {
  const { client, authDb } = setup();
  await createAuthTables(client);
  const token = await seedSession(authDb);
  const auth = createAuth(authDb as unknown as Db, env);
  const app = createApp({ auth });

  const response = await app.request("/api/auth-handoff", {
    headers: {
      ...bearerHeaders(token),
      cookie: `${HANDOFF_LOCALE_COOKIE}=es`,
      "accept-language": "en-US,en;q=0.9",
    },
  });

  const html = await response.text();
  expect(html).toContain('lang="es"');
  expect(html).toContain("Abrir Werewolf");
});
