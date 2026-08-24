// Semantic events: the server stores and sends what happened, never prose.
// Event kinds are stable wire values and each kind has exactly one payload
// shape. `chat.message` appears in both the public and the wolves-faction
// scope; the `scope` field on the event distinguishes the two.

import { z } from "zod";
import type { ChatContent } from "./chat.ts";
import { ChatContentSchema } from "./chat.ts";
import type {
  ChatChannel,
  ConversionCause,
  EventScope,
  FactionId,
  GamePhase,
  RoleId,
} from "./enums.ts";

import {
  ChatChannelSchema,
  ConversionCauseSchema,
  EventScopeSchema,
  FactionIdSchema,
  GamePhaseSchema,
  RoleIdSchema,
} from "./enums.ts";
import type { EventId, PhaseId, UserId } from "./ids.ts";
import { EventIdSchema, PhaseIdSchema, UserIdSchema } from "./ids.ts";

export const EVENT_KINDS = [
  // Public
  "game.started",
  "phase.started",
  "vote.resolved",
  "player.eliminated",
  "players.finished_off",
  "princess.revealed",
  "mayor.revealed",
  "night.resolved",
  "game.finished",
  "chat.message",
  // Player-private
  "role.assigned",
  "seer.result",
  "sorcerer.result",
  "player.converted",
  "harlot.result",
  "player.linked",
  "detective.result",
  "lone_wolf.result",
  // Wolf faction
  "wolves.member_joined",
  "masons.member_joined",
  // Cult faction
  "cult.member_joined",
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
export type NightDeathCause =
  | "wolf_attack"
  | "hunter_retaliation"
  | "harlot_exposure"
  | "serial_killer_attack"
  | "lover_link"
  | "guardian_substitution"
  | "lone_wolf_clash";

export type VictoryReason =
  | "wolves_eliminated"
  | "village_eliminated"
  | "veteran_lynched"
  | "serial_killer_survives"
  | "cult_survives"
  | "stalemate"
  | "no_survivors";

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
  "players.finished_off": { playerIds: UserId[]; winningFaction: FactionId };
  "princess.revealed": { playerId: UserId };
  "mayor.revealed": { playerId: UserId; targetId: UserId | null };
  "night.resolved": { deaths: UserId[] };
  "game.finished": {
    winningFactions: FactionId[];
    winningPlayers: UserId[];
    reason: VictoryReason;
  };
  "chat.message": { channel: ChatChannel } & ChatContent;
  // Player-private
  "role.assigned": { role: RoleId; faction: FactionId };
  "seer.result": { targetId: UserId; role: RoleId };
  "sorcerer.result": { targetId: UserId; isWolf: boolean };
  "player.converted": { role: RoleId; faction: FactionId; cause: ConversionCause };
  "harlot.result": { outcome: "safe" | "killed" };
  "player.linked": { partnerId: UserId };
  /** The Detective's investigation. `role: null` means inconclusive — the
   * investigation failed, it is never a wrong role. */
  "detective.result": { targetId: UserId; role: RoleId | null };
  /** The Lone Wolf's nightly hunt for the Alpha. `found: true` means they
   * clashed with the Alpha that night; `false` means the Alpha was not there. */
  "lone_wolf.result": { targetId: UserId; found: boolean };
  // Wolf faction
  "wolves.member_joined": { playerId: UserId };
  "masons.member_joined": { playerId: UserId };
  // Cult faction
  "cult.member_joined": { playerId: UserId };
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
    serialKillerAction: { type: "stay" } | { type: "visit"; targetId: UserId } | null;
    deaths: { playerId: UserId; cause: NightDeathCause }[];
    conversions: UserId[];
  };
}

export interface GameEventBase {
  id: EventId;
  kind: EventKind;
  scope: EventScope;
  /** The userId for scope "player"; for scope "faction" the CHANNEL id (e.g.
   * "wolves" or "grave"), not necessarily a faction. */
  scopeId?: string;
  /** The user who caused the event, when there is one. */
  actorUserId?: UserId;
  createdAt: number;
}

/** One persisted semantic event, discriminated on `kind`. */
export type GameEvent = {
  [K in EventKind]: GameEventBase & { kind: K; payload: EventPayloads[K] };
}[EventKind];

export const VoteChoiceSchema: z.ZodType<VoteChoice> = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("player"),
    targetId: UserIdSchema,
  }),
  z.object({
    type: z.literal("abstain"),
  }),
  z.object({
    type: z.literal("none"),
  }),
]);

export const EliminationCauseSchema = z.enum(["day_vote", "night"]);
export const NightDeathCauseSchema = z.enum([
  "wolf_attack",
  "hunter_retaliation",
  "harlot_exposure",
  "serial_killer_attack",
  "lover_link",
  "guardian_substitution",
  "lone_wolf_clash",
]);
export const VictoryReasonSchema = z.enum([
  "wolves_eliminated",
  "village_eliminated",
  "veteran_lynched",
  "serial_killer_survives",
  "cult_survives",
  "stalemate",
  "no_survivors",
]);

/** Runtime validation for a GameEvent; mirrors the type above branch for branch. */
export const GameEventSchema = z.discriminatedUnion("kind", [
  z.object({
    id: EventIdSchema,
    kind: z.literal("game.started"),
    scope: EventScopeSchema,
    scopeId: z.string().optional(),
    actorUserId: UserIdSchema.optional(),
    createdAt: z.number(),
    payload: z.object({}),
  }),
  z.object({
    id: EventIdSchema,
    kind: z.literal("phase.started"),
    scope: EventScopeSchema,
    scopeId: z.string().optional(),
    actorUserId: UserIdSchema.optional(),
    createdAt: z.number(),
    payload: z.object({
      phaseId: PhaseIdSchema,
      type: GamePhaseSchema,
      startedAt: z.number(),
      endsAt: z.number(),
    }),
  }),
  z.object({
    id: EventIdSchema,
    kind: z.literal("vote.resolved"),
    scope: EventScopeSchema,
    scopeId: z.string().optional(),
    actorUserId: UserIdSchema.optional(),
    createdAt: z.number(),
    payload: z.object({
      phaseId: PhaseIdSchema,
      eliminated: UserIdSchema.nullable(),
      tallies: z.array(z.object({ targetId: UserIdSchema, count: z.number() })),
      abstain: z.number(),
      noVote: z.number(),
    }),
  }),
  z.object({
    id: EventIdSchema,
    kind: z.literal("player.eliminated"),
    scope: EventScopeSchema,
    scopeId: z.string().optional(),
    actorUserId: UserIdSchema.optional(),
    createdAt: z.number(),
    payload: z.object({
      playerId: UserIdSchema,
      role: RoleIdSchema,
      cause: EliminationCauseSchema,
    }),
  }),
  z.object({
    id: EventIdSchema,
    kind: z.literal("players.finished_off"),
    scope: EventScopeSchema,
    scopeId: z.string().optional(),
    actorUserId: UserIdSchema.optional(),
    createdAt: z.number(),
    payload: z.object({
      playerIds: z.array(UserIdSchema),
      winningFaction: FactionIdSchema,
    }),
  }),
  z.object({
    id: EventIdSchema,
    kind: z.literal("princess.revealed"),
    scope: EventScopeSchema,
    scopeId: z.string().optional(),
    actorUserId: UserIdSchema.optional(),
    createdAt: z.number(),
    payload: z.object({ playerId: UserIdSchema }),
  }),
  z.object({
    id: EventIdSchema,
    kind: z.literal("mayor.revealed"),
    scope: EventScopeSchema,
    scopeId: z.string().optional(),
    actorUserId: UserIdSchema.optional(),
    createdAt: z.number(),
    payload: z.object({ playerId: UserIdSchema, targetId: UserIdSchema.nullable() }),
  }),
  z.object({
    id: EventIdSchema,
    kind: z.literal("night.resolved"),
    scope: EventScopeSchema,
    scopeId: z.string().optional(),
    actorUserId: UserIdSchema.optional(),
    createdAt: z.number(),
    payload: z.object({ deaths: z.array(UserIdSchema) }),
  }),
  z.object({
    id: EventIdSchema,
    kind: z.literal("game.finished"),
    scope: EventScopeSchema,
    scopeId: z.string().optional(),
    actorUserId: UserIdSchema.optional(),
    createdAt: z.number(),
    payload: z.object({
      winningFactions: z.array(FactionIdSchema),
      winningPlayers: z.array(UserIdSchema),
      reason: VictoryReasonSchema,
    }),
  }),
  z.object({
    id: EventIdSchema,
    kind: z.literal("chat.message"),
    scope: EventScopeSchema,
    scopeId: z.string().optional(),
    actorUserId: UserIdSchema.optional(),
    createdAt: z.number(),
    payload: z.object({ channel: ChatChannelSchema }).and(ChatContentSchema),
  }),
  z.object({
    id: EventIdSchema,
    kind: z.literal("role.assigned"),
    scope: EventScopeSchema,
    scopeId: z.string().optional(),
    actorUserId: UserIdSchema.optional(),
    createdAt: z.number(),
    payload: z.object({ role: RoleIdSchema, faction: FactionIdSchema }),
  }),
  z.object({
    id: EventIdSchema,
    kind: z.literal("seer.result"),
    scope: EventScopeSchema,
    scopeId: z.string().optional(),
    actorUserId: UserIdSchema.optional(),
    createdAt: z.number(),
    payload: z.object({ targetId: UserIdSchema, role: RoleIdSchema }),
  }),
  z.object({
    id: EventIdSchema,
    kind: z.literal("sorcerer.result"),
    scope: EventScopeSchema,
    scopeId: z.string().optional(),
    actorUserId: UserIdSchema.optional(),
    createdAt: z.number(),
    payload: z.object({ targetId: UserIdSchema, isWolf: z.boolean() }),
  }),
  z.object({
    id: EventIdSchema,
    kind: z.literal("player.converted"),
    scope: EventScopeSchema,
    scopeId: z.string().optional(),
    actorUserId: UserIdSchema.optional(),
    createdAt: z.number(),
    payload: z.object({
      role: RoleIdSchema,
      faction: FactionIdSchema,
      cause: ConversionCauseSchema,
    }),
  }),
  z.object({
    id: EventIdSchema,
    kind: z.literal("harlot.result"),
    scope: EventScopeSchema,
    scopeId: z.string().optional(),
    actorUserId: UserIdSchema.optional(),
    createdAt: z.number(),
    payload: z.object({ outcome: z.enum(["safe", "killed"]) }),
  }),
  z.object({
    id: EventIdSchema,
    kind: z.literal("player.linked"),
    scope: EventScopeSchema,
    scopeId: z.string().optional(),
    actorUserId: UserIdSchema.optional(),
    createdAt: z.number(),
    payload: z.object({ partnerId: UserIdSchema }),
  }),
  z.object({
    id: EventIdSchema,
    kind: z.literal("detective.result"),
    scope: EventScopeSchema,
    scopeId: z.string().optional(),
    actorUserId: UserIdSchema.optional(),
    createdAt: z.number(),
    payload: z.object({ targetId: UserIdSchema, role: RoleIdSchema.nullable() }),
  }),
  z.object({
    id: EventIdSchema,
    kind: z.literal("lone_wolf.result"),
    scope: EventScopeSchema,
    scopeId: z.string().optional(),
    actorUserId: UserIdSchema.optional(),
    createdAt: z.number(),
    payload: z.object({ targetId: UserIdSchema, found: z.boolean() }),
  }),
  z.object({
    id: EventIdSchema,
    kind: z.literal("wolves.member_joined"),
    scope: EventScopeSchema,
    scopeId: z.string().optional(),
    actorUserId: UserIdSchema.optional(),
    createdAt: z.number(),
    payload: z.object({ playerId: UserIdSchema }),
  }),
  z.object({
    id: EventIdSchema,
    kind: z.literal("masons.member_joined"),
    scope: EventScopeSchema,
    scopeId: z.string().optional(),
    actorUserId: UserIdSchema.optional(),
    createdAt: z.number(),
    payload: z.object({ playerId: UserIdSchema }),
  }),
  z.object({
    id: EventIdSchema,
    kind: z.literal("cult.member_joined"),
    scope: EventScopeSchema,
    scopeId: z.string().optional(),
    actorUserId: UserIdSchema.optional(),
    createdAt: z.number(),
    payload: z.object({ playerId: UserIdSchema }),
  }),
  z.object({
    id: EventIdSchema,
    kind: z.literal("game.start_deferred"),
    scope: EventScopeSchema,
    scopeId: z.string().optional(),
    actorUserId: UserIdSchema.optional(),
    createdAt: z.number(),
    payload: z.object({ joinedPlayers: z.number(), minimumPlayers: z.number() }),
  }),
  z.object({
    id: EventIdSchema,
    kind: z.literal("audit.vote"),
    scope: EventScopeSchema,
    scopeId: z.string().optional(),
    actorUserId: UserIdSchema.optional(),
    createdAt: z.number(),
    payload: z.object({
      phaseId: PhaseIdSchema,
      votes: z.array(
        z.object({
          playerId: UserIdSchema,
          choice: VoteChoiceSchema,
        }),
      ),
    }),
  }),
  z.object({
    id: EventIdSchema,
    kind: z.literal("audit.night"),
    scope: EventScopeSchema,
    scopeId: z.string().optional(),
    actorUserId: UserIdSchema.optional(),
    createdAt: z.number(),
    payload: z.object({
      phaseId: PhaseIdSchema,
      wolfVotes: z.array(z.object({ playerId: UserIdSchema, targetId: UserIdSchema.nullable() })),
      wolfTarget: UserIdSchema.nullable(),
      seerInspection: z.object({ targetId: UserIdSchema, role: RoleIdSchema }).nullable(),
      harlotAction: z
        .discriminatedUnion("type", [
          z.object({ type: z.literal("stay") }),
          z.object({ type: z.literal("visit"), targetId: UserIdSchema }),
        ])
        .nullable(),
      serialKillerAction: z
        .discriminatedUnion("type", [
          z.object({ type: z.literal("stay") }),
          z.object({ type: z.literal("visit"), targetId: UserIdSchema }),
        ])
        .nullable(),
      deaths: z.array(z.object({ playerId: UserIdSchema, cause: NightDeathCauseSchema })),
      conversions: z.array(UserIdSchema),
    }),
  }),
]);
