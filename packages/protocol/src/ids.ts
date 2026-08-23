// Branded identifier types. On the wire these are plain JSON values — strings
// for entity ids, integers for phase and event ids. The brand only keeps the
// TypeScript types from being mixed up; the schemas validate ids wherever a
// command or frame crosses the wire.

import { z } from "zod";

export const GameIdSchema = z.string().min(1).brand("GameId");
export type GameId = z.infer<typeof GameIdSchema>;

export const UserIdSchema = z.string().min(1).brand("UserId");
export type UserId = z.infer<typeof UserIdSchema>;

/** `phase_id INTEGER` on the games row; counts up per game. */
export const PhaseIdSchema = z.number().int().nonnegative().brand("PhaseId");
export type PhaseId = z.infer<typeof PhaseIdSchema>;

/** The engine numbers phases sequentially and bumps the day after each night,
 * so a phase id maps to a day: ids 1-3 are day 1, 4-6 day 2, and so on. */
export function dayOfPhase(phaseId: PhaseId): number {
  return Math.floor((Number(phaseId) - 1) / 3) + 1;
}

/** The event cursor: `id INTEGER PRIMARY KEY` on the game_events row. */
export const EventIdSchema = z.number().int().nonnegative().brand("EventId");
export type EventId = z.infer<typeof EventIdSchema>;
