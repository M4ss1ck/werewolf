import type { GameState, PlayerState, StoredPhaseState } from "@werewolf/game-engine";
import type {
  EventId,
  FactionId,
  GameEvent,
  GameId,
  PlayerController,
  RoleId,
  UserId,
} from "@werewolf/protocol";
import type { EventRow, GameRow, PlayerRow } from "./schema.ts";

function json<T>(value: string): T {
  return JSON.parse(value) as T;
}

export function mapPlayer(row: PlayerRow): PlayerState {
  const result = {
    id: row.userId as UserId,
    displayName: row.displayName,
    status: row.status as "lobby" | "alive" | "dead" | "spectator",
    originalRole: row.originalRole as RoleId | null,
    role: row.role as RoleId | null,
    faction: row.faction as FactionId | null,
    roleState: json(row.roleStateJson),
    phaseState: json<StoredPhaseState>(row.phaseStateJson),
  } as PlayerState;
  const channelSince = json<PlayerState["channelSince"]>(row.channelSinceJson);
  if (channelSince && Object.keys(channelSince).length > 0) result.channelSince = channelSince;
  if (row.controllerJson !== null) result.controller = json<PlayerController>(row.controllerJson);
  return result;
}

export function mapGame(rows: { game: GameRow; players: PlayerRow[] }): GameState {
  const { game } = rows;
  const phase =
    game.phase === null
      ? null
      : {
          id: game.phaseId as never,
          type: game.phase as never,
          startedAt: game.phaseStartedAt ?? 0,
          endsAt: game.phaseEndsAt ?? 0,
        };
  return {
    id: game.id as GameId,
    name: game.name,
    ownerUserId: game.ownerUserId as UserId,
    status: game.status as GameState["status"],
    scheduledAt: game.scheduledAt,
    day: game.day,
    phase,
    players: Object.fromEntries(rows.players.map((player) => [player.userId, mapPlayer(player)])),
    settings: json(game.settingsJson),
    balanceVersion: game.balanceVersion,
    nightsWithoutElimination: game.nightsWithoutElimination,
    winner: game.winnerJson === null ? null : json(game.winnerJson),
    version: game.version,
  };
}

export function mapEvent(row: EventRow): GameEvent {
  const result = {
    id: row.id as EventId,
    kind: row.kind,
    scope: row.scope,
    createdAt: row.createdAt,
    payload: json(row.payloadJson),
  } as GameEvent & { scopeId?: string; actorUserId?: UserId };
  if (row.scopeId !== null) result.scopeId = row.scopeId;
  if (row.actorUserId !== null) result.actorUserId = row.actorUserId as UserId;
  return result;
}
