// The viewer-specific projection of a game. The client never receives the full
// authoritative state, only what this snapshot carries, filtered for one
// viewer: no hidden role composition, no other players' roles, no audit data.

import { z } from "zod";
import type { AvailableAction } from "./actions.ts";
import { AvailableActionSchema } from "./actions.ts";
import type {
  ChatChannel,
  FactionId,
  GamePhase,
  GamePlayerStatus,
  GameStatus,
  GameVisibility,
  PresetId,
  RoleId,
} from "./enums.ts";
import {
  ChatChannelSchema,
  FactionIdSchema,
  GamePhaseSchema,
  GamePlayerStatusSchema,
  GameStatusSchema,
  GameVisibilitySchema,
  PresetIdSchema,
  RoleIdSchema,
} from "./enums.ts";
import type { VictoryReason } from "./events.ts";
import { VictoryReasonSchema } from "./events.ts";
import type { EventId, GameId, PhaseId, UserId } from "./ids.ts";
import { EventIdSchema, GameIdSchema, PhaseIdSchema, UserIdSchema } from "./ids.ts";

export interface ViewerGameSettings {
  visibility: GameVisibility;
  /** Whether spectators are allowed after the game starts. */
  spectatingEnabled: boolean;
  /** The composition preset the host picked. Omitted means "classic". */
  preset?: PresetId;
  /** Phase durations in seconds. */
  durations: {
    discussion: number;
    voting: number;
    night: number;
  };
}

export interface ViewerPlayer {
  userId: UserId;
  displayName: string;
  status: GamePlayerStatus;
  /** Present only for dead players, whose current role is public. */
  revealedRole?: RoleId;
  /** Whether the seat is driven by a bot. Which provider and model drive it
   * is server-side detail and deliberately absent. */
  isBot?: boolean;
}

/** The viewer's own pending intent for the current phase, as stored on the
 * server. Aggregates only: the viewer's own vote/action, never anyone else's. */
export interface ViewerIntent {
  vote?: { type: "player"; targetId: UserId } | { type: "abstain" };
  actions?: Record<string, { targetId?: UserId; targetIds?: UserId[] }>;
}

export interface ViewerGameSnapshot {
  game: {
    id: GameId;
    name: string;
    ownerUserId: UserId;
    status: GameStatus;
    day: number;
    /** Present only while the game is waiting for its scheduled start. */
    scheduledAt?: number;
    phase: {
      id: PhaseId;
      type: GamePhase;
      startedAt: number;
      endsAt: number;
    } | null;
    settings: ViewerGameSettings;
    /** Present only once the game is finished. */
    winner?: {
      winningFactions: FactionId[];
      winningPlayers: UserId[];
      reason: VictoryReason;
    };
  };
  players: ViewerPlayer[];
  /** Secret-channel members already known to this viewer. */
  knownChannelMemberIds?: Partial<Record<"wolves" | "cult", UserId[]>>;
  /** Aggregate live tally. Voter identities are deliberately absent. */
  voteTallies?: { targetId: UserId; count: number }[];
  /** The pack's live attack ballot, by identity. Present only for a living
   *  pack member during the night. The village vote stays a bare tally. */
  packBallot?: { playerId: UserId; targetId: UserId }[];
  /** Present only when the viewer is a member of the game. */
  me?: {
    userId: UserId;
    status: GamePlayerStatus;
    role?: RoleId;
    faction?: FactionId;
    roleState?: unknown;
    currentIntent?: ViewerIntent;
    /** The viewer's own readiness for the current phase. Never anyone else's. */
    ready?: boolean;
  };
  availableActions: AvailableAction[];
  availableChannels: ChatChannel[];
  cursor: EventId;
  serverNow: number;
}

export const ViewerPlayerSchema = z.object({
  userId: UserIdSchema,
  displayName: z.string(),
  status: GamePlayerStatusSchema,
  revealedRole: RoleIdSchema.optional(),
  isBot: z.boolean().optional(),
});

export const MentionCandidateSchema = z
  .object({
    userId: UserIdSchema,
    displayName: z.string(),
    status: GamePlayerStatusSchema.optional(),
    isBot: z.boolean().optional(),
  })
  .strict();
export type MentionCandidate = z.infer<typeof MentionCandidateSchema>;

export const ViewerIntentSchema = z.object({
  vote: z
    .discriminatedUnion("type", [
      z.object({ type: z.literal("player"), targetId: UserIdSchema }),
      z.object({ type: z.literal("abstain") }),
    ])
    .optional(),
  actions: z
    .record(
      z.string(),
      z.object({
        targetId: UserIdSchema.optional(),
        targetIds: z.array(UserIdSchema).optional(),
      }),
    )
    .optional(),
});

/** Runtime validation for the viewer-specific projection. */
export const ViewerGameSnapshotSchema = z.object({
  game: z.object({
    id: GameIdSchema,
    name: z.string(),
    ownerUserId: UserIdSchema,
    status: GameStatusSchema,
    day: z.number(),
    scheduledAt: z.number().optional(),
    phase: z
      .object({
        id: PhaseIdSchema,
        type: GamePhaseSchema,
        startedAt: z.number(),
        endsAt: z.number(),
      })
      .nullable(),
    settings: z.object({
      visibility: GameVisibilitySchema,
      spectatingEnabled: z.boolean(),
      preset: PresetIdSchema.optional(),
      durations: z.object({
        discussion: z.number(),
        voting: z.number(),
        night: z.number(),
      }),
    }),
    winner: z
      .object({
        winningFactions: z.array(FactionIdSchema),
        winningPlayers: z.array(UserIdSchema),
        reason: VictoryReasonSchema,
      })
      .optional(),
  }),
  players: z.array(ViewerPlayerSchema),
  knownChannelMemberIds: z
    .object({
      wolves: z.array(UserIdSchema).optional(),
      cult: z.array(UserIdSchema).optional(),
    })
    .strict()
    .optional(),
  voteTallies: z.array(z.object({ targetId: UserIdSchema, count: z.number() })).optional(),
  packBallot: z.array(z.object({ playerId: UserIdSchema, targetId: UserIdSchema })).optional(),
  me: z
    .object({
      userId: UserIdSchema,
      status: GamePlayerStatusSchema,
      role: RoleIdSchema.optional(),
      faction: FactionIdSchema.optional(),
      roleState: z.unknown().optional(),
      currentIntent: ViewerIntentSchema.optional(),
      ready: z.boolean().optional(),
    })
    .optional(),
  availableActions: z.array(AvailableActionSchema),
  availableChannels: z.array(ChatChannelSchema),
  cursor: EventIdSchema,
  serverNow: z.number(),
});
