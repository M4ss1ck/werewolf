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
  RoleId,
} from "./enums.ts";
import {
  ChatChannelSchema,
  FactionIdSchema,
  GamePhaseSchema,
  GamePlayerStatusSchema,
  GameStatusSchema,
  GameVisibilitySchema,
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
}

/** The viewer's own pending intent for the current phase, as stored on the
 * server. Aggregates only: the viewer's own vote/action, never anyone else's. */
export interface ViewerIntent {
  vote?: { type: "player"; targetId: UserId } | { type: "abstain" };
  actions?: Record<string, { targetId?: UserId }>;
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
  /** Aggregate live tally. Voter identities are deliberately absent. */
  voteTallies?: { targetId: UserId; count: number }[];
  /** Present only when the viewer is a member of the game. */
  me?: {
    userId: UserId;
    status: GamePlayerStatus;
    role?: RoleId;
    faction?: FactionId;
    roleState?: unknown;
    currentIntent?: ViewerIntent;
  };
  availableActions: AvailableAction[];
  availableChannels: ChatChannel[];
  progress?: {
    acted: number;
    eligible: number;
  };
  cursor: EventId;
  serverNow: number;
}

export const ViewerPlayerSchema = z.object({
  userId: UserIdSchema,
  displayName: z.string(),
  status: GamePlayerStatusSchema,
  revealedRole: RoleIdSchema.optional(),
});

export const ViewerIntentSchema = z.object({
  vote: z
    .discriminatedUnion("type", [
      z.object({ type: z.literal("player"), targetId: UserIdSchema }),
      z.object({ type: z.literal("abstain") }),
    ])
    .optional(),
  actions: z.record(z.string(), z.object({ targetId: UserIdSchema.optional() })).optional(),
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
  voteTallies: z.array(z.object({ targetId: UserIdSchema, count: z.number() })).optional(),
  me: z
    .object({
      userId: UserIdSchema,
      status: GamePlayerStatusSchema,
      role: RoleIdSchema.optional(),
      faction: FactionIdSchema.optional(),
      roleState: z.unknown().optional(),
      currentIntent: ViewerIntentSchema.optional(),
    })
    .optional(),
  availableActions: z.array(AvailableActionSchema),
  availableChannels: z.array(ChatChannelSchema),
  progress: z.object({ acted: z.number(), eligible: z.number() }).optional(),
  cursor: EventIdSchema,
  serverNow: z.number(),
});
