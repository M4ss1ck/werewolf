import { migrate } from "drizzle-orm/libsql/migrator";
import type { Db } from "./client.ts";

const MIGRATIONS_DIR = new URL("./migrations/", import.meta.url).pathname;

/**
 * Apply the game-table migrations (games, game_players, game_events).
 * Idempotent: Drizzle records applied migrations in its own bookkeeping
 * table, so calling this on every boot is safe.
 */
export async function applyMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}
