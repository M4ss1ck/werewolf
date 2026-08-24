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
import {
  type BotConfig,
  type ChatChannel,
  dayOfPhase,
  type GameEvent,
  type GameId,
  type GameplayCommand,
  type PhaseId,
  type UserId,
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
  /** Earliest time a bot may publish on each channel. Per channel, so the
   * pack whispering at night never blocks public chat during the day. */
  slots: Map<ChatChannel, number>;
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
    if (this.isPaced(state)) {
      // A human message occupies the room like any other. It buys no extra pause
      // (that was decided against), but the room does not answer over the top of it.
      for (const event of events) {
        if (event.kind !== "chat.message") continue;
        const actor = event.actorUserId ? state.players[event.actorUserId] : undefined;
        if (!actor || actor.controller?.type === "bot") continue;
        const channel = event.payload.channel;
        const previous = record.slots.get(channel) ?? 0;
        record.slots.set(channel, Math.max(previous, now + this.gapMs(state, channel, now)));
      }
    }
    for (const player of Object.values(state.players)) {
      const controller = player.controller;
      if (controller?.type !== "bot" || player.status !== "alive") continue;
      const directMentions = this.directMentions(state, player.id, events, now);
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
      // in discussion or voting, or at night on a secret channel, and only
      // because somebody else said something.
      if (used > 0 && !this.reactsToChat(state, player.id, used, events, directMentions, now))
        continue;
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
      slots: new Map(),
    };
    this.games.set(gameId, record);
    return record;
  }

  /** A chat message the bot may answer: anything it can hear during the day,
   * and at night only a message on a secret channel it is entitled to speak
   * on. Public chat is closed at night, and a channel the bot cannot speak on
   * must never reach it. */
  private chatWakes(state: GameState, playerId: UserId, event: GameEvent, now: number): boolean {
    if (event.kind !== "chat.message" || event.actorUserId === playerId) return false;
    if (!canViewEvent(event, playerId, state)) return false;
    if (state.phase?.type === "discussion" || state.phase?.type === "voting") return true;
    if (state.phase?.type === "night") {
      return (
        event.scope === "faction" &&
        (event.scopeId === "wolves" || event.scopeId === "cult") &&
        getSpeakableChannels(state, playerId, now).includes(event.scopeId)
      );
    }
    return false;
  }

  /** A bot answers back in a discussion or voting phase when another player
   * spoke where it could hear, up to its per-phase turn budget. At night it
   * answers only on a secret channel it is entitled to speak on, so the pack
   * can build a story in its own channel. The budget is the hard cap on model
   * calls. */
  private reactsToChat(
    state: GameState,
    playerId: UserId,
    used: number,
    events: GameEvent[],
    directMentions: GameEvent[],
    now: number,
  ): boolean {
    if (used >= this.options.config.BOT_CHAT_TURNS) return false;
    return (
      directMentions.length > 0 ||
      events.some((event) => this.chatWakes(state, playerId, event, now))
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
      let state = await this.coordinator.loadGameState(gameId);
      if (!this.isCurrent(state, phaseId, playerId)) {
        this.log("skipped", { decisionId, gameId, playerId, reason: "window_closed" });
        return;
      }
      const paced = await this.waitForSlot(state!, playerId, decisionId, record, directMentions);
      if (paced === "expired") {
        await this.send(decisionId, gameId, playerId, {
          commandId: `${decisionId}:ready`,
          phaseId,
          type: "phase.ready",
          payload: { ready: true },
        });
        this.log("skipped", { decisionId, gameId, playerId, reason: "slot_expired" });
        return;
      }
      state = await this.coordinator.loadGameState(gameId);
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
      const decision = await this.pool.run(() => this.options.agent.decide(input));
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
    // At night a seat keeps its turns only while it can speak on a secret
    // channel it is entitled to: the pack needs to build a story in its own
    // channel while playing innocent in public. A villager at night has no
    // such channel, so its first decision is still its last.
    const moreTurnsPossible =
      (input.phase === "discussion" ||
        input.phase === "voting" ||
        (input.phase === "night" &&
          (speakableChannels.includes("wolves") || speakableChannels.includes("cult")))) &&
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

  private directMentions(
    state: GameState,
    playerId: UserId,
    events: GameEvent[],
    now: number,
  ): GameEvent[] {
    return events.filter(
      (event) =>
        event.kind === "chat.message" &&
        this.chatWakes(state, playerId, event, now) &&
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
    // A pending mention may be delivered at night only while the seat can
    // still speak on a secret channel: entitlement can lapse between the
    // mention and the delivery, so a bot that lost the channel is dropped.
    const speakableChannels =
      state && phase ? getSpeakableChannels(state, playerId, this.now()) : [];
    const mayChatAtNight =
      phase?.type === "night" &&
      (speakableChannels.includes("wolves") || speakableChannels.includes("cult"));
    if (
      !state ||
      !phase ||
      state.status !== "running" ||
      this.games.get(gameId) !== record ||
      phase.id !== phaseId ||
      (phase.type !== "discussion" && phase.type !== "voting" && !mayChatAtNight) ||
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

  /** Pacing exists so a human can read the room and get a word in. A game of
   * nothing but bots has nobody to read it, so it runs unpaced — which is also
   * what keeps `bots:match` fast. Seat presence, never connection state: the
   * latter must never be authoritative over game flow. */
  private isPaced(state: GameState): boolean {
    return Object.values(state.players).some((player) => player.controller?.type !== "bot");
  }

  /** The channel a bot's turn is paced on. */
  private pacingChannel(state: GameState, playerId: UserId, now: number): ChatChannel | null {
    return getSpeakableChannels(state, playerId, now)[0] ?? null;
  }

  /** Wider rooms need more air between messages. */
  private gapMs(state: GameState, channel: ChatChannel, now: number): number {
    let speakers = 0;
    for (const player of Object.values(state.players)) {
      if (player.controller?.type !== "bot" || player.status !== "alive") continue;
      if (getSpeakableChannels(state, player.id, now).includes(channel)) speakers += 1;
    }
    const config = this.options.config;
    return config.BOT_GAP_BASE_MS + config.BOT_GAP_PER_BOT_MS * Math.max(0, speakers - 1);
  }

  /** Take the next free slot on this channel and push the channel's clock past it. */
  private reserveSlot(record: PhaseRecord, channel: ChatChannel, gap: number, now: number): number {
    const slotAt = Math.max(now, record.slots.get(channel) ?? 0);
    record.slots.set(channel, slotAt + gap);
    return slotAt;
  }

  /** Hold this turn until the room has space for it. */
  private async waitForSlot(
    state: GameState,
    playerId: UserId,
    decisionId: string,
    record: PhaseRecord,
    directMentions: GameEvent[],
  ): Promise<"ok" | "expired"> {
    const config = this.options.config;
    const now = this.now();
    const channel = this.pacingChannel(state, playerId, now);
    if (channel === null || !this.isPaced(state)) return "ok";

    const gap = this.gapMs(state, channel, now);
    let slotAt: number;
    if (directMentions.length > 0) {
      slotAt = now;
      record.slots.set(channel, Math.max(record.slots.get(channel) ?? 0, now + gap));
    } else {
      slotAt = this.reserveSlot(record, channel, gap, now);
    }
    if (slotAt >= state.phase!.endsAt) return "expired";

    const wait = this.jitter(
      Math.min(
        Math.max(slotAt - now, config.BOT_MIN_DELAY_MS),
        Math.max(config.BOT_MIN_DELAY_MS, config.BOT_MAX_DELAY_MS),
      ),
      decisionId,
    );
    if (wait > 0) await this.sleep(wait);
    return "ok";
  }

  /** +/-20% off the seeded RNG. */
  private jitter(ms: number, decisionId: string): number {
    if (ms <= 0) return 0;
    const roll = createRng(decisionId).derive("delay").int(41);
    return Math.round((ms * (80 + roll)) / 100);
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
