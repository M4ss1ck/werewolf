// Bearer-token authentication. A real Better Auth instance is built over a
// temp-file database with the auth tables applied, a user and session are
// inserted through the drizzle auth schema, and resolveAuthSession is driven
// with the token presented as an Authorization header, as a WebSocket
// subprotocol, or not at all.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, type Db } from "@werewolf/db";
import { drizzle } from "drizzle-orm/libsql";
import { createAuth, resolveAuthSession } from "./auth.ts";
import { authSchema, createAuthTables } from "./schema.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "werewolf-auth-test-"));
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

async function seedSession(
  authDb: ReturnType<typeof drizzle<typeof authSchema>>,
  token = "session-token-1",
) {
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
    token,
    expiresAt: new Date(now + 60_000),
    createdAt: new Date(now),
    updatedAt: new Date(now),
    userId: "user-1",
  });
  return token;
}

test("an Authorization: Bearer header authenticates one of werewolf's own routes", async () => {
  const { client, authDb } = setup();
  await createAuthTables(client);
  const token = await seedSession(authDb);
  const auth = createAuth(authDb as unknown as Db, env);

  const viewer = await resolveAuthSession(
    auth,
    new Request("http://localhost/api/games", {
      headers: { authorization: `Bearer ${token}` },
    }),
  );

  expect(viewer).toEqual({ userId: "user-1", username: "alice" });
});

test("a browser-safe WebSocket bearer subprotocol resolves to the same viewer", async () => {
  const { client, authDb } = setup();
  await createAuthTables(client);
  await seedSession(authDb, "session/token=");
  const auth = createAuth(authDb as unknown as Db, env);

  const viewer = await resolveAuthSession(
    auth,
    new Request("http://localhost/api/games/g-1/live", {
      headers: { "sec-websocket-protocol": "bearer, c2Vzc2lvbi90b2tlbj0" },
    }),
  );

  expect(viewer).toEqual({ userId: "user-1", username: "alice" });
});

test("a request with neither header resolves to no viewer", async () => {
  const { client, authDb } = setup();
  await createAuthTables(client);
  await seedSession(authDb);
  const auth = createAuth(authDb as unknown as Db, env);

  const viewer = await resolveAuthSession(auth, new Request("http://localhost/api/games"));

  expect(viewer).toBeNull();
});

test("a malformed subprotocol resolves to no viewer rather than throwing", async () => {
  const { client, authDb } = setup();
  await createAuthTables(client);
  await seedSession(authDb);
  const auth = createAuth(authDb as unknown as Db, env);

  for (const protocol of ["bearer", "notbearer, session-token-1", "bearer, "]) {
    const viewer = await resolveAuthSession(
      auth,
      new Request("http://localhost/api/games/g-1/live", {
        headers: { "sec-websocket-protocol": protocol },
      }),
    );
    expect(viewer).toBeNull();
  }
});
