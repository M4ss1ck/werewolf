import type { DomainTransition, PlayerPatch } from "@werewolf/game-engine";
import type { EventId, GameId, PlayerController, UserId } from "@werewolf/protocol";
import { and, asc, desc, eq, gt, inArray, isNotNull, ne, sql } from "drizzle-orm";
import type { Db } from "./client.ts";
import { mapEvent, mapGame } from "./mapper.ts";
import { gameEvents, gamePlayers, games } from "./schema.ts";

export type CreateGameInput = {
  id: GameId;
  ownerUserId: UserId;
  name: string;
  joinCode?: string;
  visibility: string;
  status: string;
  settings: unknown;
  balanceVersion: number;
  rngSeed?: string;
  scheduledAt?: number;
  createdAt: number;
};
export type AddPlayerInput = {
  gameId: GameId;
  userId: UserId;
  displayName: string;
  status?: string;
  joinedAt: number;
  originalRole?: string | null;
  role?: string | null;
  faction?: string | null;
  controller?: PlayerController;
};
export type CommitResult =
  | { ok: true; events: ReturnType<typeof mapEvent>[]; version: number }
  | { ok: false; stale: true };

/** A public game row plus its roster, shaped for the coordinator to map into
 * `PublicGameSummary`. Never carries rngSeed, joinCode or the JSON blobs. */
export type GameSummaryRow = {
  id: GameId;
  ownerUserId: UserId;
  name: string;
  status: string;
  visibility: string;
  day: number;
  phase: string | null;
  phaseEndsAt: number | null;
  scheduledAt: number | null;
  players: { userId: UserId; displayName: string }[];
};

export type UserStats = { games: number; survived: number; asWolf: number };

export class GameRepository {
  constructor(private readonly db: Db) {}
  async createGame(input: CreateGameInput) {
    await this.db.insert(games).values({
      id: input.id,
      ownerUserId: input.ownerUserId,
      name: input.name,
      joinCode: input.joinCode,
      visibility: input.visibility,
      status: input.status,
      scheduledAt: input.scheduledAt,
      settingsJson: JSON.stringify(input.settings),
      balanceVersion: input.balanceVersion,
      rngSeed: input.rngSeed,
      createdAt: input.createdAt,
    });
    return this.getGame(input.id);
  }
  async listGameSummaries(): Promise<GameSummaryRow[]> {
    const rows = await this.db
      .select({
        id: games.id,
        ownerUserId: games.ownerUserId,
        name: games.name,
        status: games.status,
        visibility: games.visibility,
        day: games.day,
        phase: games.phase,
        phaseEndsAt: games.phaseEndsAt,
        scheduledAt: games.scheduledAt,
      })
      .from(games)
      .where(and(eq(games.visibility, "public"), ne(games.status, "cancelled")))
      .orderBy(asc(games.createdAt));
    if (rows.length === 0) return [];
    const players = await this.db
      .select({
        gameId: gamePlayers.gameId,
        userId: gamePlayers.userId,
        displayName: gamePlayers.displayName,
      })
      .from(gamePlayers)
      .where(
        inArray(
          gamePlayers.gameId,
          rows.map((row) => row.id),
        ),
      );
    const byGame = new Map<string, { userId: UserId; displayName: string }[]>();
    for (const player of players) {
      const list = byGame.get(player.gameId) ?? [];
      list.push({ userId: player.userId as UserId, displayName: player.displayName });
      byGame.set(player.gameId, list);
    }
    return rows.map((row) => ({
      id: row.id as GameId,
      ownerUserId: row.ownerUserId as UserId,
      name: row.name,
      status: row.status,
      visibility: row.visibility,
      day: row.day,
      phase: row.phase,
      phaseEndsAt: row.phaseEndsAt,
      scheduledAt: row.scheduledAt,
      players: byGame.get(row.id) ?? [],
    }));
  }
  /** Lifetime stats over finished games the viewer actually played (spectated
   * games and unfinished games excluded), in one aggregate query. */
  async getUserStats(userId: UserId): Promise<UserStats> {
    const rows = await this.db
      .select({
        games: sql<number>`count(*)`,
        survived: sql<number>`coalesce(sum(case when ${gamePlayers.status} = 'alive' then 1 else 0 end), 0)`,
        asWolf: sql<number>`coalesce(sum(case when ${gamePlayers.faction} = 'wolves' then 1 else 0 end), 0)`,
      })
      .from(gamePlayers)
      .innerJoin(games, eq(gamePlayers.gameId, games.id))
      .where(
        and(
          eq(gamePlayers.userId, userId),
          eq(games.status, "finished"),
          inArray(gamePlayers.status, ["alive", "dead"]),
        ),
      );
    const row = rows[0] ?? { games: 0, survived: 0, asWolf: 0 };
    return { games: row.games, survived: row.survived, asWolf: row.asWolf };
  }
  async listScheduledGames() {
    return this.db.select().from(games).where(eq(games.status, "scheduled"));
  }
  async listRunningGames() {
    return this.db
      .select()
      .from(games)
      .where(and(eq(games.status, "running"), isNotNull(games.phaseEndsAt)));
  }
  async getGame(gameId: GameId) {
    return (await this.db.select().from(games).where(eq(games.id, gameId)).limit(1))[0] ?? null;
  }
  async getPlayers(gameId: GameId) {
    return this.db.select().from(gamePlayers).where(eq(gamePlayers.gameId, gameId));
  }
  async loadGameState(gameId: GameId) {
    const game = await this.getGame(gameId);
    return game ? mapGame({ game, players: await this.getPlayers(gameId) }) : null;
  }
  async addPlayer(input: AddPlayerInput) {
    await this.db.insert(gamePlayers).values({
      gameId: input.gameId,
      userId: input.userId,
      displayName: input.displayName,
      status: input.status ?? "lobby",
      joinedAt: input.joinedAt,
      originalRole: input.originalRole,
      role: input.role,
      faction: input.faction,
      controllerJson: input.controller ? JSON.stringify(input.controller) : null,
    });
  }
  async removePlayer(gameId: GameId, userId: UserId) {
    await this.db
      .delete(gamePlayers)
      .where(and(eq(gamePlayers.gameId, gameId), eq(gamePlayers.userId, userId)));
  }
  async updateGame(
    gameId: GameId,
    patch: { name?: string | undefined; visibility?: string | undefined },
  ) {
    const changes: Partial<typeof games.$inferInsert> = {};
    if (patch.name !== undefined) changes.name = patch.name;
    if (patch.visibility !== undefined) changes.visibility = patch.visibility;
    if (Object.keys(changes).length === 0) return;
    await this.db.update(games).set(changes).where(eq(games.id, gameId));
  }
  async updatePlayerPhaseState(gameId: GameId, userId: UserId, phaseState: unknown) {
    await this.db
      .update(gamePlayers)
      .set({ phaseStateJson: JSON.stringify(phaseState) })
      .where(and(eq(gamePlayers.gameId, gameId), eq(gamePlayers.userId, userId)));
  }
  /** The tail of a game's log, newest last. Bots build every prompt from a
   * bounded slice of history, so reading the whole log per decision is the one
   * cost that grows with match length. */
  async getRecentEvents(gameId: GameId, limit: number) {
    const rows = await this.db
      .select()
      .from(gameEvents)
      .where(eq(gameEvents.gameId, gameId))
      .orderBy(desc(gameEvents.id))
      .limit(limit);
    return rows.reverse().map(mapEvent);
  }
  async getVisibleEvents(gameId: GameId, afterId = 0) {
    const rows = await this.db
      .select()
      .from(gameEvents)
      .where(and(eq(gameEvents.gameId, gameId), gt(gameEvents.id, afterId)))
      .orderBy(asc(gameEvents.id));
    return rows.map(mapEvent);
  }

  async commitTransition(
    gameId: GameId,
    expectedVersion: number,
    transition: DomainTransition,
    createdAt = Date.now(),
  ): Promise<CommitResult> {
    return this.db.transaction(async (tx) => {
      const updated = await tx
        .update(games)
        .set({ ...gamePatchToRow(transition.gamePatch), version: expectedVersion + 1 })
        .where(and(eq(games.id, gameId), eq(games.version, expectedVersion)))
        .returning({ version: games.version });
      if (updated.length === 0) return { ok: false, stale: true };
      const inserted: ReturnType<typeof mapEvent>[] = [];
      for (const draft of transition.events) {
        const commandId = (draft as unknown as { commandId?: string }).commandId;
        const [insertedRow] = await tx
          .insert(gameEvents)
          .values({
            gameId,
            kind: draft.kind,
            actorUserId: draft.actorUserId,
            scope: draft.scope,
            scopeId: draft.scopeId,
            commandId,
            payloadJson: JSON.stringify(draft.payload),
            createdAt,
          })
          .onConflictDoNothing()
          .returning();
        // The id must come from the insert itself: every event in one
        // transition shares a single createdAt, so a read-back keyed on kind
        // and createdAt would hand several same-kind events the first row's id.
        // Only the (game_id, command_id) idempotent retry skips the insert, so
        // that is the one path that falls back to reading the existing row.
        const row =
          insertedRow ??
          (commandId !== undefined
            ? (
                await tx
                  .select()
                  .from(gameEvents)
                  .where(and(eq(gameEvents.gameId, gameId), eq(gameEvents.commandId, commandId)))
                  .limit(1)
              )[0]
            : undefined);
        if (row) inserted.push(mapEvent(row));
        if (draft.kind === "wolves.member_joined" && row)
          await tx
            .update(gamePlayers)
            .set({ wolfSinceEventId: row.id as EventId })
            .where(
              and(
                eq(gamePlayers.gameId, gameId),
                eq(gamePlayers.userId, (draft.payload as { playerId: UserId }).playerId),
              ),
            );
      }
      for (const patch of transition.playerPatches) await applyPlayerPatch(tx, gameId, patch);
      return { ok: true, events: inserted, version: expectedVersion + 1 };
    });
  }
}

function gamePatchToRow(patch: DomainTransition["gamePatch"]): Partial<typeof games.$inferInsert> {
  if (!patch) return {};
  const result: Partial<typeof games.$inferInsert> = {};
  if (patch.status !== undefined) result.status = patch.status;
  if (patch.day !== undefined) result.day = patch.day;
  if (patch.scheduledAt !== undefined) result.scheduledAt = patch.scheduledAt;
  if (patch.phase !== undefined) {
    result.phase = patch.phase?.type ?? null;
    result.phaseId = patch.phase?.id ?? 0;
    result.phaseStartedAt = patch.phase?.startedAt ?? null;
    result.phaseEndsAt = patch.phase?.endsAt ?? null;
  }
  if (patch.winner !== undefined)
    result.winnerJson = patch.winner === null ? null : JSON.stringify(patch.winner);
  if (patch.nightsWithoutElimination !== undefined)
    result.nightsWithoutElimination = patch.nightsWithoutElimination;
  return result;
}
async function applyPlayerPatch(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  gameId: GameId,
  patch: PlayerPatch,
) {
  const changes = patch.changes;
  await tx
    .update(gamePlayers)
    .set({
      status: changes.status,
      displayName: changes.displayName,
      originalRole: changes.originalRole,
      role: changes.role,
      faction: changes.faction,
      wolfSinceEventId: changes.wolfSinceEventId,
      roleStateJson:
        changes.roleState === undefined ? undefined : JSON.stringify(changes.roleState),
      phaseStateJson:
        changes.phaseState === undefined ? undefined : JSON.stringify(changes.phaseState),
    })
    .where(and(eq(gamePlayers.gameId, gameId), eq(gamePlayers.userId, patch.playerId)));
}
