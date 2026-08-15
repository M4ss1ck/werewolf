// The game-browser list DTO. GET /api/games returns these, never raw DB rows:
// rngSeed, joinCode and the JSON blobs stay server-side.

import { z } from "zod";
import type { GamePhase, GameStatus, GameVisibility } from "./enums.ts";
import { GamePhaseSchema, GameStatusSchema, GameVisibilitySchema } from "./enums.ts";
import type { GameId, UserId } from "./ids.ts";
import { GameIdSchema, UserIdSchema } from "./ids.ts";

export interface PublicGameSummary {
  id: GameId;
  name: string;
  ownerUserId: UserId;
  status: GameStatus;
  visibility: GameVisibility;
  day: number;
  playerCount: number;
  /** Enough to render the avatar stack; no roles, no status. */
  players: { userId: UserId; displayName: string }[];
  /** Present only while waiting for a scheduled start. */
  scheduledAt?: number;
  /** Present only while running. */
  phase?: { type: GamePhase; endsAt: number };
  serverNow: number;
}

/** Runtime validation for a public game summary. */
export const PublicGameSummarySchema = z.object({
  id: GameIdSchema,
  name: z.string(),
  ownerUserId: UserIdSchema,
  status: GameStatusSchema,
  visibility: GameVisibilitySchema,
  day: z.number(),
  playerCount: z.number(),
  players: z.array(z.object({ userId: UserIdSchema, displayName: z.string() })),
  scheduledAt: z.number().optional(),
  phase: z.object({ type: GamePhaseSchema, endsAt: z.number() }).optional(),
  serverNow: z.number(),
});
