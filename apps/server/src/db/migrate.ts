// Standalone database bootstrap: creates a fresh database's game tables
// (Drizzle migrations) and Better Auth tables. Run with:
//
//   bun run --cwd apps/server db:migrate
//
// The server also applies both steps on boot, so this is only needed when you
// want to migrate without starting the server.

import { applyMigrations, createDb } from "@werewolf/db";
import { createAuthTables } from "../auth/schema.ts";
import { loadEnv } from "../env.ts";

const env = loadEnv();
const { client, db } = createDb(env.TURSO_DATABASE_URL, env.TURSO_AUTH_TOKEN);
await applyMigrations(db);
await createAuthTables(client);
console.log("Database migrated: game tables and Better Auth tables are ready.");
client.close();
