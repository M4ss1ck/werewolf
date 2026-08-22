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
  knownMentionTargets,
  projectedPlayerLabel,
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
import { composeBotChatContent } from "./mentions.ts";
import type { BotAgent, BotDecision, BotDecisionInput, BotMentionCandidate } from "./types.ts";

/** Per-game bookkeeping for the phase currently in progress. Keying on the
 * phase id makes it self-pruning: a new phase simply replaces the record, so
 * turn counts and in-flight marks cannot leak across a phase boundary. */
type PhaseRecord = {
  phaseId: PhaseId;
  turns: Map<UserId, number>;
  inFlight: Set<UserId>;
  pendingMentions: Map<UserId, GameEvent[]>;
};

export interface BotManagerOptions {
  agent: BotAgent;
  config: BotRuntimeConfig;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  logger?: BotLogger;
}

/** Caps model calls in flight across the whole process. A room full of
 * simultaneous games would otherwise open one connection per bot per phase and
 * collect rate limits, which degrade every bot to random play at once. Waiting
 * here is safe: a phase never waits for a bot, so the worst case is that a
 * queued bot misses its turn. */
class CallPool {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(private readonly limit: number) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    try {
      return await work();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

export class BotManager {
  private readonly games = new Map<GameId, PhaseRecord>();
  private readonly unsubscribe: () => boolean;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: BotLogger;
  private readonly pool: CallPool;
  private pending = 0;
  private waiters: (() => void)[] = [];

  constructor(
    private readonly coordinator: GameCoordinator,
    private readonly options: BotManagerOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.log = options.logger ?? silentBotLogger;
    this.pool = new CallPool(options.config.BOT_MAX_CONCURRENT_CALLS);
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
      const directMentions = this.directMentions(state, player.id, events);
      if (record.inFlight.has(player.id)) {
        if (directMentions.length > 0) this.rememberPending(record, player.id, directMentions);
        continue;
      }
      if (record.pendingMentions.has(player.id)) {
        await this.schedulePending(gameId, player.id, phase.id, controller.config, record);
        continue;
      }
      const used = record.turns.get(player.id) ?? 0;
      // First turn of the phase is unconditional; a further turn only happens
      // in discussion or voting, and only because somebody else said something.
      if (used > 0 && !this.reactsToChat(state, player.id, used, events, directMentions)) continue;
      const mustAct = getLegalCommands(state, player.id, now).length > 0;
      const maySpeak = getSpeakableChannels(state, player.id, now).length > 0;
      // A villager at night has neither an action nor a channel: no call, no cost.
      if (!mustAct && !maySpeak) continue;
      record.turns.set(player.id, used + 1);
      record.inFlight.add(player.id);
      this.track(() =>
        this.decide(gameId, player.id, phase.id, used, controller.config, record, directMentions),
      );
    }
  }

  private recordFor(gameId: GameId, phaseId: PhaseId): PhaseRecord {
    const existing = this.games.get(gameId);
    if (existing && existing.phaseId === phaseId) return existing;
    const record: PhaseRecord = {
      phaseId,
      turns: new Map(),
      inFlight: new Set(),
      pendingMentions: new Map(),
    };
    this.games.set(gameId, record);
    return record;
  }

  /** A bot answers back in a discussion or voting phase when another player
   * spoke where it could hear, up to its per-phase turn budget. The budget is
   * the hard cap on model calls. */
  private reactsToChat(
    state: GameState,
    playerId: UserId,
    used: number,
    events: GameEvent[],
    directMentions: GameEvent[],
  ): boolean {
    if (state.phase?.type !== "discussion" && state.phase?.type !== "voting") return false;
    if (used >= this.options.config.BOT_CHAT_TURNS) return false;
    return (
      directMentions.length > 0 ||
      events.some(
        (event) =>
          event.kind === "chat.message" &&
          event.actorUserId !== playerId &&
          canViewEvent(event, playerId, state),
      )
    );
  }

  private async decide(
    gameId: GameId,
    playerId: UserId,
    phaseId: PhaseId,
    turn: number,
    config: BotConfig,
    record: PhaseRecord,
    directMentions: GameEvent[],
  ): Promise<void> {
    const decisionId = `${gameId}:${playerId}:${phaseId}:${turn}`;
    const startedAt = this.now();
    try {
      const state = await this.coordinator.loadGameState(gameId);
      if (!this.isCurrent(state, phaseId, playerId)) {
        this.log("skipped", { decisionId, gameId, playerId, reason: "window_closed" });
        return;
      }
      const input = await this.buildInput(
        state!,
        playerId,
        phaseId,
        decisionId,
        config,
        directMentions,
      );
      // The pause runs alongside the model call rather than after it, so the
      // provider's own latency counts towards looking human instead of adding
      // to it. Neither blocks the game loop: the phase ends on its clock.
      const [decision] = await Promise.all([
        this.pool.run(() => this.options.agent.decide(input)),
        this.pause(decisionId),
      ]);
      await this.submit(gameId, playerId, phaseId, decisionId, decision, input, startedAt, turn);
    } finally {
      record.inFlight.delete(playerId);
      await this.schedulePending(gameId, playerId, phaseId, config, record);
    }
  }

  private async buildInput(
    state: GameState,
    playerId: UserId,
    phaseId: PhaseId,
    decisionId: string,
    config: BotConfig,
    directMentions: GameEvent[],
  ): Promise<BotDecisionInput> {
    const now = this.now();
    // The bot's whole picture of the game is the viewer projection a human
    // client would receive, plus that viewer's visible events. There is no
    // path from here to the omniscient state.
    const playerView = projectSnapshot(state, playerId, 0, now);
    // Only the tail of the log, never all of it: this runs once per bot per
    // turn, so reading the whole match would be the cost that grows with match
    // length. Over-fetch, because the visibility filter drops rows addressed to
    // other seats, then keep the last N that survive.
    const limit = this.options.config.BOT_HISTORY_LIMIT;
    const stored = (await this.coordinator.getRecentEvents(state.id, limit * 3)) as GameEvent[];
    const visibleEvents = filterVisibleEvents(stored, playerId, state).slice(-limit);
    // The phase-chat window and the day digest need more than the recent tail:
    // the current phase can hold a long conversation, and the digest reaches
    // back several days. One bounded fetch serves both — the caps bound what
    // reaches the prompt, and the fetch is a constant, so cost per decision
    // stays flat however long the match runs.
    const contextLimit =
      this.options.config.BOT_PHASE_CHAT_LIMIT * 4 + this.options.config.BOT_DIGEST_DAYS * 60;
    const contextStored = (await this.coordinator.getRecentEvents(
      state.id,
      contextLimit,
    )) as GameEvent[];
    const contextVisible = filterVisibleEvents(contextStored, playerId, state);
    const phaseChat = contextVisible
      .filter((event) => event.kind === "chat.message" && event.createdAt >= state.phase!.startedAt)
      .slice(-this.options.config.BOT_PHASE_CHAT_LIMIT);
    const names = (userId: UserId) =>
      playerView.players.find((player) => player.userId === userId)?.displayName ?? userId;
    const digest = buildDigest(contextVisible, names, this.options.config.BOT_DIGEST_DAYS);
    const speakableChannels = getSpeakableChannels(state, playerId, now);
    const candidatesByUser = new Map<
      UserId,
      { displayName: string; channels: Set<(typeof speakableChannels)[number]> }
    >();
    for (const channel of speakableChannels) {
      for (const target of knownMentionTargets(state, playerId, channel)) {
        const existing = candidatesByUser.get(target.id);
        if (existing) existing.channels.add(channel);
        else
          candidatesByUser.set(target.id, {
            displayName: projectedPlayerLabel(target),
            channels: new Set([channel]),
          });
      }
    }
    const channelOrder = new Map(
      ["public", "wolves", "grave", "cult"].map((channel, index) => [channel, index]),
    );
    const mentionCandidates: BotMentionCandidate[] = [...candidatesByUser.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([userId, candidate], index) => ({
        id: index + 1,
        userId,
        displayName: candidate.displayName,
        channels: [...candidate.channels].sort(
          (left, right) => (channelOrder.get(left) ?? 99) - (channelOrder.get(right) ?? 99),
        ),
      }));
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
      phaseChat,
      digest,
      legalActions: getLegalCommands(state, playerId, now).map((command, id) => ({ id, command })),
      speakableChannels,
      mentionCandidates,
      directMentions,
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
    turn: number,
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
    const speakableChannels = getSpeakableChannels(state!, playerId, this.now());
    if (decision.channel !== null && speakableChannels.includes(decision.channel)) {
      const currentTargetIds = new Set(
        knownMentionTargets(state!, playerId, decision.channel).map((target) => target.id),
      );
      const content = composeBotChatContent(decision, input, currentTargetIds);
      if (content !== null)
        await this.send(decisionId, gameId, playerId, {
          commandId: `${decisionId}:say`,
          phaseId,
          type: "chat.send",
          payload: { channel: decision.channel, ...content },
        });
    }
    const action = input.legalActions.find((entry) => entry.id === decision.actionId)?.command;
    if (action)
      await this.send(decisionId, gameId, playerId, {
        ...action,
        commandId: `${decisionId}:action`,
      } as GameplayCommand);
    // Readying is a mechanical consequence of having decided, not a strategic
    // choice the model weighs. It is sent after the action so the action is
    // stored before the ready can end the phase.
    //
    // The seat readies when the bot says it is done talking, or when it has
    // spent its last budgeted turn — whichever comes first. `done` is what
    // resolves the two failure modes: readying after every decision would end
    // the phase at its floor the moment every bot had spoken once, and never
    // readying would hold every phase to its hard deadline.
    //
    // At night `reactsToChat` is always false, so a bot's first decision is
    // also its last: `moreTurnsPossible` is false and the seat readies
    // unconditionally. That is intended — a night action is a single decision,
    // not a conversation — so do not "fix" it.
    const moreTurnsPossible =
      (input.phase === "discussion" || input.phase === "voting") &&
      turn + 1 < this.options.config.BOT_CHAT_TURNS;
    if (decision.done || !moreTurnsPossible)
      await this.send(decisionId, gameId, playerId, {
        commandId: `${decisionId}:ready`,
        phaseId,
        type: "phase.ready",
        payload: { ready: true },
      });
    this.log("acted", {
      decisionId,
      gameId,
      playerId,
      phaseId,
      phase: input.phase,
      model: input.config.model ?? "random",
      provider: input.config.provider,
      latencyMs: this.now() - startedAt,
      action: action?.type ?? "none",
      spoke: decision.say !== null,
    });
  }

  private directMentions(state: GameState, playerId: UserId, events: GameEvent[]): GameEvent[] {
    if (state.phase?.type !== "discussion" && state.phase?.type !== "voting") return [];
    return events.filter(
      (event) =>
        event.kind === "chat.message" &&
        event.actorUserId !== playerId &&
        canViewEvent(event, playerId, state) &&
        (event.payload.mentions ?? []).some((mention) => mention.userId === playerId),
    );
  }

  private rememberPending(record: PhaseRecord, playerId: UserId, events: GameEvent[]): void {
    const existing = record.pendingMentions.get(playerId) ?? [];
    const byId = new Map(existing.map((event) => [event.id, event]));
    for (const event of events) byId.set(event.id, event);
    const ordered = [...byId.values()].sort((left, right) => left.id - right.id);
    record.pendingMentions.set(playerId, ordered.slice(-this.options.config.BOT_PHASE_CHAT_LIMIT));
  }

  private async schedulePending(
    gameId: GameId,
    playerId: UserId,
    phaseId: PhaseId,
    config: BotConfig,
    record: PhaseRecord,
  ): Promise<void> {
    const pending = record.pendingMentions.get(playerId);
    if (!pending || pending.length === 0) return;
    if (record.inFlight.has(playerId)) return;
    const state = await this.coordinator.loadGameState(gameId);
    if (record.inFlight.has(playerId)) return;
    const currentPending = record.pendingMentions.get(playerId);
    if (!currentPending || currentPending.length === 0) return;
    const phase = state?.phase;
    const player = state?.players[playerId];
    if (
      !state ||
      !phase ||
      state.status !== "running" ||
      this.games.get(gameId) !== record ||
      phase.id !== phaseId ||
      (phase.type !== "discussion" && phase.type !== "voting") ||
      player?.status !== "alive" ||
      this.now() >= phase.endsAt
    ) {
      record.pendingMentions.delete(playerId);
      return;
    }
    const used = record.turns.get(playerId) ?? 0;
    if (used >= this.options.config.BOT_CHAT_TURNS) {
      record.pendingMentions.delete(playerId);
      return;
    }
    const hasWork =
      getLegalCommands(state, playerId, this.now()).length > 0 ||
      getSpeakableChannels(state, playerId, this.now()).length > 0;
    if (!hasWork) {
      record.pendingMentions.delete(playerId);
      return;
    }
    // Reserve the turn and consume the pending batch together, before tracking
    // the call, so commits racing this reservation cannot schedule duplicates.
    record.turns.set(playerId, used + 1);
    record.inFlight.add(playerId);
    record.pendingMentions.delete(playerId);
    this.track(() => this.decide(gameId, playerId, phaseId, used, config, record, currentPending));
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

/** One compact line per earlier day, built deterministically from the bot's
 * visible public events: who was voted out, who died in the night. Oldest
 * first, capped at `maxDays`, keeping the most recent days. No model call. */
function buildDigest(
  events: readonly GameEvent[],
  names: (userId: UserId) => string,
  maxDays: number,
): string[] {
  // The engine numbers phases sequentially and bumps the day after each night,
  // so a phase id maps to a day: ids 1-3 are day 1, 4-6 day 2, and so on.
  const dayOfPhase = (phaseId: PhaseId) => Math.floor((Number(phaseId) - 1) / 3) + 1;
  // vote.resolved names its own phase; night.resolved does not, so each night
  // resolution is paired with the most recent vote resolution before it —
  // which is the same day's vote. A night whose vote fell outside the window
  // is skipped rather than mislabelled.
  const days: { day: number; eliminated: UserId | null; deaths: UserId[] }[] = [];
  let lastVote: { day: number; eliminated: UserId | null } | null = null;
  for (const event of events) {
    if (event.kind === "vote.resolved") {
      lastVote = { day: dayOfPhase(event.payload.phaseId), eliminated: event.payload.eliminated };
    } else if (event.kind === "night.resolved" && lastVote !== null) {
      days.push({
        day: lastVote.day,
        eliminated: lastVote.eliminated,
        deaths: event.payload.deaths,
      });
    }
  }
  return days.slice(-maxDays).map((day) => {
    const vote =
      day.eliminated !== null ? `${names(day.eliminated)} was voted out` : "no one was voted out";
    const night =
      day.deaths.length > 0
        ? `${day.deaths.map(names).join(", ")} died in the night`
        : "no one died in the night";
    return `Day ${day.day}: ${vote}; ${night}.`;
  });
}
