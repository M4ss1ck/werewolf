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
  EventId,
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
  test("maps legacy chat events without mentions to an empty mention list", async () => {
    const { db, repo } = await setup();
    await createGame(repo);
    await db.insert(gameEvents).values({
      gameId: GAME_ID,
      kind: "chat.message",
      actorUserId: USER_IDS[0]!,
      scope: "public",
      payloadJson: JSON.stringify({ channel: "public", text: "legacy message" }),
      createdAt: 1_001,
    });

    const [event] = await repo.getVisibleEvents(GAME_ID);

    expect(event).toMatchObject({
      kind: "chat.message",
      payload: { channel: "public", text: "legacy message", mentions: [] },
    });
  });

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
      nightsWithoutElimination: 0,
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
      events: [
        draft("chat.message", "public", {
          channel: "public",
          text: "must not appear",
          mentions: [],
        }),
      ],
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
          { channel: "public", text: "hello", mentions: [] },
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
          { channel: "public", text: "hello retry", mentions: [] },
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
        draft("chat.message", "public", {
          channel: "public",
          text: "first",
          mentions: [],
        }),
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

  test("listGameSummaries returns public non-cancelled games, oldest first, with players grouped", async () => {
    const { repo } = await setup();
    await repo.createGame({
      id: "g-public-1" as GameId,
      ownerUserId: OWNER_ID,
      name: "Public 1",
      visibility: "public",
      status: "lobby",
      settings: SETTINGS,
      balanceVersion: 1,
      createdAt: 1_000,
    });
    await repo.createGame({
      id: "g-public-2" as GameId,
      ownerUserId: OWNER_ID,
      name: "Public 2",
      visibility: "public",
      status: "lobby",
      settings: SETTINGS,
      balanceVersion: 1,
      createdAt: 3_000,
    });
    await repo.createGame({
      id: "g-private" as GameId,
      ownerUserId: OWNER_ID,
      name: "Private",
      visibility: "private",
      status: "lobby",
      settings: SETTINGS,
      balanceVersion: 1,
      createdAt: 2_000,
    });
    await repo.createGame({
      id: "g-cancelled" as GameId,
      ownerUserId: OWNER_ID,
      name: "Cancelled",
      visibility: "public",
      status: "cancelled",
      settings: SETTINGS,
      balanceVersion: 1,
      createdAt: 1_500,
    });
    await repo.addPlayer({
      gameId: "g-public-1" as GameId,
      userId: USER_IDS[0]!,
      displayName: "P0",
      joinedAt: 1_000,
    });
    await repo.addPlayer({
      gameId: "g-public-1" as GameId,
      userId: USER_IDS[1]!,
      displayName: "P1",
      joinedAt: 1_001,
    });
    await repo.addPlayer({
      gameId: "g-public-2" as GameId,
      userId: USER_IDS[0]!,
      displayName: "P0",
      joinedAt: 3_000,
    });

    const summaries = await repo.listGameSummaries();
    expect(summaries.map((row) => row.id as string)).toEqual(["g-public-1", "g-public-2"]);
    const first = summaries[0]!;
    expect(first.name).toBe("Public 1");
    expect(first.ownerUserId).toBe(OWNER_ID);
    expect(first.status).toBe("lobby");
    expect(first.players).toEqual([
      { userId: USER_IDS[0]!, displayName: "P0" },
      { userId: USER_IDS[1]!, displayName: "P1" },
    ]);
    expect(summaries[1]!.players).toEqual([{ userId: USER_IDS[0]!, displayName: "P0" }]);
  });

  test("listGameSummaries carries phase and schedule columns when set", async () => {
    const { repo } = await setup();
    await repo.createGame({
      id: "g-running" as GameId,
      ownerUserId: OWNER_ID,
      name: "Running",
      visibility: "public",
      status: "running",
      settings: SETTINGS,
      balanceVersion: 1,
      createdAt: 1_000,
    });
    await repo.createGame({
      id: "g-scheduled" as GameId,
      ownerUserId: OWNER_ID,
      name: "Scheduled",
      visibility: "public",
      status: "scheduled",
      settings: SETTINGS,
      balanceVersion: 1,
      scheduledAt: 5_000,
      createdAt: 2_000,
    });
    const commit = await repo.commitTransition(
      "g-running" as GameId,
      0,
      {
        gamePatch: {
          status: "running",
          day: 2,
          phase: {
            id: 9 as PhaseId,
            type: "discussion",
            startedAt: 4_000,
            endsAt: 4_100,
          },
        },
        playerPatches: [],
        events: [],
        ephemeral: [],
      },
      4_000,
    );
    expect(commit.ok).toBe(true);

    const summaries = await repo.listGameSummaries();
    expect(summaries).toHaveLength(2);
    expect(summaries[0]!.day).toBe(2);
    expect(summaries[0]!.phase).toBe("discussion");
    expect(summaries[0]!.phaseEndsAt).toBe(4_100);
    expect(summaries[0]!.scheduledAt).toBeNull();
    expect(summaries[1]!.phase).toBeNull();
    expect(summaries[1]!.scheduledAt).toBe(5_000);
  });

  test("getUserStats is all zeros for a player with no finished games", async () => {
    const { repo } = await setup();
    await createGame(repo);
    await repo.addPlayer({
      gameId: GAME_ID,
      userId: USER_IDS[0]!,
      displayName: "P0",
      status: "lobby",
      joinedAt: 1_000,
    });

    expect(await repo.getUserStats(USER_IDS[0]!)).toEqual({ games: 0, survived: 0, asWolf: 0 });
  });

  test("getUserStats counts finished games, survivors and wolves in one aggregate", async () => {
    const { repo } = await setup();
    // One finished game: the player survives as a wolf.
    await repo.createGame({
      id: "g-wolf" as GameId,
      ownerUserId: OWNER_ID,
      name: "Wolf game",
      visibility: "private",
      status: "finished",
      settings: SETTINGS,
      balanceVersion: 1,
      createdAt: 1_000,
    });
    await repo.addPlayer({
      gameId: "g-wolf" as GameId,
      userId: USER_IDS[0]!,
      displayName: "P0",
      status: "alive",
      faction: "wolves",
      joinedAt: 1_000,
    });
    await repo.addPlayer({
      gameId: "g-wolf" as GameId,
      userId: USER_IDS[1]!,
      displayName: "P1",
      status: "dead",
      faction: "village",
      joinedAt: 1_001,
    });
    // A second finished game: the player dies as a villager.
    await repo.createGame({
      id: "g-village" as GameId,
      ownerUserId: OWNER_ID,
      name: "Village game",
      visibility: "private",
      status: "finished",
      settings: SETTINGS,
      balanceVersion: 1,
      createdAt: 2_000,
    });
    await repo.addPlayer({
      gameId: "g-village" as GameId,
      userId: USER_IDS[0]!,
      displayName: "P0",
      status: "dead",
      faction: "village",
      joinedAt: 2_000,
    });

    expect(await repo.getUserStats(USER_IDS[0]!)).toEqual({ games: 2, survived: 1, asWolf: 1 });
  });

  test("getUserStats excludes spectators and unfinished games", async () => {
    const { repo } = await setup();
    // Spectated finished game: the player never played.
    await repo.createGame({
      id: "g-spectated" as GameId,
      ownerUserId: OWNER_ID,
      name: "Spectated",
      visibility: "private",
      status: "finished",
      settings: SETTINGS,
      balanceVersion: 1,
      createdAt: 1_000,
    });
    await repo.addPlayer({
      gameId: "g-spectated" as GameId,
      userId: USER_IDS[0]!,
      displayName: "P0",
      status: "spectator",
      joinedAt: 1_000,
    });
    // Unfinished game: the player is alive and a wolf, but it has not ended.
    await repo.createGame({
      id: "g-running" as GameId,
      ownerUserId: OWNER_ID,
      name: "Running",
      visibility: "private",
      status: "running",
      settings: SETTINGS,
      balanceVersion: 1,
      createdAt: 2_000,
    });
    await repo.addPlayer({
      gameId: "g-running" as GameId,
      userId: USER_IDS[0]!,
      displayName: "P0",
      status: "alive",
      faction: "wolves",
      joinedAt: 2_000,
    });

    expect(await repo.getUserStats(USER_IDS[0]!)).toEqual({ games: 0, survived: 0, asWolf: 0 });
  });

  test("wolves.member_joined sets the converted player's channel_since_json wolves marker to the event's own id", async () => {
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
    expect(JSON.parse(rows[0]!.channelSinceJson)).toEqual({ wolves: joined!.id });
  });

  test("commitTransition returns one mapped event per draft when two share a kind and createdAt", async () => {
    const { db, repo } = await setup();
    await createGame(repo);

    const result = await repo.commitTransition(GAME_ID, 0, {
      gamePatch: { status: "running" },
      playerPatches: [],
      events: [
        draft("night.resolved", "public", { deaths: [USER_IDS[1]!, USER_IDS[2]!] }),
        draft("player.eliminated", "public", {
          playerId: USER_IDS[1]!,
          role: "werewolf",
          cause: "night",
        }),
        draft("player.eliminated", "public", {
          playerId: USER_IDS[2]!,
          role: "villager",
          cause: "night",
        }),
      ],
      ephemeral: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("transition should not be stale");

    // One mapped event per draft, in draft order.
    expect(result.events.map((event) => event.kind)).toEqual([
      "night.resolved",
      "player.eliminated",
      "player.eliminated",
    ]);
    // All ids are distinct and ascending in insert order.
    const ids = result.events.map((event) => event.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    // Payloads line up with the drafts: the second elimination names the second player.
    expect(result.events[1]!.payload).toEqual({
      playerId: USER_IDS[1]!,
      role: "werewolf",
      cause: "night",
    });
    expect(result.events[2]!.payload).toEqual({
      playerId: USER_IDS[2]!,
      role: "villager",
      cause: "night",
    });
    // The returned ids are the stored rows' ids in id order.
    const stored = await db
      .select()
      .from(gameEvents)
      .where(eq(gameEvents.gameId, GAME_ID))
      .orderBy(asc(gameEvents.id));
    expect(stored.map((row) => row.id)).toEqual(ids);
  });

  test("wolves.member_joined with two converts sets each channel_since_json wolves marker to its own event's id", async () => {
    const { db, repo } = await setup();
    await createGame(repo);
    const first = USER_IDS[0]!;
    const second = USER_IDS[1]!;
    await repo.addPlayer({
      gameId: GAME_ID,
      userId: first,
      displayName: "Cursed 1",
      joinedAt: 1_000,
    });
    await repo.addPlayer({
      gameId: GAME_ID,
      userId: second,
      displayName: "Cursed 2",
      joinedAt: 1_001,
    });

    const result = await repo.commitTransition(GAME_ID, 0, {
      gamePatch: { status: "running" },
      playerPatches: [],
      events: [
        draft("wolves.member_joined", "faction", { playerId: first }, { scopeId: "wolves" }),
        draft("wolves.member_joined", "faction", { playerId: second }, { scopeId: "wolves" }),
      ],
      ephemeral: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("transition should not be stale");

    const joined = result.events.filter((event) => event.kind === "wolves.member_joined");
    expect(joined).toHaveLength(2);
    expect(joined[0]!.payload).toEqual({ playerId: first });
    expect(joined[1]!.payload).toEqual({ playerId: second });
    expect(joined[1]!.id).not.toBe(joined[0]!.id);

    const firstRow = (
      await db
        .select()
        .from(gamePlayers)
        .where(and(eq(gamePlayers.gameId, GAME_ID), eq(gamePlayers.userId, first)))
    )[0]!;
    const secondRow = (
      await db
        .select()
        .from(gamePlayers)
        .where(and(eq(gamePlayers.gameId, GAME_ID), eq(gamePlayers.userId, second)))
    )[0]!;
    const ownEventId = new Map(joined.map((event) => [event.payload.playerId, event.id]));
    expect(JSON.parse(firstRow.channelSinceJson)).toEqual({ wolves: ownEventId.get(first)! });
    expect(JSON.parse(secondRow.channelSinceJson)).toEqual({ wolves: ownEventId.get(second)! });
  });

  test("channelSince round-trips through the database", async () => {
    const { repo } = await setup();
    await createGame(repo);
    const playerId = USER_IDS[0]!;
    await repo.addPlayer({
      gameId: GAME_ID,
      userId: playerId,
      displayName: "P0",
      joinedAt: 1_000,
    });

    await repo.commitTransition(GAME_ID, 0, {
      gamePatch: { status: "running" },
      playerPatches: [
        {
          playerId,
          changes: { channelSince: { wolves: 7 as EventId, grave: 3 as EventId } },
        },
      ],
      events: [],
      ephemeral: [],
    });

    const loaded = await repo.loadGameState(GAME_ID);
    expect(loaded!.players[playerId]!.channelSince).toEqual({
      wolves: 7 as EventId,
      grave: 3 as EventId,
    } as PlayerState["channelSince"]);
  });

  test("a second member_joined style write merges rather than replacing an existing marker for a different channel", async () => {
    const { db, repo } = await setup();
    await createGame(repo);
    const playerId = USER_IDS[0]!;
    await repo.addPlayer({
      gameId: GAME_ID,
      userId: playerId,
      displayName: "P0",
      joinedAt: 1_000,
    });

    // Seed a marker for a different channel (e.g. grave) via a player patch.
    await repo.commitTransition(GAME_ID, 0, {
      gamePatch: { status: "running" },
      playerPatches: [{ playerId, changes: { channelSince: { grave: 3 as EventId } } }],
      events: [],
      ephemeral: [],
    });

    // A wolves.member_joined write must merge, not overwrite, the grave marker.
    const result = await repo.commitTransition(GAME_ID, 1, {
      gamePatch: {},
      playerPatches: [],
      events: [draft("wolves.member_joined", "faction", { playerId }, { scopeId: "wolves" })],
      ephemeral: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("transition should not be stale");
    const joined = result.events.find((event) => event.kind === "wolves.member_joined")!;

    const rows = await db
      .select()
      .from(gamePlayers)
      .where(and(eq(gamePlayers.gameId, GAME_ID), eq(gamePlayers.userId, playerId)));
    expect(JSON.parse(rows[0]!.channelSinceJson)).toEqual({
      grave: 3,
      wolves: joined.id,
    });
  });

  test("cult.member_joined sets the converted player's channel_since_json cult marker to the event's own id", async () => {
    const { db, repo } = await setup();
    await createGame(repo);
    const convert = USER_IDS[0]!;
    await repo.addPlayer({
      gameId: GAME_ID,
      userId: convert,
      displayName: "Convert",
      joinedAt: 1_000,
    });

    const result = await repo.commitTransition(GAME_ID, 0, {
      gamePatch: { status: "running" },
      playerPatches: [
        {
          playerId: convert,
          changes: { role: "cultist", faction: "cult", roleState: { converted: true } },
        },
      ],
      events: [draft("cult.member_joined", "faction", { playerId: convert }, { scopeId: "cult" })],
      ephemeral: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("transition should not be stale");

    const joined = result.events.find((event) => event.kind === "cult.member_joined");
    expect(joined).toBeDefined();
    expect(joined!.id).toBeGreaterThan(0);

    const rows = await db
      .select()
      .from(gamePlayers)
      .where(and(eq(gamePlayers.gameId, GAME_ID), eq(gamePlayers.userId, convert)));
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.channelSinceJson)).toEqual({ cult: joined!.id });
  });

  test("a cult.member_joined write merges rather than replacing an existing marker for a different channel", async () => {
    const { db, repo } = await setup();
    await createGame(repo);
    const playerId = USER_IDS[0]!;
    await repo.addPlayer({
      gameId: GAME_ID,
      userId: playerId,
      displayName: "P0",
      joinedAt: 1_000,
    });

    // Seed a wolves marker via a player patch.
    await repo.commitTransition(GAME_ID, 0, {
      gamePatch: { status: "running" },
      playerPatches: [{ playerId, changes: { channelSince: { wolves: 3 as EventId } } }],
      events: [],
      ephemeral: [],
    });

    // A cult.member_joined write must merge, not overwrite, the wolves marker.
    const result = await repo.commitTransition(GAME_ID, 1, {
      gamePatch: {},
      playerPatches: [],
      events: [draft("cult.member_joined", "faction", { playerId }, { scopeId: "cult" })],
      ephemeral: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("transition should not be stale");
    const joined = result.events.find((event) => event.kind === "cult.member_joined")!;

    const rows = await db
      .select()
      .from(gamePlayers)
      .where(and(eq(gamePlayers.gameId, GAME_ID), eq(gamePlayers.userId, playerId)));
    expect(JSON.parse(rows[0]!.channelSinceJson)).toEqual({
      wolves: 3,
      cult: joined.id,
    });
  });
});
