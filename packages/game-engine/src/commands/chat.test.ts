import { describe, expect, test } from "bun:test";
import type { GameState, PlayerState } from "../state.ts";
import { applyCommand } from "./apply.ts";
import { validateCommand } from "./validate.ts";

const PLAYER_ID = "p1" as PlayerState["id"];

function state(
  phase: "discussion" | "voting" | "night" = "discussion",
  player: Partial<PlayerState> = {},
): GameState {
  const id = PLAYER_ID;
  return {
    id: "g" as GameState["id"],
    ownerUserId: id,
    status: "running",
    day: 1,
    phase: { id: 1 as never, type: phase, startedAt: 0, endsAt: 100 },
    players: {
      [id]: {
        id,
        status: "alive",
        originalRole: "villager",
        role: "villager",
        faction: "village",
        roleState: {},
        phaseState: { phaseId: 1 as never },
        ...player,
      },
    },
    settings: { discussionDurationMs: 1, votingDurationMs: 1, nightDurationMs: 1 },
    balanceVersion: 1,
    winner: null,
    version: 1,
  } as GameState;
}

function command(channel: "public" | "wolves") {
  return {
    commandId: "c1",
    phaseId: 1 as never,
    type: "chat.send" as const,
    payload: { channel, text: "hello" },
  };
}

describe("chat commands", () => {
  test.each([
    ["living player writes public during discussion", "discussion", "public", {}, null],
    ["living player writes public during voting", "voting", "public", {}, null],
    ["living player is blocked from public at night", "night", "public", {}, "CHAT_READ_ONLY"],
    [
      "dead player is blocked from public",
      "discussion",
      "public",
      { status: "dead" },
      "CHAT_READ_ONLY",
    ],
    [
      "living wolf writes to wolves",
      "night",
      "wolves",
      { faction: "wolves", role: "werewolf" },
      null,
    ],
    [
      "dead wolf is blocked from wolves",
      "night",
      "wolves",
      { faction: "wolves", role: "werewolf", status: "dead" },
      "CHAT_READ_ONLY",
    ],
    ["non-wolf cannot access wolves", "discussion", "wolves", {}, "CHANNEL_NOT_AVAILABLE"],
    [
      "converted player writes to wolves",
      "discussion",
      "wolves",
      { faction: "wolves", role: "cursed", wolfSinceEventId: "e1" },
      null,
    ],
  ] as const)("%s", (_name, phase, channel, player, expected) => {
    const result = validateCommand(
      state(phase, player as Partial<PlayerState>),
      PLAYER_ID,
      command(channel),
      { now: 1 },
    );
    expect(result?.code ?? null).toBe(expected);
  });

  test("applying chat sends a semantic event", () => {
    const result = applyCommand(state("discussion"), PLAYER_ID, command("public"), {
      now: 1,
    });
    expect(result).toEqual({
      ok: true,
      transition: {
        playerPatches: [],
        events: [
          {
            kind: "chat.message",
            scope: "public",
            actorUserId: PLAYER_ID,
            payload: { channel: "public", text: "hello" },
          },
        ],
        ephemeral: [],
      },
    });
  });
});
