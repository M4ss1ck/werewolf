// Test support for the bot controller: a real coordinator over a temp-file
// database, a BotManager with no artificial delay, and fake agents/providers
// so no test ever makes a paid model request.

import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations, createDb, GameRepository, games } from "@werewolf/db";
import type { GameState } from "@werewolf/game-engine";
import type { BotConfig, GameId, PresetId, UserId } from "@werewolf/protocol";
import { eq } from "drizzle-orm";
import { GameCoordinator } from "../game/coordinator.ts";
import { GameLock } from "../game/locks.ts";
import { FallbackBotAgent } from "./agent.ts";
import { type BotRuntimeConfig, loadBotConfig } from "./config.ts";
import type { BotLogFields } from "./log.ts";
import { BotManager } from "./manager.ts";
import type {
  BotAgent,
  BotDecision,
  BotDecisionInput,
  BotModelProvider,
  BotModelRequest,
  BotModelResponse,
} from "./types.ts";

type BotReply = (input: BotDecisionInput) => Omit<BotDecision, "mentionIds"> & {
  mentionIds?: number[];
};

export const BOT_CONFIG: BotConfig = {
  botId: "fake",
  provider: "fake",
  model: "fake-1",
  temperature: 0,
  maxOutputTokens: 180,
  timeoutMs: 1_000,
};

/** Bot config with the human-like pause switched off, which is what automated
 * testing mode means here. */
export function testBotConfig(overrides: Record<string, string> = {}): BotRuntimeConfig {
  return loadBotConfig({ BOT_MIN_DELAY_MS: "0", BOT_MAX_DELAY_MS: "0", ...overrides });
}

/** Records every input it is handed, then answers with a scripted decision.
 * The recorded inputs are what the visibility tests assert against. */
export class RecordingBotAgent implements BotAgent {
  readonly inputs: BotDecisionInput[] = [];
  constructor(
    private readonly reply: BotReply = () => ({
      actionId: null,
      say: null,
      channel: null,
      mentionIds: [],
      done: true,
    }),
  ) {}
  decide(input: BotDecisionInput): Promise<BotDecision> {
    this.inputs.push(input);
    const reply = this.reply(input);
    return Promise.resolve({ ...reply, mentionIds: reply.mentionIds ?? [] });
  }
  forPlayer(playerId: string): BotDecisionInput[] {
    return this.inputs.filter((input) => input.playerId === playerId);
  }
}

/** An agent whose calls block until the test releases them, so a phase can be
 * moved on underneath an outstanding decision. Only calls matching `gate`
 * block; the rest answer at once, so a game can be driven to the phase under
 * test without deadlocking. */
export class GatedBotAgent implements BotAgent {
  readonly inputs: BotDecisionInput[] = [];
  readonly gated: BotDecisionInput[] = [];
  private release: (() => void)[] = [];
  constructor(
    private readonly gate: (input: BotDecisionInput) => boolean,
    private readonly reply: BotReply,
  ) {}
  async decide(input: BotDecisionInput): Promise<BotDecision> {
    this.inputs.push(input);
    if (!this.gate(input)) {
      const reply = this.reply(input);
      return { ...reply, mentionIds: reply.mentionIds ?? [] };
    }
    this.gated.push(input);
    await new Promise<void>((resolve) => this.release.push(resolve));
    const reply = this.reply(input);
    return { ...reply, mentionIds: reply.mentionIds ?? [] };
  }
  /** Resolves every outstanding call. */
  releaseAll() {
    const waiting = this.release;
    this.release = [];
    for (const resolve of waiting) resolve();
  }
}

/** Spins until `condition` holds, so a test can wait for fire-and-forget bot
 * work to reach a known point without sleeping for a fixed time. */
export async function waitFor(condition: () => boolean, label = "condition"): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Canned model responses, in order. A string is returned as model text; an
 * Error is thrown as if the provider had failed. */
export class FakeModelProvider implements BotModelProvider {
  readonly name = "fake";
  readonly requests: BotModelRequest[] = [];
  constructor(private readonly replies: (string | Error)[]) {}
  generateDecision(request: BotModelRequest): Promise<BotModelResponse> {
    this.requests.push(request);
    const reply = this.replies.shift() ?? new Error("no reply scripted");
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve({ text: reply });
  }
}

export type BotHarness = {
  coordinator: GameCoordinator;
  bots: BotManager;
  clock: { now: number };
  logs: { event: string; fields: BotLogFields }[];
  /** Seat `count` bots plus a bot host, start the game, settle the bots. */
  /** `seed` pins the composition. Compositions are seeded from a per-game
   * random uuid, so any test that needs a particular role dealt must pass one
   * or it is rolling dice. `preset` picks the composition preset. */
  startBotGame: (count?: number, seed?: string, preset?: PresetId) => Promise<GameId>;
  /** Run the current phase out and resolve it, then let the bots react. */
  advancePhase: (gameId: GameId) => Promise<void>;
  state: (gameId: GameId) => Promise<GameState>;
};

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

export async function setupBots(
  options: { agent?: BotAgent; config?: BotRuntimeConfig } = {},
): Promise<BotHarness> {
  const dir = mkdtempSync(join(tmpdir(), "werewolf-bots-test-"));
  const { client, db } = createDb(`file:${join(dir, "test.db")}`);
  await applyMigrations(db);
  const repository = new GameRepository(db);
  const clock = { now: 1_000_000 };
  const coordinator = new GameCoordinator(repository, new GameLock(), () => clock.now);
  const logs: { event: string; fields: BotLogFields }[] = [];
  const bots = new BotManager(coordinator, {
    agent: options.agent ?? new FallbackBotAgent(),
    config: options.config ?? testBotConfig(),
    now: () => clock.now,
    sleep: () => Promise.resolve(),
    logger: (event, fields) => logs.push({ event, fields }),
  });
  cleanups.push(() => {
    bots.stop();
    client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const state = async (gameId: GameId) => {
    const loaded = await repository.loadGameState(gameId);
    if (!loaded) throw new Error("game vanished");
    return loaded;
  };

  return {
    coordinator,
    bots,
    clock,
    logs,
    state,
    startBotGame: async (count = 5, seed?: string, preset?: PresetId) => {
      const host = "bot:host" as UserId;
      const game = await coordinator.createGame({
        ownerUserId: host,
        displayName: "Hostess",
        name: "Bot village",
        visibility: "public",
        settings: {
          discussionDurationMs: 60_000,
          votingDurationMs: 60_000,
          nightDurationMs: 60_000,
          spectatingEnabled: true,
          ...(preset ? { preset } : {}),
        },
        ownerController: { type: "bot", config: { ...BOT_CONFIG, botId: "fake-host" } },
      });
      const gameId = game!.id;
      for (let seat = 0; seat < count; seat += 1)
        await coordinator.addBot(gameId, host, {
          displayName: `Bot ${seat + 1}`,
          config: { ...BOT_CONFIG, botId: `fake-${seat}` },
        });
      // The seed is read at start time, so it must be written before startGame.
      if (seed !== undefined)
        await db.update(games).set({ rngSeed: seed }).where(eq(games.id, gameId));
      await coordinator.startGame(gameId, host);
      await bots.whenIdle();
      return gameId;
    },
    advancePhase: async (gameId: GameId) => {
      const current = await state(gameId);
      // A victory can land on any resolution, so running out of phases is a
      // normal outcome rather than a test failure.
      if (current.status !== "running" || !current.phase) return;
      clock.now = current.phase.endsAt;
      await coordinator.resolvePhase(gameId);
      await bots.whenIdle();
    },
  };
}
