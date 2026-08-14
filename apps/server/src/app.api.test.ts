// Application-layer acceptance tests. Every test boots a fresh temp-file
// libSQL database (migrations applied), builds the Hono app with a stubbed
// session resolver (an `x-user-id` header stands in for Google auth), and
// drives it through app.request. A controllable clock lets tests advance
// phases the way the scheduler will.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations, createDb, type Db, GameRepository } from "@werewolf/db";
import type { DomainTransition, GameState } from "@werewolf/game-engine";
import type { GameId, UserId, ViewerGameSnapshot } from "@werewolf/protocol";
import type { App } from "./app.ts";
import { createApp } from "./app.ts";
import { GameCoordinator } from "./game/coordinator.ts";
import { GameLock } from "./game/locks.ts";

const USERS = ["u1", "u2", "u3", "u4", "u5", "u6", "u7"];

type Harness = {
  app: App;
  coordinator: GameCoordinator;
  repo: GameRepository;
  clock: { now: number };
  close: () => void;
};

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

async function setup(
  overrides: { createRepo?: (db: Db) => GameRepository; lock?: GameLock } = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "werewolf-server-test-"));
  const { client, db } = createDb(`file:${join(dir, "test.db")}`);
  cleanups.push(() => {
    client.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await applyMigrations(db);
  const repo = overrides.createRepo ? overrides.createRepo(db) : new GameRepository(db);
  const clock = { now: 1_000_000 };
  const coordinator = new GameCoordinator(repo, overrides.lock ?? new GameLock(), () => clock.now);
  const app = createApp({
    coordinator,
    sessionResolver: async (request) => {
      const userId = request.headers.get("x-user-id");
      return userId ? { userId } : null;
    },
  });
  return { app, coordinator, repo, clock, close: () => client.close() };
}

function as(app: App, userId: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("x-user-id", userId);
  return app.request(path, { ...init, headers });
}

function jsonRequest(method: string, body: unknown, userId = USERS[0]!) {
  return {
    method,
    headers: { "x-user-id": userId, "content-type": "application/json" },
    body: JSON.stringify(body),
  } as const;
}

/** Create a game as the owner. Returns the full GameState (has `id`). */
async function createGame(app: App, owner = USERS[0]!): Promise<GameState> {
  const response = await as(
    app,
    owner,
    "/api/games",
    jsonRequest("POST", { name: "Lobby", settings: { spectatingEnabled: true } }, owner),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as GameState;
}

/** Join `players` (the owner is already a member) and start the game. */
async function startGameWithPlayers(app: App, owner: string, players: string[]): Promise<GameId> {
  const game = await createGame(app, owner);
  for (const player of players) {
    const response = await as(app, player, `/api/games/${game.id}/join`, jsonRequest("POST", {}));
    expect(response.status).toBe(200);
  }
  const start = await as(app, owner, `/api/games/${game.id}/start`, jsonRequest("POST", {}));
  expect(start.status).toBe(200);
  return game.id;
}

async function snapshot(app: App, userId: string, gameId: GameId): Promise<ViewerGameSnapshot> {
  const response = await as(app, userId, `/api/games/${gameId}`);
  expect(response.status).toBe(200);
  return (await response.json()) as ViewerGameSnapshot;
}

function chatCommand(commandId: string, phaseId: number) {
  return { commandId, phaseId, type: "chat.send", payload: { channel: "public", text: "hello" } };
}

function voteCommand(commandId: string, phaseId: number, targetId: string) {
  return { commandId, phaseId, type: "vote.set", payload: { targetId } };
}

test("create a game, five players join, the owner starts it, and every player is alive with a role", async () => {
  const { app } = await setup();
  const gameId = await startGameWithPlayers(app, USERS[0]!, [
    USERS[1]!,
    USERS[2]!,
    USERS[3]!,
    USERS[4]!,
  ]);

  for (const userId of USERS.slice(0, 5)) {
    const game = await snapshot(app, userId!, gameId);
    expect(game.game.status).toBe("running");
    expect(game.me?.status).toBe("alive");
    expect(game.me?.role).toBeDefined();
  }
});

test("starting with four players is refused with MIN_PLAYERS_NOT_REACHED", async () => {
  const { app } = await setup();
  const game = await createGame(app, USERS[0]!);
  for (const userId of [USERS[1]!, USERS[2]!, USERS[3]!]) {
    const response = await as(app, userId, `/api/games/${game.id}/join`, jsonRequest("POST", {}));
    expect(response.status).toBe(200);
  }
  const start = await as(app, USERS[0]!, `/api/games/${game.id}/start`, jsonRequest("POST", {}));
  expect(start.status).toBe(400);
  expect(await start.json()).toEqual({ error: { code: "MIN_PLAYERS_NOT_REACHED" } });
});

test("a non-owner starting or cancelling gets NOT_GAME_OWNER", async () => {
  const { app } = await setup();
  const game = await createGame(app, USERS[0]!);
  const joined = await as(app, USERS[1]!, `/api/games/${game.id}/join`, jsonRequest("POST", {}));
  expect(joined.status).toBe(200);

  const start = await as(app, USERS[1]!, `/api/games/${game.id}/start`, jsonRequest("POST", {}));
  expect(start.status).toBe(403);
  expect(await start.json()).toEqual({ error: { code: "NOT_GAME_OWNER" } });

  const cancel = await as(app, USERS[1]!, `/api/games/${game.id}/cancel`, jsonRequest("POST", {}));
  expect(cancel.status).toBe(403);
  expect(await cancel.json()).toEqual({ error: { code: "NOT_GAME_OWNER" } });
});

test("a command carrying a stale phaseId is rejected with PHASE_MISMATCH", async () => {
  const { app } = await setup();
  const gameId = await startGameWithPlayers(app, USERS[0]!, [
    USERS[1]!,
    USERS[2]!,
    USERS[3]!,
    USERS[4]!,
  ]);

  const response = await as(
    app,
    USERS[1]!,
    `/api/games/${gameId}/commands`,
    jsonRequest("POST", chatCommand("c-1", 999), USERS[1]!),
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: { code: "PHASE_MISMATCH" } });
});

test("posting the same commandId twice produces exactly one event", async () => {
  const { app, repo } = await setup();
  const gameId = await startGameWithPlayers(app, USERS[0]!, [
    USERS[1]!,
    USERS[2]!,
    USERS[3]!,
    USERS[4]!,
  ]);
  const game = await snapshot(app, USERS[1]!, gameId);
  const phaseId = game.game.phase!.id as number;

  const command = chatCommand("chat-dup", phaseId);
  const first = await as(
    app,
    USERS[1]!,
    `/api/games/${gameId}/commands`,
    jsonRequest("POST", command, USERS[1]!),
  );
  const second = await as(
    app,
    USERS[1]!,
    `/api/games/${gameId}/commands`,
    jsonRequest("POST", command, USERS[1]!),
  );
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);

  const events = await repo.getVisibleEvents(gameId);
  const messages = events.filter((event) => event.kind === "chat.message");
  expect(messages).toHaveLength(1);
});

test("a viewer's snapshot never reveals another living player's role", async () => {
  const { app, repo } = await setup();
  const gameId = await startGameWithPlayers(app, USERS[0]!, [
    USERS[1]!,
    USERS[2]!,
    USERS[3]!,
    USERS[4]!,
  ]);
  const viewer = USERS[0]!;

  const game = await snapshot(app, viewer, gameId);
  expect(game.me?.role).toBeDefined();

  // Structurally: no player entry carries role/faction, and living players
  // carry no revealedRole.
  for (const player of game.players) {
    if (player.userId === viewer) continue;
    expect((player as unknown as Record<string, unknown>).role).toBeUndefined();
    expect((player as unknown as Record<string, unknown>).faction).toBeUndefined();
    expect(player.revealedRole).toBeUndefined();
  }

  // And nowhere in the raw body: no other living player's role id appears.
  const state = await repo.loadGameState(gameId);
  const raw = JSON.stringify(game);
  const viewerRole = game.me!.role;
  for (const player of Object.values(state!.players)) {
    if (player.id === viewer || player.status !== "alive") continue;
    if (player.role != null && player.role !== viewerRole)
      expect(raw.includes(player.role)).toBe(false);
  }
});

test("the replay endpoint refuses while running and returns the hidden history once finished", async () => {
  const { app, coordinator, repo, clock } = await setup();
  const gameId = await startGameWithPlayers(app, USERS[0]!, [
    USERS[1]!,
    USERS[2]!,
    USERS[3]!,
    USERS[4]!,
  ]);

  const whileRunning = await as(app, USERS[0]!, `/api/games/${gameId}/replay`);
  expect(whileRunning.status).toBe(409);
  expect(await whileRunning.json()).toEqual({ error: { code: "GAME_NOT_STARTED" } });

  // Advance to the voting phase.
  clock.now += 61_000;
  await coordinator.resolvePhase(gameId);
  let state = (await repo.loadGameState(gameId))!;
  const votingPhaseId = state.phase!.id as number;
  const wolf = Object.values(state.players).find((player) => player.faction === "wolves")!;
  const villagers = Object.values(state.players).filter((player) => player.faction === "village");

  // Everyone alive votes: villagers on the wolf, the wolf on a villager.
  let index = 0;
  for (const player of Object.values(state.players)) {
    const target = player.id === wolf.id ? villagers[0]!.id : wolf.id;
    const response = await as(
      app,
      player.id,
      `/api/games/${gameId}/commands`,
      jsonRequest("POST", voteCommand(`v-${index++}`, votingPhaseId, target), player.id),
    );
    expect(response.status).toBe(200);
  }

  // Voting resolves, the wolf is lynched, the village wins: game finished.
  clock.now += 60_001;
  await coordinator.resolvePhase(gameId);
  state = (await repo.loadGameState(gameId))!;
  expect(state.status).toBe("finished");

  const replay = await as(app, USERS[0]!, `/api/games/${gameId}/replay`);
  expect(replay.status).toBe(200);
  const body = (await replay.json()) as { state: GameState; events: unknown[] };
  expect(body.state.status).toBe("finished");
  // The hidden history: original roles and server-scope audit events.
  expect(body.state.players[wolf.id]?.originalRole).toBe("werewolf");
  expect(body.events.some((event) => (event as { scope: string }).scope === "server")).toBe(true);
});

test("spectating works in the lobby and while running, and never deals a role", async () => {
  const { app, repo } = await setup();
  const game = await createGame(app, USERS[0]!);
  for (const userId of [USERS[1]!, USERS[2]!, USERS[3]!, USERS[4]!]) {
    const response = await as(app, userId, `/api/games/${game.id}/join`, jsonRequest("POST", {}));
    expect(response.status).toBe(200);
  }
  // A spectator joins before the start and one after it is running.
  const lobbySpectator = USERS[5]!;
  const inLobby = await as(
    app,
    lobbySpectator,
    `/api/games/${game.id}/spectate`,
    jsonRequest("POST", {}),
  );
  expect(inLobby.status).toBe(200);

  const start = await as(app, USERS[0]!, `/api/games/${game.id}/start`, jsonRequest("POST", {}));
  expect(start.status).toBe(200);

  const runningSpectator = USERS[6]!;
  const whileRunning = await as(
    app,
    runningSpectator,
    `/api/games/${game.id}/spectate`,
    jsonRequest("POST", {}),
  );
  expect(whileRunning.status).toBe(200);

  // Both spectators are recorded as spectators, dealt no role, and the five
  // real players all got roles.
  const state = (await repo.loadGameState(game.id))!;
  for (const spectator of [lobbySpectator, runningSpectator]) {
    expect(state.players[spectator as UserId]?.status).toBe("spectator");
    expect(state.players[spectator as UserId]?.role).toBeNull();
    expect(state.players[spectator as UserId]?.faction).toBeNull();
    const view = await snapshot(app, spectator, game.id);
    expect(view.me?.status).toBe("spectator");
    expect(view.me?.role).toBeUndefined();
  }
  for (const userId of USERS.slice(0, 5)) {
    expect(state.players[userId as UserId]?.status).toBe("alive");
    expect(state.players[userId as UserId]?.role).not.toBeNull();
  }
});

test("leaving or kicking during a running game is refused with GAME_ALREADY_STARTED", async () => {
  const { app } = await setup();
  const gameId = await startGameWithPlayers(app, USERS[0]!, [
    USERS[1]!,
    USERS[2]!,
    USERS[3]!,
    USERS[4]!,
  ]);

  const leave = await as(app, USERS[1]!, `/api/games/${gameId}/membership`, { method: "DELETE" });
  expect(leave.status).toBe(409);
  expect(await leave.json()).toEqual({ error: { code: "GAME_ALREADY_STARTED" } });

  const kick = await as(app, USERS[0]!, `/api/games/${gameId}/players/${USERS[1]}`, {
    method: "DELETE",
  });
  expect(kick.status).toBe(409);
  expect(await kick.json()).toEqual({ error: { code: "GAME_ALREADY_STARTED" } });
});

test("the per-game lock serialises commands for one game while two games proceed concurrently", async () => {
  // A repository that sleeps inside commitTransition and tracks how many
  // commits are in flight per game, plus which games overlapped.
  class TrackingRepository extends GameRepository {
    private readonly inFlight = new Map<string, number>();
    readonly maxPerGame = new Map<string, number>();
    readonly overlap = new Set<string>();
    constructor(
      db: Db,
      private readonly sleepMs: number,
    ) {
      super(db);
    }
    override async commitTransition(
      gameId: GameId,
      expectedVersion: number,
      transition: DomainTransition,
      createdAt = Date.now(),
    ) {
      for (const other of this.inFlight.keys()) this.overlap.add(`${gameId}->${other}`);
      const current = (this.inFlight.get(gameId) ?? 0) + 1;
      this.inFlight.set(gameId, current);
      this.maxPerGame.set(gameId, Math.max(this.maxPerGame.get(gameId) ?? 0, current));
      if (this.sleepMs > 0) await new Promise((resolve) => setTimeout(resolve, this.sleepMs));
      try {
        return await super.commitTransition(gameId, expectedVersion, transition, createdAt);
      } finally {
        const remaining = current - 1;
        if (remaining <= 0) this.inFlight.delete(gameId);
        else this.inFlight.set(gameId, remaining);
      }
    }
  }

  const { app, repo } = await setup({ createRepo: (db) => new TrackingRepository(db, 40) });
  const gameA = await startGameWithPlayers(app, USERS[0]!, [
    USERS[1]!,
    USERS[2]!,
    USERS[3]!,
    USERS[4]!,
  ]);
  const gameB = await startGameWithPlayers(app, USERS[0]!, [
    USERS[1]!,
    USERS[2]!,
    USERS[3]!,
    USERS[4]!,
  ]);

  const responses = await Promise.all([
    as(
      app,
      USERS[1]!,
      `/api/games/${gameA}/commands`,
      jsonRequest("POST", chatCommand("a-1", 1), USERS[1]!),
    ),
    as(
      app,
      USERS[2]!,
      `/api/games/${gameA}/commands`,
      jsonRequest("POST", chatCommand("a-2", 1), USERS[2]!),
    ),
    as(
      app,
      USERS[1]!,
      `/api/games/${gameB}/commands`,
      jsonRequest("POST", chatCommand("b-1", 1), USERS[1]!),
    ),
    as(
      app,
      USERS[2]!,
      `/api/games/${gameB}/commands`,
      jsonRequest("POST", chatCommand("b-2", 1), USERS[2]!),
    ),
  ]);
  for (const response of responses) expect(response.status).toBe(200);

  const tracking = repo as TrackingRepository;
  expect(tracking.maxPerGame.get(gameA)).toBe(1);
  expect(tracking.maxPerGame.get(gameB)).toBe(1);
  expect(tracking.overlap.has(`${gameA}->${gameB}`)).toBe(true);
  expect(tracking.overlap.has(`${gameB}->${gameA}`)).toBe(true);
});

// Two authorization checks had no coverage: removing either one left the whole
// suite green, so a stranger could kick players out of someone else's lobby or
// rename their game.

test("only the owner may kick a player from the lobby", async () => {
  const { app } = await setup();
  const game = await createGame(app, USERS[0]!);
  await as(app, USERS[1]!, `/api/games/${game.id}/join`, jsonRequest("POST", {}, USERS[1]!));
  await as(app, USERS[2]!, `/api/games/${game.id}/join`, jsonRequest("POST", {}, USERS[2]!));

  const byStranger = await as(
    app,
    USERS[2]!,
    `/api/games/${game.id}/players/${USERS[1]}`,
    jsonRequest("DELETE", {}, USERS[2]!),
  );
  expect(byStranger.status).toBe(403);
  expect(await byStranger.json()).toEqual({ error: { code: "NOT_GAME_OWNER" } });

  // The target is still in the lobby.
  const players = await (await as(app, USERS[0]!, `/api/games/${game.id}`)).json();
  expect(JSON.stringify(players)).toContain(USERS[1]!);

  const byOwner = await as(
    app,
    USERS[0]!,
    `/api/games/${game.id}/players/${USERS[1]}`,
    jsonRequest("DELETE", {}, USERS[0]!),
  );
  expect(byOwner.status).toBeLessThan(300);
});

test("only the owner may edit the game", async () => {
  const { app } = await setup();
  const game = await createGame(app, USERS[0]!);
  await as(app, USERS[1]!, `/api/games/${game.id}/join`, jsonRequest("POST", {}, USERS[1]!));

  const byStranger = await as(
    app,
    USERS[1]!,
    `/api/games/${game.id}`,
    jsonRequest("PATCH", { name: "hijacked" }, USERS[1]!),
  );
  expect(byStranger.status).toBe(403);
  expect(await byStranger.json()).toEqual({ error: { code: "NOT_GAME_OWNER" } });

  const byOwner = await as(
    app,
    USERS[0]!,
    `/api/games/${game.id}`,
    jsonRequest("PATCH", { name: "renamed" }, USERS[0]!),
  );
  expect(byOwner.status).toBeLessThan(300);

  // The rename must actually be persisted, not just echoed back.
  const reloaded = await (await as(app, USERS[0]!, `/api/games/${game.id}`)).json();
  expect(JSON.stringify(reloaded)).toContain("renamed");
  expect(JSON.stringify(reloaded)).not.toContain("hijacked");
});
