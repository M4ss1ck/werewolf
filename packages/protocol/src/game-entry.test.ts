import { expect, test } from "bun:test";
import { ErrorCodeSchema } from "./errors.ts";
import type { GameCode } from "./game-entry.ts";
import {
  GAME_CODE_ALPHABET,
  GameAdmissionResultSchema,
  GameCodeSchema,
  GameEntryModeSchema,
  GameEntryPreviewSchema,
  GameEntryReferenceSchema,
  GameEntryUnavailableReasonSchema,
  normalizeGameCode,
  OwnerGameInvitationSchema,
} from "./game-entry.ts";

test("the game-code alphabet and canonical schema accept only ten uppercase characters", () => {
  expect(GAME_CODE_ALPHABET).toBe("23456789ABCDEFGHJKMNPQRSTVWXYZ");
  expect(GameCodeSchema.safeParse("K7M3P9T2WQ").success).toBe(true);
  expect(GameCodeSchema.safeParse("k7m3p9t2wq").success).toBe(false);
  expect(GameCodeSchema.safeParse("K7M3-P9T2-WQ").success).toBe(false);
});

test("normalizeGameCode accepts lowercase and optional separators", () => {
  expect(normalizeGameCode(" k7m3-p9t2-wq ")).toBe("K7M3P9T2WQ" as GameCode);
  expect(normalizeGameCode("K7M3 P9T2 WQ")).toBe("K7M3P9T2WQ" as GameCode);
  expect(normalizeGameCode("K7M3P9T2WQ")).toBe("K7M3P9T2WQ" as GameCode);
});

test("normalizeGameCode rejects ambiguous characters, invalid characters and wrong lengths", () => {
  for (const input of [
    "",
    "K7M3P9T2W",
    "K7M3P9T2WQQ",
    "K7M3P9T2W0",
    "K7M3P9T2W1",
    "K7M3P9T2WI",
    "K7M3P9T2WL",
    "K7M3P9T2WO",
    "K7M3P9T2W-",
    "K7M3P9T2W_",
  ]) {
    expect(normalizeGameCode(input), input).toBeUndefined();
  }
});

test("game-entry references are exactly the invitation and public-game variants", () => {
  expect(
    GameEntryReferenceSchema.safeParse({ kind: "invitation", code: "K7M3P9T2WQ" }).success,
  ).toBe(true);
  expect(
    GameEntryReferenceSchema.safeParse({ kind: "public-game", gameId: "game-1" }).success,
  ).toBe(true);
  for (const value of [
    { kind: "invitation", code: "K7M3P9T2WQ", gameId: "game-1" },
    { kind: "public-game", gameId: "game-1", code: "K7M3P9T2WQ" },
    { kind: "game", gameId: "game-1" },
  ]) {
    expect(GameEntryReferenceSchema.safeParse(value).success).toBe(false);
  }
});

test("entry modes and unavailable reasons use stable identifiers", () => {
  for (const mode of ["player", "spectator", "replay"]) {
    expect(GameEntryModeSchema.safeParse(mode).success).toBe(true);
  }
  for (const reason of ["cancelled", "started", "spectating_disabled", "access_denied"]) {
    expect(GameEntryUnavailableReasonSchema.safeParse(reason).success).toBe(true);
  }
  expect(GameEntryModeSchema.safeParse("join").success).toBe(false);
  expect(GameEntryUnavailableReasonSchema.safeParse("private").success).toBe(false);
});

const preview = {
  name: "Friday game",
  ownerDisplayName: "Ada",
  status: "lobby" as const,
  scheduledAt: 1_700_000_000,
  playerCount: 5,
  canJoin: true,
  canSpectate: true,
  canReplay: false,
};

test("a non-member preview forbids gameId, while an existing membership requires it", () => {
  expect(GameEntryPreviewSchema.safeParse({ ...preview, membership: null }).success).toBe(true);
  expect(
    GameEntryPreviewSchema.safeParse({ ...preview, membership: null, gameId: "game-1" }).success,
  ).toBe(false);
  expect(
    GameEntryPreviewSchema.safeParse({ ...preview, membership: "spectator", gameId: "game-1" })
      .success,
  ).toBe(true);
  expect(GameEntryPreviewSchema.safeParse({ ...preview, membership: "spectator" }).success).toBe(
    false,
  );
});

test("preview and entry DTOs strictly reject private or extra fields", () => {
  for (const field of ["code", "roster", "events", "chat", "roles", "settings"]) {
    expect(
      GameEntryPreviewSchema.safeParse({ ...preview, membership: null, [field]: [] }).success,
      field,
    ).toBe(false);
  }
  expect(
    GameAdmissionResultSchema.safeParse({ gameId: "game-1", destination: "game" }).success,
  ).toBe(true);
  expect(
    GameAdmissionResultSchema.safeParse({
      gameId: "game-1",
      destination: "replay",
      code: "K7M3P9T2WQ",
    }).success,
  ).toBe(false);
  expect(OwnerGameInvitationSchema.safeParse({ code: "K7M3P9T2WQ" }).success).toBe(true);
  expect(
    OwnerGameInvitationSchema.safeParse({ code: "K7M3P9T2WQ", gameId: "game-1" }).success,
  ).toBe(false);
});

test("the new invitation errors are in the semantic error-code vocabulary", () => {
  for (const code of ["INVITATION_NOT_FOUND", "INVITATION_ACCESS_DENIED", "SPECTATING_DISABLED"]) {
    expect(ErrorCodeSchema.safeParse(code).success).toBe(true);
  }
});
