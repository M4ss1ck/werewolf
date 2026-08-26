// The lobby endpoints. Availability is advice to the client and a rule on the
// server: whatever the lobby last rendered, seating is decided here.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations, createDb, GameRepository, games } from "@werewolf/db";
import type { BotRosterEntry, GameId, ViewerGameSnapshot } from "@werewolf/protocol";
import { eq } from "drizzle-orm";
import { createApp } from "../app.ts";
import { GameCoordinator } from "../game/coordinator.ts";
import { GameLock } from "../game/locks.ts";
import { testBotConfig } from "./fixtures.ts";
import { ModelCatalog } from "./model-catalog.ts";
import { parseBotRoster } from "./roster.ts";

const ROSTER = parseBotRoster([
  { id: "mira", displayName: "Mira", model: "deepseek-v4-flash" },
  { id: "bram", displayName: "Bram", model: "ghost-model" },
]);

async function setup(options: { apiKey?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "werewolf-bot-routes-"));
  const { client, db } = createDb(`file:${join(dir, "test.db")}`);
  await applyMigrations(db);
  const repository = new GameRepository(db);
  const clock = { now: 1_000_000 };
  const coordinator = new GameCoordinator(repository, new GameLock(), () => clock.now);
  const catalog = new ModelCatalog({
    baseUrl: "https://example.test/v1",
    apiKey: options.apiKey,
    fetch: async () => new Response(JSON.stringify({ data: [{ id: "deepseek-v4-flash" }] })),
  });
  await catalog.probe();
  const app = createApp({
    db,
    coordinator,
    bots: { roster: ROSTER, catalog, config: testBotConfig() },
    sessionResolver: async (request) => {
      const userId = request.headers.get("x-user-id");
      return userId ? { userId, username: userId } : null;
    },
  });
  const as = (userId: string, path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("x-user-id", userId);
    headers.set("content-type", "application/json");
    return app.request(path, { ...init, headers });
  };
  const game = await (
    await as("host", "/api/games", {
      method: "POST",
      body: JSON.stringify({ name: "Lobby", settings: {} }),
    })
  ).json();
  const created = game as { gameId: GameId };
  return {
    as,
    db,
    gameId: created.gameId,
    close: () => {
      client.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("bot lobby routes", () => {
  test("lists the roster with per-entry availability and no secrets", async () => {
    const harness = await setup({ apiKey: "secret" });
    const response = await harness.as("host", `/api/games/${harness.gameId}/bots`);
    expect(response.status).toBe(200);
    const roster = (await response.json()) as BotRosterEntry[];

    expect(roster.find((entry) => entry.id === "mira")!.available).toBe(true);
    expect(roster.find((entry) => entry.id === "bram")).toMatchObject({
      available: false,
      reason: "MODEL_NOT_AVAILABLE",
    });
    expect(roster.find((entry) => entry.id === "random")!.available).toBe(true);
    expect(JSON.stringify(roster)).not.toContain("secret");
    expect(JSON.stringify(roster)).not.toContain("example.test");
    harness.close();
  });

  test("refuses a bot whose model the provider does not have", async () => {
    const harness = await setup({ apiKey: "secret" });
    const response = await harness.as("host", `/api/games/${harness.gameId}/bots`, {
      method: "POST",
      body: JSON.stringify({ botId: "bram" }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: "ACTION_NOT_AVAILABLE" } });
    harness.close();
  });

  test("refuses every model-backed bot when no provider is configured", async () => {
    const harness = await setup();
    const listed = (await (
      await harness.as("host", `/api/games/${harness.gameId}/bots`)
    ).json()) as BotRosterEntry[];
    expect(listed.find((entry) => entry.id === "mira")!.reason).toBe("PROVIDER_NOT_CONFIGURED");

    const denied = await harness.as("host", `/api/games/${harness.gameId}/bots`, {
      method: "POST",
      body: JSON.stringify({ botId: "mira" }),
    });
    expect(denied.status).toBe(403);

    // The random bot needs no provider, so it stays seatable.
    const allowed = await harness.as("host", `/api/games/${harness.gameId}/bots`, {
      method: "POST",
      body: JSON.stringify({ botId: "random" }),
    });
    expect(allowed.status).toBe(200);
    harness.close();
  });

  test("seats a bot once and then reports it as taken", async () => {
    const harness = await setup({ apiKey: "secret" });
    const first = await harness.as("host", `/api/games/${harness.gameId}/bots`, {
      method: "POST",
      body: JSON.stringify({ botId: "mira" }),
    });
    expect(first.status).toBe(200);
    expect(((await first.json()) as ViewerGameSnapshot).players).toHaveLength(2);

    const roster = (await (
      await harness.as("host", `/api/games/${harness.gameId}/bots`)
    ).json()) as BotRosterEntry[];
    expect(roster.find((entry) => entry.id === "mira")).toMatchObject({
      available: false,
      reason: "ALREADY_SEATED",
    });

    const second = await harness.as("host", `/api/games/${harness.gameId}/bots`, {
      method: "POST",
      body: JSON.stringify({ botId: "mira" }),
    });
    expect(second.status).toBe(403);
    harness.close();
  });

  test("removing a seated bot makes it selectable again", async () => {
    const harness = await setup({ apiKey: "secret" });
    const seated = await (
      await harness.as("host", `/api/games/${harness.gameId}/bots`, {
        method: "POST",
        body: JSON.stringify({ botId: "mira" }),
      })
    ).json();
    const bot = (seated as ViewerGameSnapshot).players.find((player) => player.isBot)!;

    await harness.as("host", `/api/games/${harness.gameId}/players/${bot.userId}`, {
      method: "DELETE",
    });

    const roster = (await (
      await harness.as("host", `/api/games/${harness.gameId}/bots`)
    ).json()) as BotRosterEntry[];
    const mira = roster.find((entry) => entry.id === "mira")!;
    expect(mira.available).toBe(true);
    expect(mira.reason).toBeUndefined();
    // And it can genuinely be seated a second time.
    const again = await harness.as("host", `/api/games/${harness.gameId}/bots`, {
      method: "POST",
      body: JSON.stringify({ botId: "mira" }),
    });
    expect(again.status).toBe(200);
    harness.close();
  });

  test("only the host may list or seat bots", async () => {
    const harness = await setup({ apiKey: "secret" });
    await harness.as("guest", "/api/game-entry", {
      method: "POST",
      body: JSON.stringify({
        reference: { kind: "public-game", gameId: harness.gameId },
        mode: "player",
      }),
    });
    expect((await harness.as("guest", `/api/games/${harness.gameId}/bots`)).status).toBe(403);
    expect(
      (
        await harness.as("guest", `/api/games/${harness.gameId}/bots`, {
          method: "POST",
          body: JSON.stringify({ botId: "mira" }),
        })
      ).status,
    ).toBe(403);
    harness.close();
  });

  test("a private non-member cannot read or mutate the bot roster", async () => {
    const harness = await setup({ apiKey: "secret" });
    await harness.db
      .update(games)
      .set({ visibility: "private" })
      .where(eq(games.id, harness.gameId));

    for (const gameId of [harness.gameId, "missing"]) {
      const listed = await harness.as("guest", `/api/games/${gameId}/bots`);
      expect(listed.status).toBe(404);
      expect(await listed.json()).toEqual({ error: { code: "GAME_NOT_FOUND" } });

      const seated = await harness.as("guest", `/api/games/${gameId}/bots`, {
        method: "POST",
        body: JSON.stringify({ botId: "mira" }),
      });
      expect(seated.status).toBe(404);
      expect(await seated.json()).toEqual({ error: { code: "GAME_NOT_FOUND" } });
    }
    harness.close();
  });

  test("rejects an unknown bot id", async () => {
    const harness = await setup({ apiKey: "secret" });
    const response = await harness.as("host", `/api/games/${harness.gameId}/bots`, {
      method: "POST",
      body: JSON.stringify({ botId: "nobody" }),
    });
    expect(response.status).toBe(404);
    harness.close();
  });
});
