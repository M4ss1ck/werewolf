import { afterEach, expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createDb } from "./client.ts";
import { applyMigrations } from "./migrate.ts";

const MIGRATIONS_DIR = new URL("./migrations/", import.meta.url).pathname;
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

test("fresh databases apply the complete game migration chain", async () => {
  const { client, db } = createDb(":memory:");
  try {
    await applyMigrations(db);
    const result = await client.execute("select name from sqlite_master where type = 'table'");
    expect(result.rows.some((row) => row.name === "games")).toBe(true);
  } finally {
    client.close();
  }
});

test("legacy nullable codes are backfilled before the non-null migration", async () => {
  const root = mkdtempSync(join(tmpdir(), "werewolf-migrations-"));
  const legacy = join(root, "legacy");
  const legacyMeta = join(legacy, "meta");
  mkdirSync(legacyMeta, { recursive: true });
  for (let index = 0; index <= 6; index += 1) {
    const sqlName = readFileName(MIGRATIONS_DIR, index, ".sql");
    const snapshotName = readFileName(join(MIGRATIONS_DIR, "meta"), index, "_snapshot.json");
    cpSync(join(MIGRATIONS_DIR, sqlName), join(legacy, sqlName));
    cpSync(join(MIGRATIONS_DIR, "meta", snapshotName), join(legacyMeta, snapshotName));
  }
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
  ) as { version: string; dialect: string; entries: unknown[] };
  writeFileSync(
    join(legacyMeta, "_journal.json"),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, 7) }),
  );

  const dbDir = mkdtempSync(join(tmpdir(), "werewolf-db-upgrade-"));
  const { client, db } = createDb(`file:${join(dbDir, "test.db")}`);
  cleanups.push(() => {
    client.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  });

  await migrate(db, { migrationsFolder: legacy });
  await client.execute(
    "insert into games (id, owner_user_id, name, join_code, visibility, status, scheduled_at, started_at, ended_at, day, phase, phase_id, phase_started_at, phase_ends_at, settings_json, balance_version, nights_without_elimination, rng_seed, winner_json, version, created_at) values ('legacy-a', 'owner-a', 'Legacy A', null, 'private', 'finished', 111, 222, 333, 4, 'discussion', 7, 444, 555, '{\"discussionDurationMs\":7}', 9, 2, 'seed-a', '{\"faction\":\"wolves\"}', 8, 99)",
  );
  await client.execute(
    "insert into games (id, owner_user_id, name, join_code, visibility, status, settings_json, balance_version, created_at) values ('legacy-b', 'owner-b', 'Legacy B', null, 'public', 'lobby', '{}', 1, 2)",
  );
  await client.execute(
    "insert into game_players (game_id, user_id, display_name, status, joined_at, original_role, role, faction, role_state_json, phase_state_json, channel_since_json, controller_json) values ('legacy-a', 'player-a', 'Player A', 'alive', 123, 'villager', 'seer', 'village', '{\"seen\":true}', '{\"phaseId\":7}', '{\"grave\":3}', null)",
  );
  await applyMigrations(db);

  const preserved = await client.execute(
    "select owner_user_id, name, visibility, status, scheduled_at, started_at, ended_at, day, phase, phase_id, phase_started_at, phase_ends_at, settings_json, balance_version, nights_without_elimination, rng_seed, winner_json, version, created_at from games where id = 'legacy-a'",
  );
  expect(preserved.rows[0]).toMatchObject({
    owner_user_id: "owner-a",
    name: "Legacy A",
    visibility: "private",
    status: "finished",
    scheduled_at: 111,
    started_at: 222,
    ended_at: 333,
    day: 4,
    phase: "discussion",
    phase_id: 7,
    phase_started_at: 444,
    phase_ends_at: 555,
    settings_json: '{"discussionDurationMs":7}',
    balance_version: 9,
    nights_without_elimination: 2,
    rng_seed: "seed-a",
    winner_json: '{"faction":"wolves"}',
    version: 8,
    created_at: 99,
  });
  const preservedPlayer = await client.execute(
    "select display_name, status, joined_at, original_role, role, faction, role_state_json, phase_state_json, channel_since_json, controller_json, membership_access from game_players where game_id = 'legacy-a' and user_id = 'player-a'",
  );
  expect(preservedPlayer.rows[0]).toMatchObject({
    display_name: "Player A",
    status: "alive",
    joined_at: 123,
    original_role: "villager",
    role: "seer",
    faction: "village",
    role_state_json: '{"seen":true}',
    phase_state_json: '{"phaseId":7}',
    channel_since_json: '{"grave":3}',
    controller_json: null,
    membership_access: "active",
  });

  const rows = await client.execute(
    "select join_code from games where id in ('legacy-a', 'legacy-b') order by id",
  );
  const codes = rows.rows.map((row) => row.join_code);
  expect(codes).toHaveLength(2);
  expect(codes[0]).toBeString();
  expect(codes[1]).toBeString();
  expect(codes[0]).not.toBe(codes[1]);
  expect(String(codes[0])).toMatch(/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{10}$/);

  const indexes = await client.execute(
    "select name from sqlite_master where type = 'index' and name in ('games_status_phase_ends_idx', 'games_status_scheduled_idx', 'games_join_code_idx', 'game_players_user_game_idx', 'game_events_game_id_idx', 'game_events_game_command_idx') order by name",
  );
  expect(indexes.rows.map((row) => row.name)).toEqual([
    "game_events_game_command_idx",
    "game_events_game_id_idx",
    "game_players_user_game_idx",
    "games_join_code_idx",
    "games_status_phase_ends_idx",
    "games_status_scheduled_idx",
  ]);
  const gameIndexes = await client.execute("pragma index_list('games')");
  expect(gameIndexes.rows.find((row) => row.name === "games_join_code_idx")?.unique).toBe(1);

  await expect(
    client.execute(
      "insert into games (id, owner_user_id, name, join_code, visibility, status, settings_json, balance_version, created_at) values ('legacy-null', 'owner', 'Null', null, 'private', 'lobby', '{}', 1, 3)",
    ),
  ).rejects.toThrow();
});

function readFileName(directory: string, index: number, suffix: string): string {
  const prefix = `${String(index).padStart(4, "0")}_`;
  const entry = readdirSync(directory).find((name) => {
    return name.startsWith(prefix) && name.endsWith(suffix);
  });
  if (entry === undefined) throw new Error(`missing migration ${prefix}${suffix}`);
  return entry;
}
