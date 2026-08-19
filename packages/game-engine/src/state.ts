import type {
  ChatChannel,
  ErrorCode,
  EventId,
  EventKind,
  EventPayloads,
  FactionId,
  GameId,
  GamePhase,
  GameStatus,
  PhaseId,
  PlayerController,
  RoleId,
  UserId,
  VictoryReason,
} from "@werewolf/protocol";

export interface GameSettings {
  discussionDurationMs: number;
  votingDurationMs: number;
  nightDurationMs: number;
  visibility?: "public" | "private";
  spectatingEnabled?: boolean;
}

export type StoredVote = { type: "player"; targetId: UserId } | { type: "abstain" };
export interface StoredPhaseState {
  phaseId: PhaseId;
  vote?: StoredVote;
  actions?: Record<string, { targetId?: UserId; targetIds?: UserId[] }>;
  ready?: boolean;
}

export interface PlayerState {
  id: UserId;
  displayName?: string;
  status: "lobby" | "alive" | "dead" | "spectator";
  originalRole: RoleId | null;
  role: RoleId | null;
  faction: FactionId | null;
  roleState: unknown;
  phaseState: StoredPhaseState;
  /** Per-channel entitlement marker: the id of the event from which this
   * player may read that channel. Absent means "no entitlement yet". A
   * player converted into a channel must not read what was said before they
   * arrived. */
  channelSince?: Partial<Record<ChatChannel, EventId>>;
  /** Absent on a human seat. A bot seat carries the config its controller
   * decides with; the engine itself never reads it. */
  controller?: PlayerController;
}

export interface VictoryResult {
  winningFactions: FactionId[];
  winningPlayers: UserId[];
  reason: VictoryReason;
}

export interface GameState {
  id: GameId;
  name?: string;
  ownerUserId: UserId;
  status: GameStatus;
  scheduledAt?: number | null;
  day: number;
  phase: { id: PhaseId; type: GamePhase; startedAt: number; endsAt: number } | null;
  players: Record<UserId, PlayerState>;
  settings: GameSettings;
  balanceVersion: number;
  /** Consecutive night resolutions that produced no elimination. Reset to 0 by
   * any elimination from any cause. */
  nightsWithoutElimination: number;
  winner: VictoryResult | null;
  version: number;
}

export type GamePatch = Partial<
  Pick<
    GameState,
    "status" | "scheduledAt" | "day" | "phase" | "winner" | "version" | "nightsWithoutElimination"
  >
>;
export type PlayerPatch = { playerId: UserId; changes: Partial<PlayerState> };
export type EventDraft<K extends EventKind = EventKind> = {
  kind: K;
  scope: "public" | "player" | "faction" | "server";
  scopeId?: string;
  actorUserId?: UserId;
  payload: EventPayloads[K];
};
// Ephemeral state is pushed to clients but never persisted, so its kinds live
// outside the persisted event vocabulary: "phase.progress" is not an EventKind.
export interface EphemeralEvent {
  kind: string;
  scope: "public" | "player" | "faction";
  scopeId?: string;
  payload: unknown;
}
export interface DomainTransition {
  gamePatch?: GamePatch;
  playerPatches: PlayerPatch[];
  events: EventDraft[];
  ephemeral: EphemeralEvent[];
}

export interface DomainError {
  code: ErrorCode;
}
export type DomainResult =
  | { ok: true; transition: DomainTransition }
  | { ok: false; error: DomainError };

export function emptyTransition(): DomainTransition {
  return { playerPatches: [], events: [], ephemeral: [] };
}
