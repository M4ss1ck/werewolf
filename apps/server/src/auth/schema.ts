// Better Auth owns its own tables. They intentionally live here in
// apps/server, NOT in @werewolf/db: the db package is limited to the three
// game tables. The drizzle schema is what the Drizzle adapter reads and
// writes; the SQL below is what creates the physical tables. Keep the two in
// sync (column names and types) — the layout matches what `better-auth`
// generates for SQLite: camelCase columns, integer timestamps in ms and
// integer booleans.

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const authUser = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  username: text("username"),
  email: text("email").notNull().unique(),
  emailVerified: integer("emailVerified", { mode: "boolean" }).notNull(),
  image: text("image"),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
});

export const authSession = sqliteTable("session", {
  id: text("id").primaryKey(),
  expiresAt: integer("expiresAt", { mode: "timestamp_ms" }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
  ipAddress: text("ipAddress"),
  userAgent: text("userAgent"),
  userId: text("userId")
    .notNull()
    .references(() => authUser.id),
});

export const authAccount = sqliteTable("account", {
  id: text("id").primaryKey(),
  accountId: text("accountId").notNull(),
  providerId: text("providerId").notNull(),
  userId: text("userId")
    .notNull()
    .references(() => authUser.id),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  idToken: text("idToken"),
  accessTokenExpiresAt: integer("accessTokenExpiresAt", { mode: "timestamp_ms" }),
  refreshTokenExpiresAt: integer("refreshTokenExpiresAt", { mode: "timestamp_ms" }),
  scope: text("scope"),
  password: text("password"),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
});

export const authVerification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expiresAt", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
});

export const authSchema = {
  user: authUser,
  session: authSession,
  account: authAccount,
  verification: authVerification,
};

export const AUTH_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS "user" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "username" text,
  "email" text NOT NULL UNIQUE,
  "emailVerified" integer NOT NULL,
  "image" text,
  "createdAt" integer NOT NULL,
  "updatedAt" integer NOT NULL
);
CREATE TABLE IF NOT EXISTS "session" (
  "id" text PRIMARY KEY NOT NULL,
  "expiresAt" integer NOT NULL,
  "token" text NOT NULL UNIQUE,
  "createdAt" integer NOT NULL,
  "updatedAt" integer NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "userId" text NOT NULL REFERENCES "user" ("id")
);
CREATE TABLE IF NOT EXISTS "account" (
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
CREATE TABLE IF NOT EXISTS "verification" (
  "id" text PRIMARY KEY NOT NULL,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expiresAt" integer NOT NULL,
  "createdAt" integer NOT NULL,
  "updatedAt" integer NOT NULL
);
`;

/**
 * Create the Better Auth tables. Idempotent, so it is safe to run on every
 * boot. Takes the libsql client structurally to avoid a direct dependency.
 */
export async function createAuthTables(client: {
  executeMultiple: (sql: string) => Promise<unknown>;
}): Promise<void> {
  await client.executeMultiple(AUTH_TABLES_SQL);
  // Databases created before usernames existed still need the column, and
  // SQLite has no ADD COLUMN IF NOT EXISTS: a duplicate-column error here is
  // the success case, not a failure.
  try {
    await client.executeMultiple(`ALTER TABLE "user" ADD COLUMN "username" text;`);
  } catch {
    // Already present.
  }
}
