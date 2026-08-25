import { z } from "zod";
import { GameStatusSchema } from "./enums.ts";
import { GameIdSchema } from "./ids.ts";

/** Crockford Base32 without characters that are easy to confuse when shared aloud. */
export const GAME_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const GAME_CODE_PATTERN = new RegExp(`^[${GAME_CODE_ALPHABET}]{10}$`);

/** The canonical wire representation: ten uppercase, unseparated characters. */
export const GameCodeSchema = z.string().length(10).regex(GAME_CODE_PATTERN).brand("GameCode");
export type GameCode = z.infer<typeof GameCodeSchema>;

/** Normalize user-entered codes into the canonical representation. */
export function normalizeGameCode(input: string): GameCode | undefined {
  if (typeof input !== "string") return undefined;
  const normalized = input.replace(/[- ]/g, "").toUpperCase();
  const result = GameCodeSchema.safeParse(normalized);
  return result.success ? result.data : undefined;
}

export const GameEntryReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("invitation"), code: GameCodeSchema }).strict(),
  z.object({ kind: z.literal("public-game"), gameId: GameIdSchema }).strict(),
]);
export type GameEntryReference = z.infer<typeof GameEntryReferenceSchema>;

export const GAME_ENTRY_MODES = ["player", "spectator", "replay"] as const;
export const GameEntryModeSchema = z.enum(GAME_ENTRY_MODES);
export type GameEntryMode = z.infer<typeof GameEntryModeSchema>;

export const GAME_ENTRY_UNAVAILABLE_REASONS = [
  "cancelled",
  "started",
  "spectating_disabled",
  "access_denied",
] as const;
export const GameEntryUnavailableReasonSchema = z.enum(GAME_ENTRY_UNAVAILABLE_REASONS);
export type GameEntryUnavailableReason = z.infer<typeof GameEntryUnavailableReasonSchema>;

const gameEntryPreviewFields = {
  name: z.string(),
  ownerDisplayName: z.string(),
  status: GameStatusSchema,
  scheduledAt: z.number().optional(),
  playerCount: z.number(),
  canJoin: z.boolean(),
  canSpectate: z.boolean(),
  canReplay: z.boolean(),
  unavailableReason: GameEntryUnavailableReasonSchema.optional(),
};

export const GameEntryPreviewSchema = z.union([
  z.object({ ...gameEntryPreviewFields, membership: z.null() }).strict(),
  z
    .object({
      ...gameEntryPreviewFields,
      membership: z.enum(["owner", "player", "spectator", "replay"]),
      gameId: GameIdSchema,
    })
    .strict(),
]);
export type GameEntryPreview = z.infer<typeof GameEntryPreviewSchema>;

export const GameAdmissionResultSchema = z
  .object({ gameId: GameIdSchema, destination: z.enum(["game", "replay"]) })
  .strict();
export type GameAdmissionResult = z.infer<typeof GameAdmissionResultSchema>;

export const OwnerGameInvitationSchema = z.object({ code: GameCodeSchema }).strict();
export type OwnerGameInvitation = z.infer<typeof OwnerGameInvitationSchema>;
