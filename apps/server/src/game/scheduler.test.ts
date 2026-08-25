// PhaseScheduler tests: restart recovery, phase-cycle advancement and
// scheduled-game handling. Each test boots a fresh database through the shared
// harness and drives the scheduler with the harness's injectable clock; a
// freshly constructed coordinator stands in for "the process just booted".

import { expect, test } from "bun:test";
import type { GameRepository } from "@werewolf/db";
import type { GameState } from "@werewolf/game-engine";
import type { GameId, UserId } from "@werewolf/protocol";
import {
  as,
  createGame,
  jsonRequest,
  setup,
  startGameWithPlayers,
  USERS,
} from "../test/harness.ts";
import { GameCoordinator } from "./coordinator.ts";
import { GameLock } from "./locks.ts";
import { PhaseScheduler } from "./scheduler.ts";

const SETTINGS = {
  discussionDurationMs: 60_000,
  votingDurationMs: 60_000,
  nightDurationMs: 60_000,
  spectatingEnabled: true,
};

/** A coordinator that reads the same controllable clock as the scheduler. */
function freshCoordinator(repo: GameRepository, now: () => number) {
  return new GameCoordinator(repo, new GameLock(), now);
}

/** Create a lobby game with `players` joined and flip it to "scheduled". */
async function makeScheduledGame(
  repo: GameRepository,
  players: string[],
  now: number,
): Promise<GameId> {
  const id = crypto.randomUUID() as GameId;
  const game = await repo.createGame({
    id,
    ownerUserId: players[0]! as UserId,
    ownerDisplayName: players[0]!,
    name: "scheduled",
    visibility: "public",
    status: "lobby",
    settings: SETTINGS,
    balanceVersion: 1,
    rngSeed: "seed",
    createdAt: now,
  });
  if (!game) throw new Error("createGame returned no row");
  for (const player of players.slice(1)) {
    await repo.addPlayer({
      gameId: id,
      userId: player as UserId,
      displayName: player,
      status: "lobby",
      joinedAt: now,
    });
  }
  const commit = await repo.commitTransition(
    id,
    game.version,
    {
      gamePatch: { status: "scheduled", scheduledAt: now },
      playerPatches: [],
      events: [],
      ephemeral: [],
    },
    now,
  );
  expect(commit.ok).toBe(true);
  return id;
}

async function waitForState(
  repo: GameRepository,
  gameId: GameId,
  predicate: (state: GameState) => boolean,
  timeoutMs = 2_000,
): Promise<GameState> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await repo.loadGameState(gameId);
    if (state && predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for game state");
}

test("a phase whose deadline has passed is resolved when the scheduler starts", async () => {
  const { app, repo, clock } = await setup();
  const gameId = await startGameWithPlayers(app, USERS[0]!, [
    USERS[1]!,
    USERS[2]!,
    USERS[3]!,
    USERS[4]!,
  ]);
  let state = (await repo.loadGameState(gameId))!;
  expect(state.phase?.type).toBe("discussion");

  // The server was down for an hour: the discussion deadline is long past.
  clock.now += 3_600_000;
  const scheduler = new PhaseScheduler(
    repo,
    freshCoordinator(repo, () => clock.now),
    () => clock.now,
  );
  await scheduler.start();

  state = (await repo.loadGameState(gameId))!;
  expect(state.status).toBe("running");
  expect(state.phase?.type).toBe("voting");
  expect(state.phase?.id as number).toBe(2);
  scheduler.stop();
});

test("resolving a phase registers the next deadline and the cycle advances", async () => {
  const { app, repo, clock } = await setup();
  const game = await createGame(app, USERS[0]!, {
    discussionDurationMs: 150,
    votingDurationMs: 150,
    nightDurationMs: 150,
    spectatingEnabled: true,
  });
  for (const userId of [USERS[1]!, USERS[2]!, USERS[3]!, USERS[4]!]) {
    const response = await as(app, userId, `/api/games/${game.id}/join`, jsonRequest("POST", {}));
    expect(response.status).toBe(200);
  }
  const start = await as(app, USERS[0]!, `/api/games/${game.id}/start`, jsonRequest("POST", {}));
  expect(start.status).toBe(200);

  const scheduler = new PhaseScheduler(
    repo,
    freshCoordinator(repo, () => clock.now),
    () => clock.now,
  );
  await scheduler.start();

  // Discussion -> voting -> night -> day 2 discussion, driven by the
  // scheduler's own timers, each registered from the previous resolution.
  const observed: number[] = [];
  const final = await waitForState(repo, game.id, (state) => {
    observed.push(state.phase!.id as number);
    return state.day === 2 && state.phase!.type === "discussion";
  });
  scheduler.stop();

  expect(final.day).toBe(2);
  expect(final.phase?.type).toBe("discussion");
  expect(final.phase?.id as number).toBe(4);
  const distinct = [...new Set(observed)];
  for (let index = 1; index < distinct.length; index += 1)
    expect(distinct[index]!).toBeGreaterThan(distinct[index - 1]!);
  expect(distinct.at(-1)).toBe(4);
});

test("a scheduled game with five players auto-starts at its time", async () => {
  const { repo, clock } = await setup();
  const gameId = await makeScheduledGame(
    repo,
    [USERS[0]!, USERS[1]!, USERS[2]!, USERS[3]!, USERS[4]!],
    clock.now,
  );
  const scheduler = new PhaseScheduler(
    repo,
    freshCoordinator(repo, () => clock.now),
    () => clock.now,
  );
  await scheduler.start();

  const state = (await repo.loadGameState(gameId))!;
  expect(state.status).toBe("running");
  expect(state.day).toBe(1);
  expect(state.phase?.type).toBe("discussion");
  expect(state.scheduledAt).toBeNull();
  scheduler.stop();
});

test("a scheduled game with four returns to the lobby", async () => {
  const { repo, clock } = await setup();
  const gameId = await makeScheduledGame(
    repo,
    [USERS[0]!, USERS[1]!, USERS[2]!, USERS[3]!],
    clock.now,
  );
  const scheduler = new PhaseScheduler(
    repo,
    freshCoordinator(repo, () => clock.now),
    () => clock.now,
  );
  await scheduler.start();

  const state = (await repo.loadGameState(gameId))!;
  expect(state.status).toBe("lobby");
  expect(state.scheduledAt).toBeNull();
  const events = await repo.getVisibleEvents(gameId);
  expect(events.some((event) => event.kind === "game.start_deferred")).toBe(true);
  scheduler.stop();
});

test("a game created with a future start time is scheduled and auto-starts", async () => {
  const { app, repo, coordinator, clock } = await setup();
  const scheduler = new PhaseScheduler(repo, coordinator, () => clock.now);
  coordinator.onCommitted((gameId) => void scheduler.watch(gameId));
  await scheduler.start();

  const create = await as(
    app,
    USERS[0]!,
    "/api/games",
    jsonRequest("POST", {
      name: "Scheduled",
      scheduledAt: clock.now + 150,
      settings: {
        discussionDurationMs: 150,
        votingDurationMs: 150,
        nightDurationMs: 150,
        spectatingEnabled: true,
      },
    }),
  );
  expect(create.status).toBe(200);
  const game = (await create.json()) as GameState;
  expect(game.status).toBe("scheduled");

  for (const userId of [USERS[1]!, USERS[2]!, USERS[3]!, USERS[4]!]) {
    const response = await as(app, userId, `/api/games/${game.id}/join`, jsonRequest("POST", {}));
    expect(response.status).toBe(200);
  }

  const state = await waitForState(
    repo,
    game.id,
    (s) => s.status === "running" && s.day === 1 && s.phase?.type === "discussion",
  );
  scheduler.stop();

  expect(state.status).toBe("running");
  expect(state.day).toBe(1);
  expect(state.phase?.type).toBe("discussion");
  expect(state.scheduledAt).toBeNull();
});

test("a game created with a past start time stays in the lobby", async () => {
  const { app, repo, coordinator, clock } = await setup();
  const scheduler = new PhaseScheduler(repo, coordinator, () => clock.now);
  coordinator.onCommitted((gameId) => void scheduler.watch(gameId));
  await scheduler.start();

  const create = await as(
    app,
    USERS[0]!,
    "/api/games",
    jsonRequest("POST", {
      name: "Scheduled",
      scheduledAt: clock.now - 1000,
      settings: SETTINGS,
    }),
  );
  expect(create.status).toBe(200);
  const game = (await create.json()) as GameState;
  expect(game.status).toBe("lobby");
  expect(game.scheduledAt).toBeNull();
  scheduler.stop();
});

test("a game started manually arms its phase timer", async () => {
  const { app, repo, coordinator, clock } = await setup();
  const scheduler = new PhaseScheduler(repo, coordinator, () => clock.now);
  coordinator.onCommitted((gameId) => void scheduler.watch(gameId));
  await scheduler.start();

  const game = await createGame(app, USERS[0]!, {
    discussionDurationMs: 150,
    votingDurationMs: 150,
    nightDurationMs: 150,
    spectatingEnabled: true,
  });
  for (const userId of [USERS[1]!, USERS[2]!, USERS[3]!, USERS[4]!]) {
    const response = await as(app, userId, `/api/games/${game.id}/join`, jsonRequest("POST", {}));
    expect(response.status).toBe(200);
  }
  const start = await as(app, USERS[0]!, `/api/games/${game.id}/start`, jsonRequest("POST", {}));
  expect(start.status).toBe(200);

  const state = await waitForState(repo, game.id, (s) => s.phase?.type === "voting");
  scheduler.stop();

  expect(state.phase?.type).toBe("voting");
});
