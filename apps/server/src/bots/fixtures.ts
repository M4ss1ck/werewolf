// Test support for the bot controller: a real coordinator over a temp-file
// database, a BotManager with no artificial delay, and fake agents/providers
// so no test ever makes a paid model request.

import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations, createDb, GameRepository } from "@werewolf/db";
import type { GameState } from "@werewolf/game-engine";
import type { BotConfig, GameId, UserId } from "@werewolf/protocol";
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

export const BOT_CONFIG: BotConfig = { provider: "fake", model: "fake-1", temperature: 0 };

/** Bot config with the human-like pause switched off, which is what automated
 * testing mode means here. */
export function testBotConfig(overrides: Record<string, string> = {}): BotRuntimeConfig {
  return loadBotConfig({
    BOT_MIN_DELAY_MS: "0",
    BOT_MAX_DELAY_MS: "0",
    BOT_AI_MODEL: "fake-1",
    ...overrides,
  });
}

/** Records every input it is handed, then answers with a scripted decision.
 * The recorded inputs are what the visibility tests assert against. */
export class RecordingBotAgent implements BotAgent {
  readonly inputs: BotDecisionInput[] = [];
  constructor(
    private readonly reply: (input: BotDecisionInput) => BotDecision = () => ({
      actionId: null,
      say: null,
      channel: null,
    }),
  ) {}
  decide(input: BotDecisionInput): Promise<BotDecision> {
    this.inputs.push(input);
    return Promise.resolve(this.reply(input));
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
    private readonly reply: (input: BotDecisionInput) => BotDecision,
  ) {}
  async decide(input: BotDecisionInput): Promise<BotDecision> {
    this.inputs.push(input);
    if (!this.gate(input)) return this.reply(input);
    this.gated.push(input);
    await new Promise<void>((resolve) => this.release.push(resolve));
    return this.reply(input);
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
  startBotGame: (count?: number) => Promise<GameId>;
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
    startBotGame: async (count = 5) => {
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
        },
        ownerController: { type: "bot", config: BOT_CONFIG },
      });
      const gameId = game!.id;
      await coordinator.addBots(gameId, host, { count, config: BOT_CONFIG });
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
