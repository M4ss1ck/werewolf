import type { GameRepository } from "@werewolf/db";
import type { GameState } from "@werewolf/game-engine";
import {
  applyCommand,
  type DomainResult,
  startGame as engineStartGame,
  projectSnapshot,
  resolveExpiredPhase,
  resolveScheduledGame,
} from "@werewolf/game-engine";
import type {
  BotConfig,
  GameId,
  GamePhase,
  GameplayCommand,
  GameStatus,
  GameSummary,
  GameVisibility,
  PlayerController,
  UserId,
} from "@werewolf/protocol";
import { pickBotName } from "../bots/names.ts";
import {
  GameAccess,
  GameAccessError,
  type GameAccessSurface,
  type GameAccessViewer,
} from "./game-access.ts";
import { type GameLock, gameLocks } from "./locks.ts";

export class CoordinatorError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export type CoordinatorEventHook = (gameId: GameId, events: unknown[]) => void | Promise<void>;

export class GameCoordinator {
  private hooks = new Set<CoordinatorEventHook>();
  private readonly access: GameAccess;
  constructor(
    private readonly repository: GameRepository,
    private readonly lock: GameLock = gameLocks,
    private readonly now: () => number = Date.now,
  ) {
    this.access = new GameAccess(repository, lock, now, (gameId) => this.notify(gameId));
  }

  onCommitted(hook: CoordinatorEventHook) {
    this.hooks.add(hook);
    return () => this.hooks.delete(hook);
  }

  /** Membership and meta changes commit no events, but waiting players still
   * need a fresh snapshot (lobby roster, game name, visibility). Fire the
   * commit hooks with an empty event list — the hub answers with a sync frame. */
  private async notify(gameId: GameId) {
    await Promise.all([...this.hooks].map((hook) => hook(gameId, [])));
  }

  private async transition(gameId: GameId, resolve: (state: GameState) => DomainResult) {
    return this.lock.run(gameId, async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const state = await this.repository.loadGameState(gameId);
        if (!state) throw new CoordinatorError("GAME_NOT_FOUND");
        const result = resolve(state);
        if (!result.ok) throw new CoordinatorError(result.error.code);
        const commit = await this.repository.commitTransition(
          gameId,
          state.version,
          result.transition,
          this.now(),
        );
        if (commit.ok) {
          await Promise.all([...this.hooks].map((hook) => hook(gameId, commit.events)));
          return { state: await this.repository.loadGameState(gameId), events: commit.events };
        }
      }
      throw new CoordinatorError("CONFLICT");
    });
  }

  async createGame(input: {
    ownerUserId: UserId;
    displayName: string;
    name: string;
    visibility: string;
    settings: unknown;
    scheduledAt?: number | undefined;
    /** Lets the host seat itself be a bot, so a fully unattended match is a
     * real all-bot game rather than one idle human. Only the bot match script
     * and its tests pass this; the HTTP route never does. */
    ownerController?: PlayerController | undefined;
  }) {
    const id = crypto.randomUUID() as GameId;
    // A start time in the past is not a schedule: fall through to a plain lobby
    // rather than creating a game whose deadline has already gone.
    const scheduled = input.scheduledAt !== undefined && input.scheduledAt > this.now();
    await this.repository.createGame({
      id,
      ownerUserId: input.ownerUserId,
      name: input.name,
      visibility: input.visibility,
      status: scheduled ? "scheduled" : "lobby",
      ...(scheduled && input.scheduledAt !== undefined ? { scheduledAt: input.scheduledAt } : {}),
      settings: input.settings,
      balanceVersion: 1,
      rngSeed: crypto.randomUUID(),
      createdAt: this.now(),
      ownerDisplayName: input.displayName,
      ...(input.ownerController ? { ownerController: input.ownerController } : {}),
    });
    // Creation is a state change like any other: tell the hooks so the scheduler
    // can arm this game's timer. No events yet, and no subscribers either.
    await Promise.all([...this.hooks].map((hook) => hook(id, [])));
    return this.repository.loadGameState(id);
  }
  async joinGame(gameId: GameId, userId: UserId, displayName: string) {
    await this.access.admit(
      { kind: "public-game", gameId },
      { userId, username: displayName },
      "player",
    );
    return this.snapshot(gameId, userId);
  }
  async spectateGame(gameId: GameId, userId: UserId, displayName: string) {
    await this.access.admit(
      { kind: "public-game", gameId },
      { userId, username: displayName },
      "spectator",
    );
    return this.snapshot(gameId, userId);
  }
  /** Which roster entries already hold a seat in this game. The lobby uses it
   * to grey out a bot that is already at the table. */
  async seatedBotIds(gameId: GameId): Promise<Set<string>> {
    const players = await this.repository.getStatePlayers(gameId);
    const seated = new Set<string>();
    for (const player of players) {
      if (player.controllerJson === null) continue;
      const controller = JSON.parse(player.controllerJson) as PlayerController;
      if (controller.type === "bot") seated.add(controller.config.botId);
    }
    return seated;
  }

  /** Seat one bot from the roster. A bot seat is an ordinary lobby player
   * carrying a controller, so joining, kicking, role assignment and
   * elimination all work on it unchanged; only who decides for it differs. Bot
   * user ids are namespaced so they can never collide with an auth user id. */
  async addBot(gameId: GameId, owner: UserId, input: { displayName: string; config: BotConfig }) {
    await this.authorizeGameAccess(gameId, owner, "mutation");
    return this.lock.run(gameId, async () => {
      const game = await this.repository.getGame(gameId);
      if (!game) throw new CoordinatorError("GAME_NOT_FOUND");
      if (game.ownerUserId !== owner) throw new CoordinatorError("NOT_GAME_OWNER");
      if (game.status !== "lobby" && game.status !== "scheduled")
        throw new CoordinatorError("GAME_ALREADY_STARTED");
      // Re-checked here rather than trusted from the listing: this runs under
      // the per-game lock, so two hosts clicking at once cannot seat the same
      // bot twice.
      const seated = await this.seatedBotIds(gameId);
      if (seated.has(input.config.botId)) throw new CoordinatorError("ACTION_NOT_AVAILABLE");
      const players = await this.repository.getStatePlayers(gameId);
      const taken = new Set(players.map((player) => player.displayName));
      const commit = await this.repository.commitMembership(gameId, game.version, {
        kind: "insert",
        player: {
          gameId,
          userId: `bot:${crypto.randomUUID()}` as UserId,
          displayName: taken.has(input.displayName) ? pickBotName(taken) : input.displayName,
          joinedAt: this.now(),
          controller: { type: "bot", config: input.config },
        },
      });
      if (!commit.ok) throw new CoordinatorError("CONFLICT");
      await this.notify(gameId);
      return this.snapshot(gameId, owner);
    });
  }
  async leaveLobby(gameId: GameId, userId: UserId) {
    await this.access.leave(gameId, { userId });
  }
  async kickLobbyPlayer(gameId: GameId, owner: UserId, userId: UserId) {
    await this.authorizeGameAccess(gameId, owner, "mutation");
    await this.access.kick(gameId, owner, userId);
    return this.snapshot(gameId, owner);
  }
  async updateGame(
    gameId: GameId,
    userId: UserId,
    patch: { name?: string | undefined; visibility?: string | undefined },
  ) {
    await this.authorizeGameAccess(gameId, userId, "mutation");
    return this.lock.run(gameId, async () => {
      const game = await this.repository.getGame(gameId);
      if (!game) throw new CoordinatorError("GAME_NOT_FOUND");
      if (game.ownerUserId !== userId) throw new CoordinatorError("NOT_GAME_OWNER");
      if (game.status !== "lobby" && game.status !== "scheduled")
        throw new CoordinatorError("GAME_ALREADY_STARTED");
      await this.repository.updateGame(gameId, patch);
      await this.notify(gameId);
      return this.snapshot(gameId, userId);
    });
  }
  async startGame(gameId: GameId, userId: UserId) {
    await this.authorizeGameAccess(gameId, userId, "mutation");
    return this.lock.run(gameId, async () => {
      const row = await this.repository.getGame(gameId);
      if (!row) throw new CoordinatorError("GAME_NOT_FOUND");
      if (row.ownerUserId !== userId) throw new CoordinatorError("NOT_GAME_OWNER");
      await this.transitionUnlocked(gameId, (state) => {
        if (state.players[userId] === undefined)
          return { ok: false, error: { code: "NOT_A_MEMBER" } };
        return engineStartGame(state, { now: this.now(), seed: row.rngSeed ?? gameId });
      });
      return this.snapshot(gameId, userId);
    });
  }
  async cancelGame(gameId: GameId, userId: UserId) {
    await this.authorizeGameAccess(gameId, userId, "mutation");
    return this.lock.run(gameId, async () => {
      const game = await this.repository.getGame(gameId);
      if (!game) throw new CoordinatorError("GAME_NOT_FOUND");
      if (game.ownerUserId !== userId) throw new CoordinatorError("NOT_GAME_OWNER");
      const commit = await this.repository.commitTransition(
        gameId,
        game.version,
        { gamePatch: { status: "cancelled" }, playerPatches: [], events: [], ephemeral: [] },
        this.now(),
      );
      if (!commit.ok) throw new CoordinatorError("CONFLICT");
      await Promise.all([...this.hooks].map((hook) => hook(gameId, commit.events)));
      return this.snapshot(gameId, userId);
    });
  }
  async executeCommand(gameId: GameId, userId: UserId, command: GameplayCommand) {
    await this.authorizeGameAccess(gameId, userId, "mutation");
    await this.transition(gameId, (state) => {
      const result = applyCommand(state, userId, command, { now: this.now() });
      // Commands are idempotent via command_id: stamp every event the engine
      // produced with the command's id so a retry cannot insert a duplicate
      // row (the repository dedupes on (game_id, command_id)).
      if (result.ok)
        for (const event of result.transition.events)
          (event as { commandId?: string }).commandId = command.commandId;
      return result;
    });
    return this.snapshot(gameId, userId);
  }
  async resolvePhase(gameId: GameId) {
    return this.transition(gameId, (state) =>
      resolveExpiredPhase(state, { now: this.now(), seed: gameId }),
    );
  }
  async resolveScheduled(gameId: GameId) {
    return this.transition(gameId, (state) =>
      resolveScheduledGame(state, { now: this.now(), seed: gameId }),
    );
  }
  async snapshot(gameId: GameId, userId: UserId) {
    await this.authorizeGameAccess(gameId, userId, "game");
    const state = await this.repository.loadGameState(gameId);
    if (!state) throw new CoordinatorError("GAME_NOT_FOUND");
    return projectSnapshot(state, userId, undefined, this.now());
  }
  async listGameSummaries(
    viewerUserId?: UserId,
    scope: "browse" | "mine" = "browse",
  ): Promise<GameSummary[]> {
    const rows = await this.repository.listGameSummaries(viewerUserId, scope);
    const serverNow = this.now();
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      ownerUserId: row.ownerUserId,
      status: row.status as GameStatus,
      visibility: row.visibility as GameVisibility,
      day: row.day,
      playerCount: row.players.length,
      players: row.players,
      ...(row.scheduledAt !== null ? { scheduledAt: row.scheduledAt } : {}),
      ...(row.status === "running" && row.phase !== null && row.phaseEndsAt !== null
        ? { phase: { type: row.phase as GamePhase, endsAt: row.phaseEndsAt } }
        : {}),
      ...(row.membership ? { membership: row.membership } : {}),
      serverNow,
    }));
  }
  async getGame(gameId: GameId) {
    return this.repository.getGame(gameId);
  }
  async authorizeGameAccess(gameId: GameId, userId: UserId, surface: GameAccessSurface) {
    try {
      return await this.access.authorize(gameId, { userId }, surface);
    } catch (error) {
      if (error instanceof GameAccessError) throw new CoordinatorError(error.code);
      throw error;
    }
  }
  /** Keep a live handshake and the membership mutations that can revoke it in
   * the same per-game critical section. The hub uses this only around its
   * final authorization check and socket send. */
  async withGameLock<T>(gameId: GameId, fn: () => Promise<T>) {
    return this.lock.run(gameId, fn);
  }
  async loadGameStateForViewer(gameId: GameId, userId: UserId, surface: GameAccessSurface) {
    await this.authorizeGameAccess(gameId, userId, surface);
    return this.repository.loadGameState(gameId);
  }
  /** Trusted hub seam for a post-commit broadcast. The hub has already
   * filtered subscribers against this one authoritative state in memory. */
  async loadGameStateForHub(gameId: GameId) {
    return this.repository.loadGameState(gameId);
  }
  async getVisibleEventsForHub(gameId: GameId, afterId = 0) {
    return this.repository.getVisibleEvents(gameId, afterId);
  }
  async getVisibleEventsForViewer(
    gameId: GameId,
    userId: UserId,
    surface: GameAccessSurface,
    afterId = 0,
  ) {
    await this.authorizeGameAccess(gameId, userId, surface);
    return this.repository.getVisibleEvents(gameId, afterId);
  }
  async previewGameEntry(
    reference: Parameters<GameAccess["preview"]>[0],
    viewer: GameAccessViewer,
  ) {
    return this.access.preview(reference, viewer);
  }
  async admitGameEntry(
    reference: Parameters<GameAccess["admit"]>[0],
    viewer: GameAccessViewer,
    mode: Parameters<GameAccess["admit"]>[2],
  ) {
    return this.access.admit(reference, viewer, mode);
  }
  async ownerInvitation(gameId: GameId, viewer: GameAccessViewer) {
    return this.access.ownerInvitation(gameId, viewer);
  }
  async loadGameState(gameId: GameId) {
    return this.repository.loadGameState(gameId);
  }
  async getVisibleEvents(gameId: GameId, afterId = 0) {
    return this.repository.getVisibleEvents(gameId, afterId);
  }
  async getRecentEvents(gameId: GameId, limit: number) {
    return this.repository.getRecentEvents(gameId, limit);
  }

  private async transitionUnlocked(gameId: GameId, resolve: (state: GameState) => DomainResult) {
    const state = await this.repository.loadGameState(gameId);
    if (!state) throw new CoordinatorError("GAME_NOT_FOUND");
    const result = resolve(state);
    if (!result.ok) throw new CoordinatorError(result.error.code);
    const commit = await this.repository.commitTransition(
      gameId,
      state.version,
      result.transition,
      this.now(),
    );
    if (!commit.ok) throw new CoordinatorError("CONFLICT");
    await Promise.all([...this.hooks].map((hook) => hook(gameId, commit.events)));
    return { state: await this.repository.loadGameState(gameId), events: commit.events };
  }
}
