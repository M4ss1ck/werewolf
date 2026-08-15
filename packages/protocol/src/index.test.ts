import { expect, test } from "bun:test";
import type { EventId, GameEvent, UserId } from "./index.ts";
import {
  BALANCE_VERSION,
  ChatSendCommandSchema,
  EVENT_KINDS,
  GameplayCommandSchema,
  MeStatsSchema,
  MIN_PLAYERS,
  NightActionSetCommandSchema,
  PublicGameSummarySchema,
  ROLE_IDS,
  RoleIdSchema,
  SubscribeFrameSchema,
  ViewerGameSnapshotSchema,
  ViewerIntentSchema,
} from "./index.ts";

test("a game needs at least five active players", () => {
  expect(MIN_PLAYERS).toBe(5);
});

test("games start on balance version 1", () => {
  expect(BALANCE_VERSION).toBe(1);
});

test("a valid vote.set command parses", () => {
  const result = GameplayCommandSchema.safeParse({
    commandId: "019c-123",
    phaseId: 14,
    type: "vote.set",
    payload: { targetId: "user-123" },
  });

  expect(result.success).toBe(true);
});

test("a valid vote.abstain command parses", () => {
  const result = GameplayCommandSchema.safeParse({
    commandId: "019c-124",
    phaseId: 14,
    type: "vote.abstain",
    payload: {},
  });

  expect(result.success).toBe(true);
});

test("a chat.send naming a channel outside the allowed set is rejected", () => {
  const result = GameplayCommandSchema.safeParse({
    commandId: "019c-125",
    phaseId: 14,
    type: "chat.send",
    payload: { channel: "spectators", text: "I think Carlos is lying." },
  });

  expect(result.success).toBe(false);
});

test("a chat.send on an allowed channel parses", () => {
  const result = ChatSendCommandSchema.safeParse({
    commandId: "019c-126",
    phaseId: 15,
    type: "chat.send",
    payload: { channel: "wolves", text: "Vote Maria tonight." },
  });

  expect(result.success).toBe(true);
});

test("a command missing commandId is rejected", () => {
  const result = GameplayCommandSchema.safeParse({
    phaseId: 14,
    type: "vote.set",
    payload: { targetId: "user-123" },
  });

  expect(result.success).toBe(false);
});

test("a command with an empty commandId is rejected", () => {
  const result = GameplayCommandSchema.safeParse({
    commandId: "",
    phaseId: 14,
    type: "vote.set",
    payload: { targetId: "user-123" },
  });

  expect(result.success).toBe(false);
});

test("a command with a negative phaseId is rejected", () => {
  const result = GameplayCommandSchema.safeParse({
    commandId: "019c-130",
    phaseId: -1,
    type: "vote.set",
    payload: { targetId: "user-123" },
  });

  expect(result.success).toBe(false);
});

test("night.action.set for harlot.stay parses with no targetId", () => {
  const result = NightActionSetCommandSchema.safeParse({
    commandId: "019c-127",
    phaseId: 15,
    type: "night.action.set",
    payload: { action: "harlot.stay" },
  });

  expect(result.success).toBe(true);
});

test("night.action.set for harlot.stay is rejected when a targetId is supplied", () => {
  const result = NightActionSetCommandSchema.safeParse({
    commandId: "019c-127",
    phaseId: 15,
    type: "night.action.set",
    payload: { action: "harlot.stay", targetId: "user-456" },
  } as never);

  expect(result.success).toBe(false);
});

test("night.action.set for wolf.attack, seer.inspect and harlot.visit parses with a targetId", () => {
  const targetPayloads = [
    { action: "wolf.attack", targetId: "user-456" },
    { action: "seer.inspect", targetId: "user-456" },
    { action: "harlot.visit", targetId: "user-456" },
  ] as const;

  for (const payload of targetPayloads) {
    const result = NightActionSetCommandSchema.safeParse({
      commandId: "019c-127",
      phaseId: 15,
      type: "night.action.set",
      payload,
    });

    expect(result.success).toBe(true);
  }
});

test("night.action.set for wolf.attack, seer.inspect and harlot.visit is rejected without a targetId", () => {
  for (const action of ["wolf.attack", "seer.inspect", "harlot.visit"] as const) {
    const result = NightActionSetCommandSchema.safeParse({
      commandId: "019c-127",
      phaseId: 15,
      type: "night.action.set",
      payload: { action },
    } as never);

    expect(result.success).toBe(false);
  }
});

test("a night.action.set with an unknown ActionId is rejected", () => {
  const result = GameplayCommandSchema.safeParse({
    commandId: "019c-128",
    phaseId: 15,
    type: "night.action.set",
    payload: { action: "seer.ask", targetId: "user-456" },
  } as never);

  expect(result.success).toBe(false);
});

test("every RoleId in the union is accepted by the RoleId schema", () => {
  for (const role of ROLE_IDS) {
    expect(RoleIdSchema.safeParse(role).success).toBe(true);
  }
});

test("the RoleId schema rejects values outside the union", () => {
  expect(RoleIdSchema.safeParse("wizard").success).toBe(false);
});

test("the subscribe frame parses with a numeric cursor", () => {
  const result = SubscribeFrameSchema.safeParse({ type: "subscribe", cursor: 481 });

  expect(result.success).toBe(true);
});

test("the subscribe frame rejects a non-integer cursor", () => {
  const result = SubscribeFrameSchema.safeParse({ type: "subscribe", cursor: 48.5 });

  expect(result.success).toBe(false);
});

test("the subscribe frame rejects a negative cursor", () => {
  const result = SubscribeFrameSchema.safeParse({ type: "subscribe", cursor: -1 });

  expect(result.success).toBe(false);
});

test("EVENT_KINDS covers the initial protocol vocabulary", () => {
  expect(EVENT_KINDS).toEqual([
    "game.started",
    "phase.started",
    "vote.resolved",
    "player.eliminated",
    "princess.revealed",
    "night.resolved",
    "game.finished",
    "chat.message",
    "role.assigned",
    "seer.result",
    "cursed.converted",
    "harlot.result",
    "wolves.member_joined",
    "masons.member_joined",
    "game.start_deferred",
    "audit.vote",
    "audit.night",
  ]);
});

test("a player.eliminated event can be narrowed by kind", () => {
  const event: GameEvent = {
    id: 12 as EventId,
    kind: "player.eliminated",
    scope: "public",
    actorUserId: "user-123" as UserId,
    createdAt: 1_700_000_000,
    payload: { playerId: "user-123" as UserId, role: "werewolf", cause: "day_vote" },
  };

  if (event.kind !== "player.eliminated") {
    throw new Error("expected a player.eliminated event");
  }

  // Narrowing on `kind` exposes the right payload shape.
  expect(event.payload.cause).toBe("day_vote");
});

function snapshotInput(): Record<string, unknown> {
  return {
    game: {
      id: "game-1",
      name: "Game",
      ownerUserId: "user-1",
      status: "running",
      day: 2,
      phase: { id: 5, type: "voting", startedAt: 0, endsAt: 60 },
      settings: {
        visibility: "public",
        spectatingEnabled: true,
        durations: { discussion: 120, voting: 60, night: 60 },
      },
    },
    players: [],
    availableActions: [],
    availableChannels: ["public"],
    cursor: 5,
    serverNow: 1_000,
  };
}

test("the snapshot schema keeps the winner of a finished game", () => {
  const input = snapshotInput();
  input.game = {
    ...(input.game as Record<string, unknown>),
    status: "finished",
    winner: {
      winningFactions: ["village"],
      winningPlayers: ["user-1"],
      reason: "wolves_eliminated",
    },
  };
  const result = ViewerGameSnapshotSchema.safeParse(input);
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data.game.winner).toEqual({
      winningFactions: ["village"],
      winningPlayers: ["user-1" as UserId],
      reason: "wolves_eliminated",
    });
  }
});

test("the snapshot schema keeps voteTallies during a voting phase", () => {
  const input = snapshotInput();
  input.voteTallies = [
    { targetId: "user-2", count: 3 },
    { targetId: "user-3", count: 1 },
  ];
  const result = ViewerGameSnapshotSchema.safeParse(input);
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data.voteTallies).toEqual([
      { targetId: "user-2" as UserId, count: 3 },
      { targetId: "user-3" as UserId, count: 1 },
    ]);
  }
});

test("the snapshot schema keeps a typed currentIntent", () => {
  const input = snapshotInput();
  input.me = {
    userId: "user-1",
    status: "alive",
    currentIntent: {
      vote: { type: "player", targetId: "user-2" },
      actions: { "wolf.attack": { targetId: "user-2" }, "harlot.stay": {} },
    },
  };
  const result = ViewerGameSnapshotSchema.safeParse(input);
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data.me?.currentIntent).toEqual({
      vote: { type: "player", targetId: "user-2" as UserId },
      actions: {
        "wolf.attack": { targetId: "user-2" as UserId },
        "harlot.stay": {},
      },
    });
  }
});

test("ViewerIntentSchema accepts player votes, abstain votes and actions", () => {
  expect(
    ViewerIntentSchema.safeParse({ vote: { type: "player", targetId: "user-2" } }).success,
  ).toBe(true);
  expect(ViewerIntentSchema.safeParse({ vote: { type: "abstain" } }).success).toBe(true);
  expect(
    ViewerIntentSchema.safeParse({ actions: { "wolf.attack": { targetId: "user-2" } } }).success,
  ).toBe(true);
});

test("ViewerIntentSchema rejects a player vote without a targetId", () => {
  expect(ViewerIntentSchema.safeParse({ vote: { type: "player" } }).success).toBe(false);
});

test("the game summary schema parses a running game with a phase", () => {
  const result = PublicGameSummarySchema.safeParse({
    id: "game-1",
    name: "Game",
    ownerUserId: "user-1",
    status: "running",
    visibility: "public",
    day: 2,
    playerCount: 6,
    players: [{ userId: "user-1", displayName: "Ada" }],
    phase: { type: "voting", endsAt: 1_234 },
    serverNow: 1_000,
  });
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data.phase).toEqual({ type: "voting", endsAt: 1_234 });
    expect(result.data.scheduledAt).toBeUndefined();
  }
});

test("the game summary schema parses a scheduled game with a scheduledAt", () => {
  const result = PublicGameSummarySchema.safeParse({
    id: "game-1",
    name: "Game",
    ownerUserId: "user-1",
    status: "scheduled",
    visibility: "private",
    day: 0,
    playerCount: 3,
    players: [],
    scheduledAt: 1_700_000_000,
    serverNow: 1_000,
  });
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data.scheduledAt).toBe(1_700_000_000);
    expect(result.data.phase).toBeUndefined();
  }
});

test("the game summary schema never carries secret or internal fields", () => {
  const result = PublicGameSummarySchema.safeParse({
    id: "game-1",
    name: "Game",
    ownerUserId: "user-1",
    status: "running",
    visibility: "public",
    day: 2,
    playerCount: 6,
    players: [],
    serverNow: 1_000,
    rngSeed: 42,
    joinCode: "ABCD",
    settingsJson: "{}",
    winnerJson: "{}",
    version: 1,
  });
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data).not.toHaveProperty("rngSeed");
    expect(result.data).not.toHaveProperty("joinCode");
    expect(result.data).not.toHaveProperty("settingsJson");
    expect(result.data).not.toHaveProperty("winnerJson");
    expect(result.data).not.toHaveProperty("version");
  }
});

test("the stats schema parses a valid MeStats", () => {
  const result = MeStatsSchema.safeParse({ games: 10, survived: 4, asWolf: 3 });
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data).toEqual({ games: 10, survived: 4, asWolf: 3 });
  }
});
