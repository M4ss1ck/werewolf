// Username routes: a signed-in player chooses the name the roster shows. The
// username lives on the Better Auth user table; tests insert a row because the
// harness now creates the auth tables alongside the game tables.

import { expect, test } from "bun:test";
import type { Db, GameRepository } from "@werewolf/db";
import type { GameId, UserId } from "@werewolf/protocol";
import { eq } from "drizzle-orm";
import { authUser } from "../auth/schema.ts";
import { as, jsonRequest, setup, USERS } from "../test/harness.ts";

/** A finished/running game with a fixed roster, written straight through the
 * repository: the stats query reads rows, not gameplay, so there is no reason
 * to play a whole match to produce them. */
async function seedGame(
  repo: GameRepository,
  now: number,
  status: string,
  players: { userId: string; status: string; faction: string | null }[],
) {
  const id = crypto.randomUUID() as GameId;
  await repo.createGame({
    id,
    ownerUserId: "owner" as UserId,
    ownerDisplayName: "Owner",
    name: "Seeded",
    visibility: "public",
    status,
    settings: {},
    balanceVersion: 1,
    createdAt: now,
  });
  for (const player of players)
    await repo.addPlayer({
      gameId: id,
      userId: player.userId as UserId,
      displayName: player.userId,
      status: player.status,
      faction: player.faction,
      joinedAt: now,
    });
  return id;
}

async function withUser(db: Db, id: string) {
  await db.insert(authUser).values({
    id,
    name: "Test User",
    email: `${id}@example.com`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

test("PATCH /api/me/username stores the chosen username", async () => {
  const { app, db } = await setup();
  await withUser(db, USERS[0]!);

  const response = await as(
    app,
    USERS[0]!,
    "/api/me/username",
    jsonRequest("PATCH", { username: "Moonwatcher" }, USERS[0]!),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ userId: USERS[0]!, username: "Moonwatcher" });

  const row = await db.select().from(authUser).where(eq(authUser.id, USERS[0]!)).get();
  expect(row?.username).toBe("Moonwatcher");
  expect(row?.usernameSearch).toBe("moonwatcher");
});

test("PATCH /api/me/username with a too-short username is refused", async () => {
  const { app, db } = await setup();
  await withUser(db, USERS[0]!);

  const response = await as(
    app,
    USERS[0]!,
    "/api/me/username",
    jsonRequest("PATCH", { username: "ab" }, USERS[0]!),
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: { code: "INVALID_USERNAME" } });
});

test("PATCH /api/me/username with invalid edge characters is refused", async () => {
  const { app, db } = await setup();
  await withUser(db, USERS[0]!);

  const response = await as(
    app,
    USERS[0]!,
    "/api/me/username",
    jsonRequest("PATCH", { username: "-bad-" }, USERS[0]!),
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: { code: "INVALID_USERNAME" } });
});

test("GET /api/me/stats counts only the viewer's own finished games", async () => {
  const { app, repo, clock } = await setup();

  // One finished game the viewer survived as a wolf, one they died in, one that
  // is still running, and one they only spectated. Only the first two count.
  const finishedSurvivedAsWolf = await seedGame(repo, clock.now, "finished", [
    { userId: USERS[0]!, status: "alive", faction: "wolves" },
    { userId: USERS[1]!, status: "dead", faction: "village" },
  ]);
  const finishedDied = await seedGame(repo, clock.now, "finished", [
    { userId: USERS[0]!, status: "dead", faction: "village" },
  ]);
  const stillRunning = await seedGame(repo, clock.now, "running", [
    { userId: USERS[0]!, status: "alive", faction: "village" },
  ]);
  const spectated = await seedGame(repo, clock.now, "finished", [
    { userId: USERS[0]!, status: "spectator", faction: null },
  ]);
  expect([finishedSurvivedAsWolf, finishedDied, stillRunning, spectated]).toHaveLength(4);

  const response = await as(app, USERS[0]!, "/api/me/stats");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ games: 2, survived: 1, asWolf: 1 });
});

test("GET /api/me/stats is all zeros for a player with no finished games", async () => {
  const { app } = await setup();

  const response = await as(app, USERS[0]!, "/api/me/stats");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ games: 0, survived: 0, asWolf: 0 });
});

test("GET /api/me/stats without a viewer is refused", async () => {
  const { app } = await setup();

  const response = await app.request("/api/me/stats");
  expect(response.status).toBe(401);
});

test("PATCH /api/me/username without a viewer is refused", async () => {
  const { app } = await setup();

  const response = await app.request("/api/me/username", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "Moonwatcher" }),
  });
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: { code: "UNAUTHENTICATED" } });
});
