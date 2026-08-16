/**
 * Run an unattended, all-bot match against a throwaway database and print what
 * happened. Nothing else in the project depends on this; it exists so the
 * engine can be exercised over a real sequence of phases without a browser, an
 * account or a second player.
 *
 *   bun run bots:match                  # 6 bots, no provider, free
 *   bun run bots:match -- --players 8   # bigger village
 *   bun run bots:match -- --chat        # print what the bots said
 *
 * With BOT_AI_API_KEY set the bots think with the configured model; without it
 * they pick random legal actions, which is enough to drive the engine.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations, createDb, GameRepository } from "@werewolf/db";
import type { GameEvent, GameId, UserId } from "@werewolf/protocol";
import { GameCoordinator } from "../game/coordinator.ts";
import { GameLock } from "../game/locks.ts";
import { FallbackBotAgent, LlmBotAgent } from "./agent.ts";
import { loadBotConfig, resolveSeatConfig } from "./config.ts";
import { BotManager } from "./manager.ts";
import { OpenAiCompatibleProvider } from "./provider-openai.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string, fallback: number) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : Number(args[index + 1] ?? fallback);
};

const players = value("players", 6);
const showChat = flag("chat");
// The phase clock is driven directly here, so durations only need to be
// non-zero; the match does not run in real time.
const config = loadBotConfig({ ...process.env, BOT_MIN_DELAY_MS: "0", BOT_MAX_DELAY_MS: "0" });
const seatConfig = resolveSeatConfig(config);

const dir = mkdtempSync(join(tmpdir(), "werewolf-bot-match-"));
const { client, db } = createDb(`file:${join(dir, "match.db")}`);
await applyMigrations(db);

const repository = new GameRepository(db);
const clock = { now: Date.now() };
const coordinator = new GameCoordinator(repository, new GameLock(), () => clock.now);
const agent = config.BOT_AI_API_KEY
  ? new LlmBotAgent(
      new OpenAiCompatibleProvider({
        baseUrl: config.BOT_AI_BASE_URL,
        apiKey: config.BOT_AI_API_KEY,
        name: config.BOT_AI_PROVIDER,
      }),
      config,
    )
  : new FallbackBotAgent();
const bots = new BotManager(coordinator, {
  agent,
  config,
  now: () => clock.now,
  sleep: () => Promise.resolve(),
});

console.log(
  `${players} bots, ${config.BOT_AI_API_KEY ? `model ${seatConfig.model}` : "no provider (random legal actions)"}`,
);

// The host seat is itself a bot, so nobody has to sit and watch.
const host = "bot:host" as UserId;
const created = await coordinator.createGame({
  ownerUserId: host,
  displayName: "Hostess",
  name: "Bot village",
  visibility: "private",
  settings: {
    discussionDurationMs: 60_000,
    votingDurationMs: 60_000,
    nightDurationMs: 60_000,
    spectatingEnabled: false,
  },
  ownerController: { type: "bot", config: seatConfig },
});
const gameId = created!.id as GameId;
await coordinator.addBots(gameId, host, { count: players - 1, config: seatConfig });
await coordinator.startGame(gameId, host);
await bots.whenIdle();

for (let phase = 0; phase < 60; phase += 1) {
  const state = await repository.loadGameState(gameId);
  if (!state || state.status !== "running" || !state.phase) break;
  clock.now = state.phase.endsAt;
  await coordinator.resolvePhase(gameId);
  await bots.whenIdle();
}

const final = (await repository.loadGameState(gameId))!;
const names = new Map(Object.values(final.players).map((p) => [p.id as string, p.displayName]));
const name = (id: string) => names.get(id) ?? id;

for (const event of (await coordinator.getVisibleEvents(gameId, 0)) as GameEvent[]) {
  if (event.kind === "phase.started")
    console.log(`\n— ${event.payload.type} (phase ${event.payload.phaseId}) —`);
  if (showChat && event.kind === "chat.message")
    console.log(
      `  [${event.payload.channel}] ${name(event.actorUserId ?? "?")}: ${event.payload.text}`,
    );
  if (event.kind === "player.eliminated")
    console.log(
      `  ${name(event.payload.playerId)} died (${event.payload.cause}), was ${event.payload.role}`,
    );
}

console.log(`\nstatus: ${final.status}`);
if (final.winner)
  console.log(
    `winner: ${final.winner.winningFactions.join(", ")} (${final.winner.reason}) — ${final.winner.winningPlayers.map(name).join(", ")}`,
  );

bots.stop();
client.close();
rmSync(dir, { recursive: true, force: true });
