import { expect, test } from "bun:test";

import {
  BALANCE_VERSION,
  ChatSendCommandSchema,
  EVENT_KINDS,
  GameplayCommandSchema,
  MIN_PLAYERS,
  NightActionSetCommandSchema,
  RoleIdSchema,
  ROLE_IDS,
  SubscribeFrameSchema,
} from "./index.ts";
import type { EventId, GameEvent, UserId } from "./index.ts";

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
