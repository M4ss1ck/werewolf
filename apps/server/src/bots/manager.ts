// The bot controller.
//
// It is a fourth subscriber to `coordinator.onCommitted`, alongside the phase
// scheduler and the game hub — it owns no phase logic of its own, it only
// notices that the authoritative state moved and asks whether a bot seat is
// now expected to do something.
//
// Bots never touch state. Everything they decide is submitted through
// `coordinator.executeCommand`, the same call the HTTP command route makes for
// a human, so validation, the per-game lock, the version fence and command
// idempotency all apply unchanged.

import {
  canViewEvent,
  createRng,
  filterVisibleEvents,
  type GameState,
  getLegalCommands,
  getSpeakableChannels,
  projectSnapshot,
} from "@werewolf/game-engine";
import type {
  BotConfig,
  GameEvent,
  GameId,
  GameplayCommand,
  PhaseId,
  UserId,
} from "@werewolf/protocol";
import { CoordinatorError, type GameCoordinator } from "../game/coordinator.ts";
import type { BotRuntimeConfig } from "./config.ts";
import { type BotLogger, silentBotLogger } from "./log.ts";
import type { BotAgent, BotDecision, BotDecisionInput } from "./types.ts";

/** Per-game bookkeeping for the phase currently in progress. Keying on the
 * phase id makes it self-pruning: a new phase simply replaces the record, so
 * turn counts and in-flight marks cannot leak across a phase boundary. */
type PhaseRecord = {
  phaseId: PhaseId;
  turns: Map<UserId, number>;
  inFlight: Set<UserId>;
};

export interface BotManagerOptions {
  agent: BotAgent;
  config: BotRuntimeConfig;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  logger?: BotLogger;
}

export class BotManager {
  private readonly games = new Map<GameId, PhaseRecord>();
  private readonly unsubscribe: () => boolean;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: BotLogger;
  private pending = 0;
  private waiters: (() => void)[] = [];

  constructor(
    private readonly coordinator: GameCoordinator,
    private readonly options: BotManagerOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.log = options.logger ?? silentBotLogger;
    this.unsubscribe = coordinator.onCommitted((gameId, events) => {
      // Counted synchronously, so a caller awaiting quiescence cannot observe
      // the gap between one bot's command committing and the reaction to it.
      this.track(() => this.react(gameId, events as GameEvent[]));
    });
  }

  stop() {
    this.unsubscribe();
    this.games.clear();
  }

  /** Resolves once no reaction or decision is outstanding. Used by the bot
   * match script and by tests to step a game forward deterministically. */
  whenIdle(): Promise<void> {
    if (this.pending === 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private track(work: () => Promise<void>): void {
    this.pending += 1;
    void work()
      .catch((error) => this.log("error", { message: String(error) }))
      .finally(() => {
        this.pending -= 1;
        if (this.pending > 0) return;
        const waiting = this.waiters;
        this.waiters = [];
        for (const resolve of waiting) resolve();
      });
  }

  /** Is input expected from any bot seat right now? */
  private async react(gameId: GameId, events: GameEvent[]): Promise<void> {
    const state = await this.coordinator.loadGameState(gameId);
    if (!state || state.status !== "running" || !state.phase) {
      this.games.delete(gameId);
      return;
    }
    const phase = state.phase;
    const record = this.recordFor(gameId, phase.id);
    const now = this.now();
    for (const player of Object.values(state.players)) {
      const controller = player.controller;
      if (controller?.type !== "bot" || player.status !== "alive") continue;
      if (record.inFlight.has(player.id)) continue;
      const used = record.turns.get(player.id) ?? 0;
      // First turn of the phase is unconditional; a further turn only happens
      // in discussion, and only because somebody else said something.
      if (used > 0 && !this.reactsToChat(state, player.id, used, events)) continue;
      const mustAct = getLegalCommands(state, player.id, now).length > 0;
      const maySpeak = getSpeakableChannels(state, player.id, now).length > 0;
      // A villager at night has neither an action nor a channel: no call, no cost.
      if (!mustAct && !maySpeak) continue;
      record.turns.set(player.id, used + 1);
      record.inFlight.add(player.id);
      this.track(() => this.decide(gameId, player.id, phase.id, used, controller.config, record));
    }
  }

  private recordFor(gameId: GameId, phaseId: PhaseId): PhaseRecord {
    const existing = this.games.get(gameId);
    if (existing && existing.phaseId === phaseId) return existing;
    const record: PhaseRecord = { phaseId, turns: new Map(), inFlight: new Set() };
    this.games.set(gameId, record);
    return record;
  }

  /** A bot answers back when another player spoke where it could hear, up to
   * its per-phase turn budget. The budget is the hard cap on model calls. */
  private reactsToChat(
    state: GameState,
    playerId: UserId,
    used: number,
    events: GameEvent[],
  ): boolean {
    if (state.phase?.type !== "discussion") return false;
    if (used >= this.options.config.BOT_DISCUSSION_TURNS) return false;
    return events.some(
      (event) =>
        event.kind === "chat.message" &&
        event.actorUserId !== playerId &&
        canViewEvent(event, playerId, state),
    );
  }

  private async decide(
    gameId: GameId,
    playerId: UserId,
    phaseId: PhaseId,
    turn: number,
    config: BotConfig,
    record: PhaseRecord,
  ): Promise<void> {
    const decisionId = `${gameId}:${playerId}:${phaseId}:${turn}`;
    const startedAt = this.now();
    try {
      const state = await this.coordinator.loadGameState(gameId);
      if (!this.isCurrent(state, phaseId, playerId)) {
        this.log("skipped", { decisionId, gameId, playerId, reason: "window_closed" });
        return;
      }
      const input = await this.buildInput(state!, playerId, phaseId, decisionId, config);
      // The pause runs alongside the model call rather than after it, so the
      // provider's own latency counts towards looking human instead of adding
      // to it. Neither blocks the game loop: the phase ends on its clock.
      const [decision] = await Promise.all([
        this.options.agent.decide(input),
        this.pause(decisionId),
      ]);
      await this.submit(gameId, playerId, phaseId, decisionId, decision, input, startedAt);
    } finally {
      record.inFlight.delete(playerId);
    }
  }

  private async buildInput(
    state: GameState,
    playerId: UserId,
    phaseId: PhaseId,
    decisionId: string,
    config: BotConfig,
  ): Promise<BotDecisionInput> {
    const now = this.now();
    // The bot's whole picture of the game is the viewer projection a human
    // client would receive, plus that viewer's visible events. There is no
    // path from here to the omniscient state.
    const playerView = projectSnapshot(state, playerId, 0, now);
    const stored = (await this.coordinator.getVisibleEvents(state.id, 0)) as GameEvent[];
    const visibleEvents = filterVisibleEvents(stored, playerId, state).slice(
      -this.options.config.BOT_HISTORY_LIMIT,
    );
    return {
      decisionId,
      gameId: state.id,
      playerId,
      phase: state.phase!.type,
      phaseId,
      remainingMs: Math.max(0, state.phase!.endsAt - now),
      ...(playerView.me?.role ? { role: playerView.me.role } : {}),
      ...(playerView.me?.faction ? { faction: playerView.me.faction } : {}),
      config,
      playerView,
      visibleEvents,
      legalActions: getLegalCommands(state, playerId, now).map((command, id) => ({ id, command })),
      speakableChannels: getSpeakableChannels(state, playerId, now),
    };
  }

  private async submit(
    gameId: GameId,
    playerId: UserId,
    phaseId: PhaseId,
    decisionId: string,
    decision: BotDecision,
    input: BotDecisionInput,
    startedAt: number,
  ): Promise<void> {
    // A model call can outlive the phase it was made for. Re-read the
    // authoritative state before touching the command path: a late night
    // action must never land during the following day.
    const state = await this.coordinator.loadGameState(gameId);
    if (!this.isCurrent(state, phaseId, playerId)) {
      this.log("discarded", {
        decisionId,
        gameId,
        playerId,
        phaseId,
        latencyMs: this.now() - startedAt,
        reason: "stale_response",
      });
      return;
    }
    if (decision.say !== null && decision.channel !== null)
      await this.send(decisionId, gameId, playerId, {
        commandId: `${decisionId}:say`,
        phaseId,
        type: "chat.send",
        payload: { channel: decision.channel, text: decision.say },
      });
    const action = input.legalActions.find((entry) => entry.id === decision.actionId)?.command;
    if (action)
      await this.send(decisionId, gameId, playerId, {
        ...action,
        commandId: `${decisionId}:action`,
      } as GameplayCommand);
    this.log("acted", {
      decisionId,
      gameId,
      playerId,
      phaseId,
      phase: input.phase,
      model: input.config.model,
      provider: input.config.provider,
      latencyMs: this.now() - startedAt,
      action: action?.type ?? "none",
      spoke: decision.say !== null,
    });
  }

  /** The command ids are derived from the decision id, so a retry of the same
   * decision window cannot produce a second chat message. */
  private async send(
    decisionId: string,
    gameId: GameId,
    playerId: UserId,
    command: GameplayCommand,
  ): Promise<void> {
    try {
      await this.coordinator.executeCommand(gameId, playerId, command);
    } catch (error) {
      // The engine refused it. That is the system working: log and move on,
      // never retry blindly into a closed phase.
      this.log("rejected", {
        decisionId,
        gameId,
        playerId,
        command: command.type,
        code: error instanceof CoordinatorError ? error.code : "UNKNOWN",
      });
    }
  }

  private isCurrent(state: GameState | null, phaseId: PhaseId, playerId: UserId): boolean {
    if (!state || state.status !== "running" || !state.phase) return false;
    if (state.phase.id !== phaseId) return false;
    if (this.now() >= state.phase.endsAt) return false;
    return state.players[playerId]?.status === "alive";
  }

  private async pause(decisionId: string): Promise<void> {
    const min = this.options.config.BOT_MIN_DELAY_MS;
    const max = Math.max(min, this.options.config.BOT_MAX_DELAY_MS);
    if (max <= 0) return;
    const spread = max - min;
    const jitter =
      spread === 0
        ? 0
        : createRng(decisionId)
            .derive("delay")
            .int(spread + 1);
    await this.sleep(min + jitter);
  }
}
