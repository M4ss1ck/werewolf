// Better Auth 1.7 identifies an external account by (issuer, accountId) rather
// than by providerId alone, which means every account row written by 1.6 needs
// an issuer before 1.7 can use it. These tests build a genuine 1.6-shaped
// database — the account table exactly as AUTH_TABLES_SQL declared it before
// the column existed — run createAuthTables over it, and then drive Better
// Auth 1.7 against the migrated rows.
//
// The point is regression evidence, not coverage: a backfill that writes the
// wrong issuer leaves an account that still SELECTs fine and can no longer be
// signed in to.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, type Db } from "@werewolf/db";
import { drizzle } from "drizzle-orm/libsql";
import { createAuth, resolveAuthSession } from "./auth.ts";
import { DEV_USER_EMAIL, DEV_USER_PASSWORD } from "./dev-user.ts";
import { authSchema, createAuthTables } from "./schema.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const env = {
  PORT: 3000,
  TURSO_DATABASE_URL: "file:test.db",
  BETTER_AUTH_SECRET: "test-secret-that-is-long-enough-for-hmac",
  BETTER_AUTH_URL: "http://localhost:3000",
  BETTER_AUTH_TRUSTED_ORIGINS: [],
  GOOGLE_CLIENT_ID: "google-id",
  GOOGLE_CLIENT_SECRET: "google-secret",
};

/** The account table precisely as 1.6 left it: no issuer column at all. */
const LEGACY_SQL = `
CREATE TABLE "user" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "username" text,
  "usernameSearch" text,
  "email" text NOT NULL UNIQUE,
  "emailVerified" integer NOT NULL,
  "image" text,
  "createdAt" integer NOT NULL,
  "updatedAt" integer NOT NULL
);
CREATE TABLE "session" (
  "id" text PRIMARY KEY NOT NULL,
  "expiresAt" integer NOT NULL,
  "token" text NOT NULL UNIQUE,
  "createdAt" integer NOT NULL,
  "updatedAt" integer NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "userId" text NOT NULL REFERENCES "user" ("id")
);
CREATE TABLE "account" (
  "id" text PRIMARY KEY NOT NULL,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES "user" ("id"),
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" integer,
  "refreshTokenExpiresAt" integer,
  "scope" text,
  "password" text,
  "createdAt" integer NOT NULL,
  "updatedAt" integer NOT NULL
);
CREATE TABLE "verification" (
  "id" text PRIMARY KEY NOT NULL,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expiresAt" integer NOT NULL,
  "createdAt" integer NOT NULL,
  "updatedAt" integer NOT NULL
);
`;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "werewolf-issuer-test-"));
  const { client } = createDb(`file:${join(dir, "test.db")}`);
  cleanups.push(() => {
    client.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const authDb = drizzle(client, { schema: authSchema });
  return { client, authDb };
}

/**
 * A database as 1.6 left it: one Google user and one email+password user, the
 * second with a real Better Auth password hash so it can actually sign in.
 * Both account rows are shaped the way 1.6 wrote them — note that 1.6 already
 * stored the user's own id as a credential account's accountId, which is what
 * makes the backfill a pure issuer assignment with no id rewrite.
 */
async function seedLegacy(client: ReturnType<typeof setup>["client"]) {
  await client.executeMultiple(LEGACY_SQL);
  const now = Date.now();

  // Produce a genuine password hash by letting 1.7 sign a throwaway user up in
  // a separate database, then copy the hash across. Hand-writing one would
  // only prove that our own hash format matches itself.
  const scratchDir = mkdtempSync(join(tmpdir(), "werewolf-issuer-hash-"));
  const scratch = createDb(`file:${join(scratchDir, "hash.db")}`);
  cleanups.push(() => {
    scratch.client.close();
    rmSync(scratchDir, { recursive: true, force: true });
  });
  await createAuthTables(scratch.client);
  const scratchAuth = createAuth(
    drizzle(scratch.client, { schema: authSchema }) as unknown as Db,
    env,
  );
  await scratchAuth.api.signUpEmail({
    body: { email: DEV_USER_EMAIL, password: DEV_USER_PASSWORD, name: "Developer" },
  });
  const hashRow = await scratch.client.execute(
    `SELECT "password" FROM "account" WHERE "providerId" = 'credential'`,
  );
  const passwordHash = hashRow.rows[0]?.password;
  if (typeof passwordHash !== "string") throw new Error("no password hash to copy");

  const people: [id: string, email: string, name: string][] = [
    ["google-user", "player@example.com", "Player"],
    ["credential-user", DEV_USER_EMAIL, "Developer"],
  ];
  for (const [id, email, name] of people) {
    await client.execute({
      sql: `INSERT INTO "user" ("id","name","username","usernameSearch","email","emailVerified","createdAt","updatedAt")
            VALUES (?,?,?,?,?,0,?,?)`,
      args: [id, name, name, name.toLowerCase(), email, now, now],
    });
  }
  // Google: accountId is the provider's `sub`.
  await client.execute({
    sql: `INSERT INTO "account" ("id","accountId","providerId","userId","createdAt","updatedAt")
          VALUES (?,?,?,?,?,?)`,
    args: ["acc-google", "106831397493652350578", "google", "google-user", now, now],
  });
  // Credential: accountId is the user's own id.
  await client.execute({
    sql: `INSERT INTO "account" ("id","accountId","providerId","userId","password","createdAt","updatedAt")
          VALUES (?,?,?,?,?,?,?)`,
    args: [
      "acc-credential",
      "credential-user",
      "credential",
      "credential-user",
      passwordHash,
      now,
      now,
    ],
  });
  return { passwordHash };
}

test("the migration backfills the issuer each provider should carry", async () => {
  const { client } = setup();
  await seedLegacy(client);

  await createAuthTables(client);

  const rows = await client.execute(`SELECT "id", "issuer" FROM "account" ORDER BY "id"`);
  expect(rows.rows.map((row) => [row.id, row.issuer])).toEqual([
    ["acc-credential", "local:credential"],
    ["acc-google", "https://accounts.google.com"],
  ]);
});

test("an unrecognised provider gets the documented local:oauth fallback, never NULL", async () => {
  const { client } = setup();
  await seedLegacy(client);
  const now = Date.now();
  await client.execute({
    sql: `INSERT INTO "account" ("id","accountId","providerId","userId","createdAt","updatedAt")
          VALUES (?,?,?,?,?,?)`,
    args: ["acc-other", "sub-999", "github", "google-user", now, now],
  });

  await createAuthTables(client);

  const rows = await client.execute(`SELECT "issuer" FROM "account" WHERE "id" = 'acc-other'`);
  expect(rows.rows[0]?.issuer).toBe("local:oauth:github");
  const nulls = await client.execute(`SELECT COUNT(*) AS n FROM "account" WHERE "issuer" IS NULL`);
  expect(Number(nulls.rows[0]?.n)).toBe(0);
});

test("a migrated email+password account can still sign in", async () => {
  const { client, authDb } = setup();
  await seedLegacy(client);
  await createAuthTables(client);

  const auth = createAuth(authDb as unknown as Db, env);
  const session = await auth.api.signInEmail({
    body: { email: DEV_USER_EMAIL, password: DEV_USER_PASSWORD },
  });

  expect(session.user.id).toBe("credential-user");
});

test("a migrated Google account is still linked to its user", async () => {
  const { client, authDb } = setup();
  await seedLegacy(client);
  await createAuthTables(client);
  const now = Date.now();
  await client.execute({
    sql: `INSERT INTO "session" ("id","expiresAt","token","createdAt","updatedAt","userId")
          VALUES (?,?,?,?,?,?)`,
    args: ["sess-google", now + 3_600_000, "google-session-token", now, now, "google-user"],
  });

  const auth = createAuth(authDb as unknown as Db, env);
  const accounts = await auth.api.listUserAccounts({
    headers: new Headers({ Authorization: "Bearer google-session-token" }),
  });

  expect(accounts.map((account) => account.providerId)).toEqual(["google"]);
});

test("a session issued before the migration still resolves afterwards", async () => {
  const { client, authDb } = setup();
  await seedLegacy(client);
  const now = Date.now();
  await client.execute({
    sql: `INSERT INTO "session" ("id","expiresAt","token","createdAt","updatedAt","userId")
          VALUES (?,?,?,?,?,?)`,
    args: ["sess-old", now + 3_600_000, "pre-migration-token", now, now, "google-user"],
  });

  await createAuthTables(client);

  const auth = createAuth(authDb as unknown as Db, env);
  const viewer = await resolveAuthSession(
    auth,
    new Request("http://localhost:3000/api/games", {
      headers: { Authorization: "Bearer pre-migration-token" },
    }),
  );

  expect(viewer?.userId).toBe("google-user");
});

test("the migration is idempotent across repeated boots", async () => {
  const { client } = setup();
  await seedLegacy(client);

  await createAuthTables(client);
  await createAuthTables(client);
  await createAuthTables(client);

  const rows = await client.execute(`SELECT "issuer" FROM "account" ORDER BY "id"`);
  expect(rows.rows.map((row) => row.issuer)).toEqual([
    "local:credential",
    "https://accounts.google.com",
  ]);
});

test("(issuer, accountId) is unique after the migration", async () => {
  const { client } = setup();
  await seedLegacy(client);
  await createAuthTables(client);
  const now = Date.now();

  // The same Google sub linked a second time must now be refused by the index,
  // which is the invariant 1.7 relies on.
  const duplicate = client.execute({
    sql: `INSERT INTO "account" ("id","issuer","accountId","providerId","userId","createdAt","updatedAt")
          VALUES (?,?,?,?,?,?,?)`,
    args: [
      "acc-dup",
      "https://accounts.google.com",
      "106831397493652350578",
      "google",
      "credential-user",
      now,
      now,
    ],
  });

  await expect(duplicate).rejects.toThrow(/UNIQUE|constraint/i);
});
