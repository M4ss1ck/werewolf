import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const games = sqliteTable(
  "games",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id").notNull(),
    name: text("name").notNull(),
    joinCode: text("join_code"),
    visibility: text("visibility").notNull(),
    status: text("status").notNull(),
    scheduledAt: integer("scheduled_at"),
    startedAt: integer("started_at"),
    endedAt: integer("ended_at"),
    day: integer("day").notNull().default(0),
    phase: text("phase"),
    phaseId: integer("phase_id").notNull().default(0),
    phaseStartedAt: integer("phase_started_at"),
    phaseEndsAt: integer("phase_ends_at"),
    settingsJson: text("settings_json").notNull(),
    balanceVersion: integer("balance_version").notNull(),
    nightsWithoutElimination: integer("nights_without_elimination").notNull().default(0),
    rngSeed: text("rng_seed"),
    winnerJson: text("winner_json"),
    version: integer("version").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("games_status_phase_ends_idx").on(table.status, table.phaseEndsAt),
    index("games_status_scheduled_idx").on(table.status, table.scheduledAt),
    uniqueIndex("games_join_code_idx").on(table.joinCode),
  ],
);

export const gamePlayers = sqliteTable(
  "game_players",
  {
    gameId: text("game_id").notNull(),
    userId: text("user_id").notNull(),
    displayName: text("display_name").notNull(),
    status: text("status").notNull(),
    joinedAt: integer("joined_at").notNull(),
    originalRole: text("original_role"),
    role: text("role"),
    faction: text("faction"),
    roleStateJson: text("role_state_json").notNull().default("{}"),
    phaseStateJson: text("phase_state_json").notNull().default("{}"),
    channelSinceJson: text("channel_since_json").notNull().default("{}"),
    // Null on a human seat. A bot seat stores its serialized PlayerController;
    // provider credentials live in the environment and never land here.
    controllerJson: text("controller_json"),
  },
  (table) => [
    primaryKey({ columns: [table.gameId, table.userId] }),
    index("game_players_user_game_idx").on(table.userId, table.gameId),
  ],
);

export const gameEvents = sqliteTable(
  "game_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    gameId: text("game_id").notNull(),
    kind: text("kind").notNull(),
    actorUserId: text("actor_user_id"),
    scope: text("scope").notNull(),
    scopeId: text("scope_id"),
    commandId: text("command_id"),
    payloadJson: text("payload_json").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("game_events_game_id_idx").on(table.gameId, table.id),
    uniqueIndex("game_events_game_command_idx")
      .on(table.gameId, table.commandId)
      .where(sql`${table.commandId} is not null`),
  ],
);

export const globalChatMessages = sqliteTable("global_chat_messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  displayName: text("display_name").notNull(),
  text: text("text").notNull(),
  createdAt: integer("created_at").notNull(),
});

export type GameRow = typeof games.$inferSelect;
export type PlayerRow = typeof gamePlayers.$inferSelect;
export type EventRow = typeof gameEvents.$inferSelect;
export type GlobalChatMessageRow = typeof globalChatMessages.$inferSelect;
