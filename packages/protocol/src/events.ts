// Semantic events: the server stores and sends what happened, never prose.
// Event kinds are stable wire values and each kind has exactly one payload
// shape. `chat.message` appears in both the public and the wolves-faction
// scope; the `scope` field on the event distinguishes the two.

import type { ChatChannel, EventScope, FactionId, GamePhase, RoleId } from "./enums.ts";
import type { EventId, PhaseId, UserId } from "./ids.ts";

export const EVENT_KINDS = [
  // Public
  "game.started",
  "phase.started",
  "vote.resolved",
  "player.eliminated",
  "princess.revealed",
  "night.resolved",
  "game.finished",
  "chat.message",
  // Player-private
  "role.assigned",
  "seer.result",
  "cursed.converted",
  "harlot.result",
  // Wolf faction
  "wolves.member_joined",
  "masons.member_joined",
  // Scheduled game
  "game.start_deferred",
  // Server-only
  "audit.vote",
  "audit.night",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** Public elimination cause. Night deaths share one value so a spectator
 * cannot tell an ordinary attack from a Hunter retaliation or a Harlot
 * exposure; the precise cause lives in the server-scope audit.night event. */
export type EliminationCause = "day_vote" | "night";

/** Precise per-death cause, recorded only in the server-scope audit.night. */
export type NightDeathCause = "wolf_attack" | "hunter_retaliation" | "harlot_exposure";

export type VictoryReason = "wolves_eliminated" | "wolves_outnumber";

export type VoteChoice =
  | { type: "player"; targetId: UserId }
  | { type: "abstain" }
  | { type: "none" };

/** Payload shape for each event kind. */
export interface EventPayloads {
  // Public
  "game.started": Record<string, never>;
  "phase.started": {
    phaseId: PhaseId;
    type: GamePhase;
    startedAt: number;
    endsAt: number;
  };
  "vote.resolved": {
    phaseId: PhaseId;
    /** Unique plurality winner, or null on a tie or abstain majority. */
    eliminated: UserId | null;
    tallies: { targetId: UserId; count: number }[];
    abstain: number;
    noVote: number;
  };
  "player.eliminated": {
    playerId: UserId;
    role: RoleId;
    cause: EliminationCause;
  };
  "princess.revealed": { playerId: UserId };
  "night.resolved": { deaths: UserId[] };
  "game.finished": {
    winningFactions: FactionId[];
    winningPlayers: UserId[];
    reason: VictoryReason;
  };
  "chat.message": { channel: ChatChannel; text: string };
  // Player-private
  "role.assigned": { role: RoleId; faction: FactionId };
  "seer.result": { targetId: UserId; role: RoleId };
  "cursed.converted": { role: RoleId; faction: FactionId };
  "harlot.result": { outcome: "safe" | "killed" };
  // Wolf faction
  "wolves.member_joined": { playerId: UserId };
  "masons.member_joined": { playerId: UserId };
  "game.start_deferred": { joinedPlayers: number; minimumPlayers: number };
  // Server-only
  "audit.vote": {
    phaseId: PhaseId;
    votes: { playerId: UserId; choice: VoteChoice }[];
  };
  "audit.night": {
    phaseId: PhaseId;
    wolfVotes: { playerId: UserId; targetId: UserId | null }[];
    wolfTarget: UserId | null;
    seerInspection: { targetId: UserId; role: RoleId } | null;
    harlotAction: { type: "stay" } | { type: "visit"; targetId: UserId } | null;
    deaths: { playerId: UserId; cause: NightDeathCause }[];
    conversions: UserId[];
  };
}

export interface GameEventBase {
  id: EventId;
  kind: EventKind;
  scope: EventScope;
  /** The userId for scope "player", "wolves" for scope "faction". */
  scopeId?: string;
  /** The user who caused the event, when there is one. */
  actorUserId?: UserId;
  createdAt: number;
}

/** One persisted semantic event, discriminated on `kind`. */
export type GameEvent = {
  [K in EventKind]: GameEventBase & { kind: K; payload: EventPayloads[K] };
}[EventKind];
