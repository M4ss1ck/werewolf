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

export interface ViewerGameSnapshot {
  game: {
    id: GameId;
    name: string;
    status: GameStatus;
    day: number;
    phase: {
      id: PhaseId;
      type: GamePhase;
      startedAt: number;
      endsAt: number;
    } | null;
    settings: ViewerGameSettings;
  };
  players: ViewerPlayer[];
  /** Present only when the viewer is a member of the game. */
  me?: {
    userId: UserId;
    status: GamePlayerStatus;
    role?: RoleId;
    faction?: FactionId;
    roleState?: unknown;
    currentIntent?: unknown;
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

/** Runtime validation for the viewer-specific projection. */
export const ViewerGameSnapshotSchema = z.object({
  game: z.object({
    id: GameIdSchema,
    name: z.string(),
    status: GameStatusSchema,
    day: z.number(),
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
  }),
  players: z.array(ViewerPlayerSchema),
  me: z
    .object({
      userId: UserIdSchema,
      status: GamePlayerStatusSchema,
      role: RoleIdSchema.optional(),
      faction: FactionIdSchema.optional(),
      roleState: z.unknown().optional(),
      currentIntent: z.unknown().optional(),
    })
    .optional(),
  availableActions: z.array(AvailableActionSchema),
  availableChannels: z.array(ChatChannelSchema),
  progress: z.object({ acted: z.number(), eligible: z.number() }).optional(),
  cursor: EventIdSchema,
  serverNow: z.number(),
});
