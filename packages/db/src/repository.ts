import type { DomainTransition, PlayerPatch } from "@werewolf/game-engine";
import type { EventId, GameId, UserId } from "@werewolf/protocol";
import { and, asc, eq, gt } from "drizzle-orm";
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
};
export type CommitResult =
  | { ok: true; events: ReturnType<typeof mapEvent>[]; version: number }
  | { ok: false; stale: true };

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
      settingsJson: JSON.stringify(input.settings),
      balanceVersion: input.balanceVersion,
      rngSeed: input.rngSeed,
      createdAt: input.createdAt,
    });
    return this.getGame(input.id);
  }
  async listPublicGames() {
    return this.db
      .select()
      .from(games)
      .where(eq(games.visibility, "public"))
      .orderBy(asc(games.createdAt));
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
        await tx
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
          .onConflictDoNothing();
        const row =
          commandId === undefined
            ? (
                await tx
                  .select()
                  .from(gameEvents)
                  .where(
                    and(
                      eq(gameEvents.gameId, gameId),
                      eq(gameEvents.kind, draft.kind),
                      eq(gameEvents.createdAt, createdAt),
                    ),
                  )
                  .orderBy(asc(gameEvents.id))
                  .limit(1)
              )[0]
            : (
                await tx
                  .select()
                  .from(gameEvents)
                  .where(and(eq(gameEvents.gameId, gameId), eq(gameEvents.commandId, commandId)))
                  .limit(1)
              )[0];
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
