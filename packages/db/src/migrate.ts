import { and, eq, isNull, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import type { Db } from "./client.ts";
import { generateGameCode } from "./game-code.ts";
import { games } from "./schema.ts";

const MIGRATIONS_DIR = new URL("./migrations/", import.meta.url).pathname;

/**
 * Apply the game-table migrations (games, game_players, game_events).
 * Idempotent: Drizzle records applied migrations in its own bookkeeping
 * table, so calling this on every boot is safe.
 */
export async function applyMigrations(db: Db): Promise<void> {
  await backfillLegacyGameCodes(db);
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}

async function backfillLegacyGameCodes(db: Db): Promise<void> {
  const tables = await db.all<{ name: string }>(
    sql.raw("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'games'"),
  );
  if (tables.length === 0) return;

  const columns = await db.all<{ name: string; notnull: number }>(
    sql.raw("PRAGMA table_info(games)"),
  );
  const joinCode = columns.find((column) => column.name === "join_code");
  if (joinCode?.notnull !== 0) return;

  await db.transaction(async (tx) => {
    const nullGames = await tx.select({ id: games.id }).from(games).where(isNull(games.joinCode));
    for (const game of nullGames) {
      for (;;) {
        const code = generateGameCode();
        try {
          await tx
            .update(games)
            .set({ joinCode: code })
            .where(and(eq(games.id, game.id), isNull(games.joinCode)));
          break;
        } catch (error) {
          if (!isJoinCodeCollision(error)) throw error;
        }
      }
    }
  });
}

function isJoinCodeCollision(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; message?: unknown; cause?: unknown };
  if (
    candidate.code === "SQLITE_CONSTRAINT_UNIQUE" &&
    typeof candidate.message === "string" &&
    candidate.message.includes("UNIQUE constraint failed: games.join_code")
  )
    return true;
  return candidate.cause !== undefined && isJoinCodeCollision(candidate.cause);
}
