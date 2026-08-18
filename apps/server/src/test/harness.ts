// Shared application-layer test harness: every test boots a fresh temp-file
// libSQL database (migrations applied), builds the Hono app with a stubbed
// session resolver (an `x-user-id` header stands in for Google auth), and
// drives it through app.request. A controllable clock lets tests advance
// phases the way the scheduler will.

import { afterEach, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyMigrations,
  createDb,
  type Db,
  GameRepository,
  GlobalChatRepository,
  games,
} from "@werewolf/db";
import type { GameState } from "@werewolf/game-engine";
import type { GameId, ViewerGameSnapshot } from "@werewolf/protocol";
import { eq } from "drizzle-orm";
import type { App } from "../app.ts";
import { createApp } from "../app.ts";
import { createAuthTables } from "../auth/schema.ts";
import { GameCoordinator } from "../game/coordinator.ts";
import { GameLock } from "../game/locks.ts";
import { GlobalChatHub } from "../live/global-chat-hub.ts";

export const USERS = ["u1", "u2", "u3", "u4", "u5", "u6", "u7"];

export type Harness = {
  app: App;
  coordinator: GameCoordinator;
  repo: GameRepository;
  chatRepo: GlobalChatRepository;
  chatHub: GlobalChatHub;
  db: Db;
  clock: { now: number };
  close: () => void;
};

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

export async function setup(
  overrides: { createRepo?: (db: Db) => GameRepository; lock?: GameLock } = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "werewolf-server-test-"));
  const { client, db } = createDb(`file:${join(dir, "test.db")}`);
  cleanups.push(() => {
    client.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await applyMigrations(db);
  await createAuthTables(client);
  const repo = overrides.createRepo ? overrides.createRepo(db) : new GameRepository(db);
  const chatRepo = new GlobalChatRepository(db);
  const chatHub = new GlobalChatHub(chatRepo);
  const clock = { now: 1_000_000 };
  const coordinator = new GameCoordinator(repo, overrides.lock ?? new GameLock(), () => clock.now);
  const app = createApp({
    db,
    coordinator,
    globalChat: { repository: chatRepo, hub: chatHub, now: () => clock.now },
    sessionResolver: async (request) => {
      const userId = request.headers.get("x-user-id");
      if (!userId) return null;
      // Tests get a username matching their user id by default; an explicit
      // empty `x-username` stands in for a signed-in visitor who has not
      // chosen one yet.
      const header = request.headers.get("x-username");
      return { userId, username: header === null ? userId : header || null };
    },
  });
  return { app, coordinator, repo, chatRepo, chatHub, db, clock, close: () => client.close() };
}

export function as(app: App, userId: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("x-user-id", userId);
  return app.request(path, { ...init, headers });
}

export function jsonRequest(method: string, body: unknown, userId = USERS[0]!) {
  return {
    method,
    headers: { "x-user-id": userId, "content-type": "application/json" },
    body: JSON.stringify(body),
  } as const;
}

/** Create a game as the owner. Returns the full GameState (has `id`). */
export async function createGame(
  app: App,
  owner = USERS[0]!,
  settings?: Record<string, unknown>,
): Promise<GameState> {
  const response = await as(
    app,
    owner,
    "/api/games",
    jsonRequest(
      "POST",
      { name: "Lobby", settings: settings ?? { spectatingEnabled: true } },
      owner,
    ),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as GameState;
}

/** Join `players` (the owner is already a member) and start the game. */
export async function startGameWithPlayers(
  app: App,
  owner: string,
  players: string[],
): Promise<GameId> {
  const game = await createGame(app, owner);
  for (const player of players) {
    const response = await as(app, player, `/api/games/${game.id}/join`, jsonRequest("POST", {}));
    expect(response.status).toBe(200);
  }
  const start = await as(app, owner, `/api/games/${game.id}/start`, jsonRequest("POST", {}));
  expect(start.status).toBe(200);
  return game.id;
}

/** Like `startGameWithPlayers`, but pins the game's RNG seed first so the role
 * composition is deterministic. Use it whenever a test depends on which roles were
 * dealt: the seed is otherwise a random UUID per game. */
export async function startGameWithSeed(
  app: App,
  db: Db,
  owner: string,
  players: string[],
  seed: string,
): Promise<GameId> {
  const game = await createGame(app, owner);
  for (const player of players) {
    const response = await as(app, player, `/api/games/${game.id}/join`, jsonRequest("POST", {}));
    expect(response.status).toBe(200);
  }
  // The seed is read at start time (coordinator.ts `row.rngSeed ?? gameId`), so
  // it must be written before the start endpoint is called.
  await db.update(games).set({ rngSeed: seed }).where(eq(games.id, game.id));
  const start = await as(app, owner, `/api/games/${game.id}/start`, jsonRequest("POST", {}));
  expect(start.status).toBe(200);
  return game.id;
}

export async function snapshot(
  app: App,
  userId: string,
  gameId: GameId,
): Promise<ViewerGameSnapshot> {
  const response = await as(app, userId, `/api/games/${gameId}`);
  expect(response.status).toBe(200);
  return (await response.json()) as ViewerGameSnapshot;
}

export function chatCommand(commandId: string, phaseId: number) {
  return { commandId, phaseId, type: "chat.send", payload: { channel: "public", text: "hello" } };
}

export function voteCommand(commandId: string, phaseId: number, targetId: string) {
  return { commandId, phaseId, type: "vote.set", payload: { targetId } };
}
