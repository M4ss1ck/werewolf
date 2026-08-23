// The development-only sign-in. A real Better Auth instance is built over a
// temp-file database with the auth tables applied, and seedDevUser is driven
// with a localhost env and a production env to prove the localhost gate, the
// created user's credentials, the username backfill, and the creates-never-
// updates rule.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, type Db } from "@werewolf/db";
import { normalizeMentionSearch } from "@werewolf/protocol";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { createAuth } from "./auth.ts";
import {
  DEV_USER_EMAIL,
  DEV_USER_NAME,
  DEV_USER_PASSWORD,
  isLocalInstance,
  seedDevUser,
} from "./dev-user.ts";
import { authSchema, authUser, createAuthTables } from "./schema.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "werewolf-dev-user-test-"));
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

test("isLocalInstance is true only for localhost and 127.0.0.1", () => {
  expect(isLocalInstance("http://localhost:3000")).toBe(true);
  expect(isLocalInstance("http://127.0.0.1:3000")).toBe(true);
  expect(isLocalInstance("https://werewolf.example.com")).toBe(false);
  expect(isLocalInstance("not a url")).toBe(false);
});

test("seedDevUser creates the dev user and its credentials sign in", async () => {
  const { client, authDb } = setup();
  await createAuthTables(client);
  const auth = createAuth(authDb as unknown as Db, env);
  await seedDevUser(auth, authDb as unknown as Db, env);

  const session = await auth.api.signInEmail({
    body: { email: DEV_USER_EMAIL, password: DEV_USER_PASSWORD },
  });
  expect(session.user.email).toBe(DEV_USER_EMAIL);
});

test("the seeded dev user carries the Developer username and search key", async () => {
  const { client, authDb } = setup();
  await createAuthTables(client);
  const auth = createAuth(authDb as unknown as Db, env);
  await seedDevUser(auth, authDb as unknown as Db, env);

  const rows = await authDb.select().from(authUser).where(eq(authUser.email, DEV_USER_EMAIL));
  expect(rows[0]?.username).toBe(DEV_USER_NAME);
  expect(rows[0]?.usernameSearch).toBe(normalizeMentionSearch(DEV_USER_NAME));
});

test("seedDevUser creates no user on a non-localhost deployment", async () => {
  const { client, authDb } = setup();
  await createAuthTables(client);
  const prodEnv = { ...env, BETTER_AUTH_URL: "https://werewolf.example.com" };
  const auth = createAuth(authDb as unknown as Db, prodEnv);
  await seedDevUser(auth, authDb as unknown as Db, prodEnv);

  const rows = await authDb.select().from(authUser).where(eq(authUser.email, DEV_USER_EMAIL));
  expect(rows).toHaveLength(0);
});

test("seedDevUser creates, never updates", async () => {
  const { client, authDb } = setup();
  await createAuthTables(client);
  const auth = createAuth(authDb as unknown as Db, env);
  await seedDevUser(auth, authDb as unknown as Db, env);

  await authDb
    .update(authUser)
    .set({
      username: "Renamed",
      usernameSearch: normalizeMentionSearch("Renamed"),
      updatedAt: new Date(),
    })
    .where(eq(authUser.email, DEV_USER_EMAIL));

  await seedDevUser(auth, authDb as unknown as Db, env);

  const rows = await authDb.select().from(authUser).where(eq(authUser.email, DEV_USER_EMAIL));
  expect(rows[0]?.username).toBe("Renamed");
});
