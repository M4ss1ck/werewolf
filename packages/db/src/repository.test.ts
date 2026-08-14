import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  DomainTransition,
  EventDraft,
  GameSettings,
  GameState,
  PlayerState,
  StoredPhaseState,
} from "@werewolf/game-engine";
import type {
  EventKind,
  EventPayloads,
  EventScope,
  GameId,
  PhaseId,
  UserId,
} from "@werewolf/protocol";
import { and, asc, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";

import { createDb, type Db } from "./client.ts";
import { GameRepository } from "./repository.ts";
import { gameEvents, gamePlayers } from "./schema.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const MIGRATIONS_DIR = new URL("./migrations/", import.meta.url).pathname;

const GAME_ID = "game-1" as GameId;
const OWNER_ID = "owner" as UserId;
const USER_IDS = ["u1", "u2", "u3", "u4", "u5"].map((id) => id as UserId);
const SETTINGS: GameSettings = {
  discussionDurationMs: 60_000,
  votingDurationMs: 60_000,
  nightDurationMs: 60_000,
  visibility: "private",
};

/** Fresh temp-file database with the migrations applied. Every call gets its
 * own unique file, so tests never share state. A file is required rather than
 * `:memory:` because the local libSQL client opens a brand-new connection after
 * every transaction, which would reset an in-memory database. */
async function setup(): Promise<{ db: Db; repo: GameRepository }> {
  const dir = mkdtempSync(join(tmpdir(), "werewolf-db-test-"));
  const { client, db } = createDb(`file:${join(dir, "test.db")}`);
  cleanups.push(() => {
    client.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return { db, repo: new GameRepository(db) };
}

async function createGame(repo: GameRepository, id: GameId = GAME_ID, createdAt = 1_000) {
  await repo.createGame({
    id,
    ownerUserId: OWNER_ID,
    name: "Test lobby",
    visibility: "private",
    status: "lobby",
    settings: SETTINGS,
    balanceVersion: 1,
    createdAt,
  });
}

function draft<K extends EventKind>(
  kind: K,
  scope: EventScope,
  payload: EventPayloads[K],
  extra: { scopeId?: string; actorUserId?: UserId; commandId?: string } = {},
): EventDraft {
  return { kind, scope, payload, ...extra } as unknown as EventDraft;
}

describe("GameRepository", () => {
  test("createGame + addPlayer + loadGameState round-trips an equivalent GameState", async () => {
    const { repo } = await setup();
    await createGame(repo);
    for (const [i, userId] of USER_IDS.entries()) {
      await repo.addPlayer({
        gameId: GAME_ID,
        userId,
        displayName: `Player ${i}`,
        status: i === USER_IDS.length - 1 ? "spectator" : "lobby",
        joinedAt: 1_000 + i,
      });
    }

    const loaded = await repo.loadGameState(GAME_ID);
    const expected: GameState = {
      id: GAME_ID,
      name: "Test lobby",
      ownerUserId: OWNER_ID,
      status: "lobby",
      scheduledAt: null,
      day: 0,
      phase: null,
      players: Object.fromEntries(
        USER_IDS.map((userId, i): [UserId, PlayerState] => [
          userId,
          {
            id: userId,
            displayName: `Player ${i}`,
            status: i === USER_IDS.length - 1 ? "spectator" : "lobby",
            originalRole: null,
            role: null,
            faction: null,
            roleState: {},
            phaseState: {} as StoredPhaseState,
          },
        ]),
      ) as GameState["players"],
      settings: SETTINGS,
      balanceVersion: 1,
      winner: null,
      version: 0,
    };
    expect(loaded).toEqual(expected);
  });

  test("commitTransition applies player patches, updates the game row and inserts events with real ids", async () => {
    const { db, repo } = await setup();
    await createGame(repo);
    await repo.addPlayer({
      gameId: GAME_ID,
      userId: USER_IDS[0]!,
      displayName: "P0",
      joinedAt: 1_000,
    });

    const result = await repo.commitTransition(
      GAME_ID,
      0,
      {
        gamePatch: {
          status: "running",
          day: 1,
          phase: { id: 7 as PhaseId, type: "night", startedAt: 2_000, endsAt: 3_000 },
        },
        playerPatches: [
          {
            playerId: USER_IDS[0]!,
            changes: {
              role: "werewolf",
              faction: "wolves",
              status: "alive",
              roleState: { seen: [] },
            },
          },
        ],
        events: [
          draft("phase.started", "public", {
            phaseId: 7 as PhaseId,
            type: "night",
            startedAt: 2_000,
            endsAt: 3_000,
          }),
          draft(
            "role.assigned",
            "player",
            { role: "werewolf", faction: "wolves" },
            { scopeId: USER_IDS[0]! },
          ),
        ],
        ephemeral: [],
      },
      5_000,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("transition should not be stale");

    expect(result.version).toBe(1);
    expect(result.events).toHaveLength(2);
    for (const event of result.events) {
      expect(Number.isInteger(event.id)).toBe(true);
      expect(event.id).toBeGreaterThan(0);
    }
    expect(result.events[1]!.id).toBeGreaterThan(result.events[0]!.id);

    const stored = await db
      .select()
      .from(gameEvents)
      .where(eq(gameEvents.gameId, GAME_ID))
      .orderBy(asc(gameEvents.id));
    expect(stored.map((row) => row.id)).toEqual(result.events.map((event) => event.id));

    const game = await repo.getGame(GAME_ID);
    expect(game?.status).toBe("running");
    expect(game?.day).toBe(1);
    expect(game?.phase).toBe("night");
    expect(game?.phaseId).toBe(7);
    expect(game?.phaseStartedAt).toBe(2_000);
    expect(game?.phaseEndsAt).toBe(3_000);
    expect(game?.version).toBe(1);

    const players = await repo.getPlayers(GAME_ID);
    const player = players.find((row) => row.userId === USER_IDS[0]);
    expect(player?.status).toBe("alive");
    expect(player?.role).toBe("werewolf");
    expect(player?.faction).toBe("wolves");
    expect(JSON.parse(player!.roleStateJson)).toEqual({ seen: [] });
  });

  test("commitTransition with a stale expectedVersion changes nothing and reports staleness", async () => {
    const { db, repo } = await setup();
    await createGame(repo);
    await repo.addPlayer({
      gameId: GAME_ID,
      userId: USER_IDS[0]!,
      displayName: "P0",
      joinedAt: 1_000,
    });

    const first = await repo.commitTransition(GAME_ID, 0, {
      playerPatches: [
        {
          playerId: USER_IDS[0]!,
          changes: { role: "seer", faction: "village", status: "alive" },
        },
      ],
      events: [
        draft(
          "role.assigned",
          "player",
          { role: "seer", faction: "village" },
          { scopeId: USER_IDS[0]! },
        ),
      ],
      ephemeral: [],
    });
    expect(first.ok).toBe(true);

    const stale: DomainTransition = {
      gamePatch: { status: "running" },
      playerPatches: [
        {
          playerId: USER_IDS[0]!,
          changes: { role: "werewolf", faction: "wolves", status: "dead" },
        },
      ],
      events: [draft("chat.message", "public", { channel: "public", text: "must not appear" })],
      ephemeral: [],
    };
    const result = await repo.commitTransition(GAME_ID, 0, stale);
    expect(result).toEqual({ ok: false, stale: true });

    const game = await repo.getGame(GAME_ID);
    expect(game?.version).toBe(1);
    expect(game?.status).toBe("lobby");

    const players = await repo.getPlayers(GAME_ID);
    expect(players.find((row) => row.userId === USER_IDS[0])?.role).toBe("seer");

    const eventRows = await db.select().from(gameEvents).where(eq(gameEvents.gameId, GAME_ID));
    expect(eventRows).toHaveLength(1);
  });

  test("committing the same command_id twice inserts exactly one event row", async () => {
    const { db, repo } = await setup();
    await createGame(repo);

    const first = await repo.commitTransition(GAME_ID, 0, {
      playerPatches: [],
      events: [
        draft(
          "chat.message",
          "public",
          { channel: "public", text: "hello" },
          { commandId: "chat-1" },
        ),
      ],
      ephemeral: [],
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("transition should not be stale");
    const firstId = first.events[0]!.id;

    const retry = await repo.commitTransition(GAME_ID, 1, {
      playerPatches: [],
      events: [
        draft(
          "chat.message",
          "public",
          { channel: "public", text: "hello retry" },
          { commandId: "chat-1" },
        ),
      ],
      ephemeral: [],
    });
    expect(retry.ok).toBe(true);

    const rows = await db
      .select()
      .from(gameEvents)
      .where(and(eq(gameEvents.gameId, GAME_ID), eq(gameEvents.commandId, "chat-1")));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(firstId);
  });

  test("getVisibleEvents returns only events after a cursor, in ascending id order", async () => {
    const { repo } = await setup();
    await createGame(repo);

    const result = await repo.commitTransition(GAME_ID, 0, {
      playerPatches: [],
      events: [
        draft("game.started", "public", {}),
        draft("chat.message", "public", { channel: "public", text: "first" }),
        draft("phase.started", "public", {
          phaseId: 1 as PhaseId,
          type: "discussion",
          startedAt: 1_000,
          endsAt: 2_000,
        }),
      ],
      ephemeral: [],
    });
    expect(result.ok).toBe(true);

    const all = await repo.getVisibleEvents(GAME_ID);
    expect(all.map((event) => event.id as number)).toEqual([1, 2, 3]);

    const afterCursor = await repo.getVisibleEvents(GAME_ID, 1);
    expect(afterCursor.map((event) => event.id as number)).toEqual([2, 3]);
    expect(afterCursor[0]?.kind).toBe("chat.message");
  });

  test("wolves.member_joined sets the converted player's wolf_since_event_id to the event's own id", async () => {
    const { db, repo } = await setup();
    await createGame(repo);
    const cursed = USER_IDS[0]!;
    await repo.addPlayer({
      gameId: GAME_ID,
      userId: cursed,
      displayName: "Cursed",
      joinedAt: 1_000,
    });

    const result = await repo.commitTransition(GAME_ID, 0, {
      gamePatch: { status: "running" },
      playerPatches: [
        {
          playerId: cursed,
          changes: { role: "werewolf", faction: "wolves", roleState: { converted: true } },
        },
      ],
      events: [
        draft("wolves.member_joined", "faction", { playerId: cursed }, { scopeId: "wolves" }),
      ],
      ephemeral: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("transition should not be stale");

    const joined = result.events.find((event) => event.kind === "wolves.member_joined");
    expect(joined).toBeDefined();
    expect(joined!.id).toBeGreaterThan(0);

    const rows = await db
      .select()
      .from(gamePlayers)
      .where(and(eq(gamePlayers.gameId, GAME_ID), eq(gamePlayers.userId, cursed)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.wolfSinceEventId).toBe(joined!.id);
  });
});
