// Machine-readable error codes. The server never sends localized prose; the
// client maps these codes to the user's language.

import { z } from "zod";

export const ERROR_CODES = [
  "GAME_NOT_FOUND",
  "GAME_ALREADY_STARTED",
  "GAME_NOT_STARTED",
  "GAME_CANCELLED",
  "NOT_A_MEMBER",
  "NOT_GAME_OWNER",
  "NOT_ALIVE",
  "PHASE_MISMATCH",
  "PHASE_CLOSED",
  "ACTION_NOT_AVAILABLE",
  "INVALID_TARGET",
  "CHAT_READ_ONLY",
  "CHANNEL_NOT_AVAILABLE",
  "MIN_PLAYERS_NOT_REACHED",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export const ErrorCodeSchema = z.enum(ERROR_CODES);
