// Application-layer acceptance tests. Every test boots a fresh temp-file
// libSQL database (migrations applied), builds the Hono app with a stubbed
// session resolver (an `x-user-id` header stands in for Google auth), and
// drives it through app.request. A controllable clock lets tests advance
// phases the way the scheduler will. The harness lives in ./test/harness.ts.

import { expect, test } from "bun:test";
import { type Db, GameRepository } from "@werewolf/db";
import type { DomainTransition, GameState } from "@werewolf/game-engine";
import type { GameEvent, GameId, UserId, ViewerGameSnapshot } from "@werewolf/protocol";
import {
  as,
  chatCommand,
  createGame,
  jsonRequest,
  setup,
  snapshot,
  startGameWithPlayers,
  startGameWithSeed,
  USERS,
  voteCommand,
} from "./test/harness.ts";

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

test("the replay endpoint refuses while running and returns a projected snapshot once finished", async () => {
  const { app, coordinator, repo, clock, db } = await setup();
  const gameId = await startGameWithSeed(
    app,
    db,
    USERS[0]!,
    [USERS[1]!, USERS[2]!, USERS[3]!, USERS[4]!],
    "find-1",
  );

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
  const body = (await replay.json()) as { snapshot: ViewerGameSnapshot; events: GameEvent[] };
  expect(body.snapshot.game.status).toBe("finished");
  // Projected, not the raw GameState: players is an array of ViewerPlayer.
  expect(Array.isArray(body.snapshot.players)).toBe(true);
  // Reveal-on-finish: every player's current role is public in the replay.
  const wolfInReplay = body.snapshot.players.find((player) => player.userId === wolf.id);
  expect(wolfInReplay?.revealedRole).toBe("werewolf");
  // The replay is filtered like any live event stream: no audit.* server rows.
  expect(body.events.some((event) => event.kind.startsWith("audit."))).toBe(false);
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

test("a signed-out visitor can browse public games but cannot act", async () => {
  const { app } = await setup();
  await createGame(app, USERS[0]!);

  const listing = await app.request("/api/games");
  expect(listing.status).toBe(200);
  expect(await listing.json()).toHaveLength(1);

  // The exemption covers the listing only; everything else still needs a viewer.
  const created = await app.request("/api/games", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "anonymous" }),
  });
  expect(created.status).toBe(401);
  expect(await created.json()).toEqual({ error: { code: "UNAUTHENTICATED" } });
});

test("GET /api/games returns the PublicGameSummary allowlist, never raw game rows", async () => {
  const { app } = await setup();
  await createGame(app, USERS[0]!);
  // A running game carries the live phase and roster, so every column is
  // exercised: the leak test must not pass merely because the game is empty.
  await startGameWithPlayers(app, USERS[0]!, [USERS[1]!, USERS[2]!, USERS[3]!, USERS[4]!]);

  const listing = await app.request("/api/games");
  expect(listing.status).toBe(200);
  const body = (await listing.json()) as unknown as {
    id: string;
    name: string;
    ownerUserId: string;
    status: string;
    visibility: string;
    day: number;
    playerCount: number;
    players: { userId: string; displayName: string }[];
    serverNow: number;
  }[];
  expect(body).toHaveLength(2);

  // The allowlist shape, and nothing else.
  for (const summary of body) {
    expect(summary.ownerUserId).toBe(USERS[0]!);
    expect(summary.playerCount).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(summary.players)).toBe(true);
    expect(typeof summary.serverNow).toBe("number");
  }

  // The security assertion is on the serialized body, not on a typed view of
  // it: none of the secret columns may appear anywhere in the response.
  const serialized = JSON.stringify(body);
  expect(serialized).not.toContain("rngSeed");
  expect(serialized).not.toContain("joinCode");
  expect(serialized).not.toContain("settingsJson");
  expect(serialized).not.toContain("winnerJson");
  expect(serialized).not.toContain("balanceVersion");
  expect(serialized).not.toContain("version");
});

test("the roster shows usernames, not user ids", async () => {
  const { app } = await setup();
  // An extra `x-username` header stands in for the session's username.
  const created = await as(app, USERS[0]!, "/api/games", {
    method: "POST",
    headers: { "content-type": "application/json", "x-username": "Moonwatcher" },
    body: JSON.stringify({ name: "Lobby", settings: { spectatingEnabled: true } }),
  });
  expect(created.status).toBe(200);
  const gameId = ((await created.json()) as GameState).id;

  const joined = await as(app, USERS[1]!, `/api/games/${gameId}/join`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-username": "Nightwarden" },
    body: "{}",
  });
  expect(joined.status).toBe(200);

  const view = await snapshot(app, USERS[0]!, gameId);
  const displayNames = view.players.map((player) => player.displayName);
  expect(displayNames).toHaveLength(2);
  expect(displayNames).toEqual(expect.arrayContaining(["Moonwatcher", "Nightwarden"]));
  expect(displayNames.join(" ")).not.toContain(USERS[0]!);
  expect(displayNames.join(" ")).not.toContain(USERS[1]!);
});

test("lobby mutations answer with the caller's viewer projection", async () => {
  const { app } = await setup();
  const game = await createGame(app, USERS[0]!);

  // Joining answers with the joiner's projection, not the raw GameState.
  const joined = await as(app, USERS[1]!, `/api/games/${game.id}/join`, jsonRequest("POST", {}));
  expect(joined.status).toBe(200);
  const joinBody = (await joined.json()) as ViewerGameSnapshot;
  expect(joinBody.game.id).toBe(game.id);
  expect(Array.isArray(joinBody.players)).toBe(true);
  expect(joinBody).not.toHaveProperty("balanceVersion");
  expect(joinBody).not.toHaveProperty("version");

  const joined2 = await as(app, USERS[2]!, `/api/games/${game.id}/join`, jsonRequest("POST", {}));
  expect(joined2.status).toBe(200);
  const joinBody2 = (await joined2.json()) as ViewerGameSnapshot;
  expect(joinBody2.game.id).toBe(game.id);
  expect(joinBody2.players.some((player) => player.userId === USERS[2]!)).toBe(true);

  // Kicking answers with the owner's projection; the kicked player is gone.
  const kicked = await as(
    app,
    USERS[0]!,
    `/api/games/${game.id}/players/${USERS[2]}`,
    jsonRequest("DELETE", {}, USERS[0]!),
  );
  expect(kicked.status).toBeLessThan(300);
  const kickBody = (await kicked.json()) as ViewerGameSnapshot;
  expect(kickBody.game.id).toBe(game.id);
  expect(Array.isArray(kickBody.players)).toBe(true);
  expect(kickBody.players.some((player) => player.userId === USERS[2]!)).toBe(false);
  expect(kickBody).not.toHaveProperty("balanceVersion");
  expect(kickBody).not.toHaveProperty("version");

  // Leaving answers with the leaver's projection; the leaver is gone.
  const left = await as(app, USERS[1]!, `/api/games/${game.id}/membership`, { method: "DELETE" });
  expect(left.status).toBeLessThan(300);
  const leaveBody = (await left.json()) as ViewerGameSnapshot;
  expect(leaveBody.game.id).toBe(game.id);
  expect(Array.isArray(leaveBody.players)).toBe(true);
  expect(leaveBody.players.some((player) => player.userId === USERS[1]!)).toBe(false);
  expect(leaveBody).not.toHaveProperty("balanceVersion");
  expect(leaveBody).not.toHaveProperty("version");

  // Cancelling answers with the owner's projection of the cancelled game.
  const cancelled = await as(
    app,
    USERS[0]!,
    `/api/games/${game.id}/cancel`,
    jsonRequest("POST", {}, USERS[0]!),
  );
  expect(cancelled.status).toBe(200);
  const cancelBody = (await cancelled.json()) as ViewerGameSnapshot;
  expect(cancelBody.game.id).toBe(game.id);
  expect(cancelBody.game.status).toBe("cancelled");
  expect(Array.isArray(cancelBody.players)).toBe(true);
  expect(cancelBody).not.toHaveProperty("balanceVersion");
  expect(cancelBody).not.toHaveProperty("version");
});

test("starting answers with the starter's projection and hides other roles", async () => {
  const { app } = await setup();
  const game = await createGame(app, USERS[0]!);
  for (const userId of [USERS[1]!, USERS[2]!, USERS[3]!, USERS[4]!]) {
    const response = await as(app, userId, `/api/games/${game.id}/join`, jsonRequest("POST", {}));
    expect(response.status).toBe(200);
  }

  const start = await as(app, USERS[0]!, `/api/games/${game.id}/start`, jsonRequest("POST", {}));
  expect(start.status).toBe(200);
  const body = (await start.json()) as ViewerGameSnapshot;
  expect(body.game.id).toBe(game.id);
  expect(body.game.status).toBe("running");
  expect(body.me?.role).toBeDefined();
  expect(Array.isArray(body.players)).toBe(true);
  // The projection reveals no other living player's role or faction: the
  // roster entries are ViewerPlayers, never PlayerState rows.
  for (const player of body.players) {
    expect((player as unknown as Record<string, unknown>).role).toBeUndefined();
    expect((player as unknown as Record<string, unknown>).faction).toBeUndefined();
  }
});

test("a command answers with the caller's projection, never the full role table", async () => {
  const { app } = await setup();
  const gameId = await startGameWithPlayers(app, USERS[0]!, [
    USERS[1]!,
    USERS[2]!,
    USERS[3]!,
    USERS[4]!,
  ]);
  const game = await snapshot(app, USERS[1]!, gameId);
  const phaseId = game.game.phase!.id as number;

  const response = await as(
    app,
    USERS[1]!,
    `/api/games/${gameId}/commands`,
    jsonRequest("POST", chatCommand("c-proj", phaseId), USERS[1]!),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as ViewerGameSnapshot;
  expect(body.game.id).toBe(gameId);
  expect(Array.isArray(body.players)).toBe(true);
  expect(body.me?.userId as string).toBe(USERS[1]!);
  for (const player of body.players) {
    expect((player as unknown as Record<string, unknown>).role).toBeUndefined();
    expect((player as unknown as Record<string, unknown>).faction).toBeUndefined();
  }
  // The old { state, events } envelope is gone: the response is a projection.
  expect(body).not.toHaveProperty("state");
  expect(body).not.toHaveProperty("events");
});

test("creating or joining without a username is refused", async () => {
  const { app } = await setup();
  const game = await createGame(app, USERS[0]!);

  const created = await as(app, USERS[2]!, "/api/games", {
    method: "POST",
    headers: { "content-type": "application/json", "x-username": "" },
    body: JSON.stringify({ name: "anonymous" }),
  });
  expect(created.status).toBe(403);
  expect(await created.json()).toEqual({ error: { code: "USERNAME_REQUIRED" } });

  const joined = await as(app, USERS[1]!, `/api/games/${game.id}/join`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-username": "" },
    body: "{}",
  });
  expect(joined.status).toBe(403);
  expect(await joined.json()).toEqual({ error: { code: "USERNAME_REQUIRED" } });
});
