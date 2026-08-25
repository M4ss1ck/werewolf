import type { DomainTransition, PlayerPatch } from "@werewolf/game-engine";
import type { EventId, GameCode, GameId, PlayerController, UserId } from "@werewolf/protocol";
import { and, asc, desc, eq, exists, gt, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "./client.ts";
import { generateGameCode } from "./game-code.ts";
import { mapEvent, mapGame } from "./mapper.ts";
import { gameEvents, gamePlayers, games } from "./schema.ts";

export type CreateGameInput = {
  id: GameId;
  ownerUserId: UserId;
  name: string;
  visibility: string;
  status: string;
  settings: unknown;
  balanceVersion: number;
  rngSeed?: string;
  scheduledAt?: number;
  createdAt: number;
  /** The owner row is committed with the game in the same transaction. */
  ownerDisplayName: string;
  ownerController?: PlayerController;
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
  membershipAccess?: "active" | "replay" | "denied";
};
export type MembershipMutation =
  | { kind: "insert"; player: AddPlayerInput }
  | {
      kind: "update";
      userId: UserId;
      changes: {
        membershipAccess?: "active" | "replay" | "denied";
        status?: string;
        role?: string | null;
        faction?: string | null;
      };
    }
  | { kind: "delete"; userId: UserId };
export type MembershipCommitResult =
  | { ok: true; version: number; activeChanged: boolean }
  | { ok: false; stale: true };
export type CommitResult =
  | { ok: true; events: ReturnType<typeof mapEvent>[]; version: number }
  | { ok: false; stale: true };

/** A game row plus its roster, shaped for the coordinator to map into
 * `GameSummary`. Never carries rngSeed, joinCode or the JSON blobs. */
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
  membership?: "player" | "spectator" | "replay";
};

export type UserStats = { games: number; survived: number; asWolf: number };

const gameColumns = {
  id: games.id,
  ownerUserId: games.ownerUserId,
  name: games.name,
  visibility: games.visibility,
  status: games.status,
  scheduledAt: games.scheduledAt,
  startedAt: games.startedAt,
  endedAt: games.endedAt,
  day: games.day,
  phase: games.phase,
  phaseId: games.phaseId,
  phaseStartedAt: games.phaseStartedAt,
  phaseEndsAt: games.phaseEndsAt,
  settingsJson: games.settingsJson,
  balanceVersion: games.balanceVersion,
  nightsWithoutElimination: games.nightsWithoutElimination,
  rngSeed: games.rngSeed,
  winnerJson: games.winnerJson,
  version: games.version,
  createdAt: games.createdAt,
};

export class GameRepository {
  constructor(
    private readonly db: Db,
    private readonly makeGameCode: () => string = generateGameCode,
  ) {}
  async createGame(input: CreateGameInput) {
    for (;;) {
      try {
        await this.db.transaction(async (tx) => {
          await tx.insert(games).values({
            id: input.id,
            ownerUserId: input.ownerUserId,
            name: input.name,
            joinCode: this.makeGameCode(),
            visibility: input.visibility,
            status: input.status,
            scheduledAt: input.scheduledAt,
            settingsJson: JSON.stringify(input.settings),
            balanceVersion: input.balanceVersion,
            rngSeed: input.rngSeed,
            createdAt: input.createdAt,
          });
          await tx.insert(gamePlayers).values({
            gameId: input.id,
            userId: input.ownerUserId,
            displayName: input.ownerDisplayName,
            status: "lobby",
            joinedAt: input.createdAt,
            controllerJson:
              input.ownerController === undefined ? null : JSON.stringify(input.ownerController),
          });
        });
        break;
      } catch (error) {
        if (!isJoinCodeCollision(error)) throw error;
      }
    }
    return this.getGame(input.id);
  }
  async listGameSummaries(
    viewerUserId?: UserId,
    scope: "browse" | "mine" = viewerUserId ? "mine" : "browse",
  ): Promise<GameSummaryRow[]> {
    const visibility =
      scope === "mine"
        ? viewerUserId
          ? exists(
              this.db
                .select({ gameId: gamePlayers.gameId })
                .from(gamePlayers)
                .where(
                  and(
                    eq(gamePlayers.gameId, games.id),
                    eq(gamePlayers.userId, viewerUserId),
                    or(
                      eq(gamePlayers.membershipAccess, "active"),
                      eq(gamePlayers.membershipAccess, "replay"),
                    ),
                  ),
                ),
            )
          : sql`0`
        : eq(games.visibility, "public");
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
      .where(and(visibility, ne(games.status, "cancelled")))
      .orderBy(asc(games.createdAt));
    if (rows.length === 0) return [];
    const memberships = viewerUserId
      ? await this.db
          .select({
            gameId: gamePlayers.gameId,
            status: gamePlayers.status,
            access: gamePlayers.membershipAccess,
          })
          .from(gamePlayers)
          .where(
            and(
              inArray(
                gamePlayers.gameId,
                rows.map((row) => row.id),
              ),
              eq(gamePlayers.userId, viewerUserId),
              or(
                eq(gamePlayers.membershipAccess, "active"),
                eq(gamePlayers.membershipAccess, "replay"),
              ),
            ),
          )
      : [];
    const membershipByGame = new Map(
      memberships.map((membership) => [
        membership.gameId,
        membership.access === "replay"
          ? ("replay" as const)
          : membership.status === "spectator"
            ? ("spectator" as const)
            : ("player" as const),
      ]),
    );
    const players = await this.db
      .select({
        gameId: gamePlayers.gameId,
        userId: gamePlayers.userId,
        displayName: gamePlayers.displayName,
      })
      .from(gamePlayers)
      .where(
        and(
          inArray(
            gamePlayers.gameId,
            rows.map((row) => row.id),
          ),
          eq(gamePlayers.membershipAccess, "active"),
          ne(gamePlayers.status, "spectator"),
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
      ...(membershipByGame.has(row.id) ? { membership: membershipByGame.get(row.id)! } : {}),
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
    return this.db.select(gameColumns).from(games).where(eq(games.status, "scheduled"));
  }
  async listRunningGames() {
    return this.db
      .select(gameColumns)
      .from(games)
      .where(and(eq(games.status, "running"), isNotNull(games.phaseEndsAt)));
  }
  async getGame(gameId: GameId) {
    return (
      (await this.db.select(gameColumns).from(games).where(eq(games.id, gameId)).limit(1))[0] ??
      null
    );
  }
  async getGameIdByJoinCode(code: GameCode): Promise<GameId | null> {
    return (
      ((
        await this.db.select({ id: games.id }).from(games).where(eq(games.joinCode, code)).limit(1)
      )[0]?.id as GameId | undefined) ?? null
    );
  }
  async getJoinCode(gameId: GameId): Promise<GameCode | null> {
    return (
      ((
        await this.db
          .select({ joinCode: games.joinCode })
          .from(games)
          .where(eq(games.id, gameId))
          .limit(1)
      )[0]?.joinCode as GameCode | undefined) ?? null
    );
  }
  async getStatePlayers(gameId: GameId) {
    return this.db
      .select()
      .from(gamePlayers)
      .where(and(eq(gamePlayers.gameId, gameId), eq(gamePlayers.membershipAccess, "active")));
  }
  async getMembership(gameId: GameId, userId: UserId) {
    return (
      (
        await this.db
          .select()
          .from(gamePlayers)
          .where(and(eq(gamePlayers.gameId, gameId), eq(gamePlayers.userId, userId)))
          .limit(1)
      )[0] ?? null
    );
  }
  async loadGameState(gameId: GameId) {
    const game = await this.getGame(gameId);
    return game ? mapGame({ game, players: await this.getStatePlayers(gameId) }) : null;
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
      membershipAccess: input.membershipAccess,
    });
  }
  async removePlayer(gameId: GameId, userId: UserId) {
    await this.db
      .delete(gamePlayers)
      .where(and(eq(gamePlayers.gameId, gameId), eq(gamePlayers.userId, userId)));
  }
  /**
   * Atomically fence a membership mutation with the game's version. Admission,
   * leave and kick all use this seam; callers must hold the game's in-process
   * lock and treat a stale result as a conflict rather than retrying.
   */
  async commitMembership(
    gameId: GameId,
    expectedVersion: number,
    mutation: MembershipMutation,
  ): Promise<MembershipCommitResult> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select({ membershipAccess: gamePlayers.membershipAccess })
        .from(gamePlayers)
        .where(
          and(
            eq(gamePlayers.gameId, gameId),
            eq(
              gamePlayers.userId,
              mutation.kind === "insert" ? mutation.player.userId : mutation.userId,
            ),
          ),
        )
        .limit(1);
      const updated = await tx
        .update(games)
        .set({ version: expectedVersion + 1 })
        .where(and(eq(games.id, gameId), eq(games.version, expectedVersion)))
        .returning({ version: games.version });
      if (updated.length === 0) return { ok: false, stale: true };

      if (mutation.kind === "insert") {
        const player = mutation.player;
        await tx.insert(gamePlayers).values({
          gameId: player.gameId,
          userId: player.userId,
          displayName: player.displayName,
          status: player.status ?? "lobby",
          joinedAt: player.joinedAt,
          originalRole: player.originalRole,
          role: player.role,
          faction: player.faction,
          controllerJson: player.controller ? JSON.stringify(player.controller) : null,
          membershipAccess: player.membershipAccess,
        });
      } else if (mutation.kind === "update") {
        await tx
          .update(gamePlayers)
          .set(mutation.changes)
          .where(and(eq(gamePlayers.gameId, gameId), eq(gamePlayers.userId, mutation.userId)));
      } else {
        await tx
          .delete(gamePlayers)
          .where(and(eq(gamePlayers.gameId, gameId), eq(gamePlayers.userId, mutation.userId)));
      }

      const beforeActive = current?.membershipAccess === "active";
      const afterActive =
        mutation.kind === "insert"
          ? (mutation.player.membershipAccess ?? "active") === "active"
          : mutation.kind === "update"
            ? (mutation.changes.membershipAccess ?? current?.membershipAccess) === "active"
            : false;
      return {
        ok: true,
        version: updated[0]!.version,
        activeChanged: beforeActive !== afterActive,
      };
    });
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
        // A faction-join event entitles the joined player to that channel from
        // this event onward. The marker is merged into channel_since_json so
        // one channel's marker can never erase another's. The read-merge-write
        // keeps a player who joins two channels entitled to both.
        if ((draft.kind === "wolves.member_joined" || draft.kind === "cult.member_joined") && row) {
          const playerId = (draft.payload as { playerId: UserId }).playerId;
          const channel = draft.kind === "wolves.member_joined" ? "wolves" : "cult";
          const existing = await tx
            .select({ channelSinceJson: gamePlayers.channelSinceJson })
            .from(gamePlayers)
            .where(and(eq(gamePlayers.gameId, gameId), eq(gamePlayers.userId, playerId)))
            .limit(1);
          const channelSince = existing[0]
            ? (JSON.parse(existing[0].channelSinceJson) as Record<string, EventId>)
            : {};
          await tx
            .update(gamePlayers)
            .set({ channelSinceJson: JSON.stringify({ ...channelSince, [channel]: row.id }) })
            .where(and(eq(gamePlayers.gameId, gameId), eq(gamePlayers.userId, playerId)));
        }
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
      channelSinceJson:
        changes.channelSince === undefined ? undefined : JSON.stringify(changes.channelSince),
      roleStateJson:
        changes.roleState === undefined ? undefined : JSON.stringify(changes.roleState),
      phaseStateJson:
        changes.phaseState === undefined ? undefined : JSON.stringify(changes.phaseState),
    })
    .where(and(eq(gamePlayers.gameId, gameId), eq(gamePlayers.userId, patch.playerId)));
}

function isJoinCodeCollision(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; message?: unknown; cause?: unknown };
  if (
    candidate.code === "SQLITE_CONSTRAINT_UNIQUE" &&
    typeof candidate.message === "string" &&
    candidate.message.includes("UNIQUE constraint failed: games.join_code")
  )
    return true;
  return candidate.cause !== undefined && isJoinCodeCollision(candidate.cause);
}
