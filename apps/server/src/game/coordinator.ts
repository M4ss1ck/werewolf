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
import type { GameId, GameplayCommand, UserId } from "@werewolf/protocol";
import { type GameLock, gameLocks } from "./locks.ts";

export class CoordinatorError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export type CoordinatorEventHook = (gameId: GameId, events: unknown[]) => void | Promise<void>;

export class GameCoordinator {
  private hooks = new Set<CoordinatorEventHook>();
  constructor(
    private readonly repository: GameRepository,
    private readonly lock: GameLock = gameLocks,
    private readonly now: () => number = Date.now,
  ) {}

  onCommitted(hook: CoordinatorEventHook) {
    this.hooks.add(hook);
    return () => this.hooks.delete(hook);
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
    name: string;
    visibility: string;
    settings: unknown;
  }) {
    const id = crypto.randomUUID() as GameId;
    await this.repository.createGame({
      id,
      ownerUserId: input.ownerUserId,
      name: input.name,
      visibility: input.visibility,
      status: "lobby",
      settings: input.settings,
      balanceVersion: 1,
      rngSeed: crypto.randomUUID(),
      createdAt: this.now(),
    });
    await this.repository.addPlayer({
      gameId: id,
      userId: input.ownerUserId,
      displayName: input.ownerUserId,
      joinedAt: this.now(),
    });
    return this.repository.loadGameState(id);
  }
  async joinGame(gameId: GameId, userId: UserId, displayName = userId) {
    return this.lock.run(gameId, async () => {
      const game = await this.repository.getGame(gameId);
      if (!game) throw new CoordinatorError("GAME_NOT_FOUND");
      if (game.status !== "lobby") throw new CoordinatorError("GAME_ALREADY_STARTED");
      const players = await this.repository.getPlayers(gameId);
      if (!players.some((p) => p.userId === userId))
        await this.repository.addPlayer({ gameId, userId, displayName, joinedAt: this.now() });
      return this.repository.loadGameState(gameId);
    });
  }
  async spectateGame(gameId: GameId, userId: UserId, displayName = userId) {
    return this.lock.run(gameId, async () => {
      const game = await this.repository.getGame(gameId);
      if (!game) throw new CoordinatorError("GAME_NOT_FOUND");
      if (game.status === "cancelled") throw new CoordinatorError("GAME_CANCELLED");
      if (game.status === "finished") throw new CoordinatorError("GAME_ALREADY_STARTED");
      const settings = JSON.parse(game.settingsJson) as { spectatingEnabled?: boolean };
      if (settings.spectatingEnabled === false) throw new CoordinatorError("ACTION_NOT_AVAILABLE");
      const players = await this.repository.getPlayers(gameId);
      if (!players.some((player) => player.userId === userId))
        await this.repository.addPlayer({
          gameId,
          userId,
          displayName,
          status: "spectator",
          joinedAt: this.now(),
        });
      return this.repository.loadGameState(gameId);
    });
  }
  async leaveLobby(gameId: GameId, userId: UserId) {
    return this.lock.run(gameId, async () => {
      const game = await this.repository.getGame(gameId);
      if (!game) throw new CoordinatorError("GAME_NOT_FOUND");
      if (game.status !== "lobby" && game.status !== "scheduled")
        throw new CoordinatorError("GAME_ALREADY_STARTED");
      await this.repository.removePlayer(gameId, userId);
      return this.repository.loadGameState(gameId);
    });
  }
  async kickLobbyPlayer(gameId: GameId, owner: UserId, userId: UserId) {
    return this.lock.run(gameId, async () => {
      const game = await this.repository.getGame(gameId);
      if (!game) throw new CoordinatorError("GAME_NOT_FOUND");
      if (game.ownerUserId !== owner) throw new CoordinatorError("NOT_GAME_OWNER");
      if (game.status !== "lobby" && game.status !== "scheduled")
        throw new CoordinatorError("GAME_ALREADY_STARTED");
      await this.repository.removePlayer(gameId, userId);
      return this.repository.loadGameState(gameId);
    });
  }
  async updateGame(
    gameId: GameId,
    userId: UserId,
    patch: { name?: string | undefined; visibility?: string | undefined },
  ) {
    return this.lock.run(gameId, async () => {
      const game = await this.repository.getGame(gameId);
      if (!game) throw new CoordinatorError("GAME_NOT_FOUND");
      if (game.ownerUserId !== userId) throw new CoordinatorError("NOT_GAME_OWNER");
      if (game.status !== "lobby" && game.status !== "scheduled")
        throw new CoordinatorError("GAME_ALREADY_STARTED");
      await this.repository.updateGame(gameId, patch);
      return this.repository.loadGameState(gameId);
    });
  }
  async startGame(gameId: GameId, userId: UserId) {
    return this.lock.run(gameId, async () => {
      const row = await this.repository.getGame(gameId);
      if (!row) throw new CoordinatorError("GAME_NOT_FOUND");
      if (row.ownerUserId !== userId) throw new CoordinatorError("NOT_GAME_OWNER");
      return this.transitionUnlocked(gameId, (state) => {
        if (state.players[userId] === undefined)
          return { ok: false, error: { code: "NOT_A_MEMBER" } };
        return engineStartGame(state, { now: this.now(), seed: row.rngSeed ?? gameId });
      });
    });
  }
  async cancelGame(gameId: GameId, userId: UserId) {
    return this.lock.run(gameId, async () => {
      const game = await this.repository.getGame(gameId);
      if (!game) throw new CoordinatorError("GAME_NOT_FOUND");
      if (game.ownerUserId !== userId) throw new CoordinatorError("NOT_GAME_OWNER");
      await this.repository.commitTransition(
        gameId,
        game.version,
        { gamePatch: { status: "cancelled" }, playerPatches: [], events: [], ephemeral: [] },
        this.now(),
      );
      return this.repository.loadGameState(gameId);
    });
  }
  async executeCommand(gameId: GameId, userId: UserId, command: GameplayCommand) {
    return this.transition(gameId, (state) => {
      const result = applyCommand(state, userId, command, { now: this.now() });
      // Commands are idempotent via command_id: stamp every event the engine
      // produced with the command's id so a retry cannot insert a duplicate
      // row (the repository dedupes on (game_id, command_id)).
      if (result.ok)
        for (const event of result.transition.events)
          (event as { commandId?: string }).commandId = command.commandId;
      return result;
    });
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
    const state = await this.repository.loadGameState(gameId);
    if (!state) throw new CoordinatorError("GAME_NOT_FOUND");
    return projectSnapshot(state, userId, undefined, this.now());
  }
  async listPublicGames() {
    return this.repository.listPublicGames();
  }
  async getGame(gameId: GameId) {
    return this.repository.getGame(gameId);
  }
  async loadGameState(gameId: GameId) {
    return this.repository.loadGameState(gameId);
  }
  async getVisibleEvents(gameId: GameId, afterId = 0) {
    return this.repository.getVisibleEvents(gameId, afterId);
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
