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
    nightsWithoutElimination: 0,
    winner: null,
    version: 1,
  } as GameState;
}

function command(channel: "public" | "wolves" | "grave") {
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
      "wolf-faction player whose role is not a wolf-chat role is blocked from wolves",
      "discussion",
      "wolves",
      { faction: "wolves", role: "seer" },
      "CHANNEL_NOT_AVAILABLE",
    ],
    [
      "converted player writes to wolves",
      "discussion",
      "wolves",
      { faction: "wolves", role: "werewolf", channelSince: { wolves: "e1" as never } },
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

  describe("grave chat", () => {
    test.each([
      ["dead player writes to grave during discussion", "discussion", null],
      ["dead player writes to grave during voting", "voting", null],
      ["dead player writes to grave during night", "night", null],
    ] as const)("%s", (_name, phase, expected) => {
      const result = validateCommand(
        state(phase, { status: "dead" }),
        PLAYER_ID,
        command("grave"),
        { now: 1 },
      );
      expect(result?.code ?? null).toBe(expected);
    });

    test("a living player sending on grave is rejected", () => {
      const result = validateCommand(state("discussion", {}), PLAYER_ID, command("grave"), {
        now: 1,
      });
      expect(result?.code).toBe("CHANNEL_NOT_AVAILABLE");
    });

    test("a spectator sending on grave is rejected", () => {
      const result = validateCommand(
        state("discussion", { status: "spectator" }),
        PLAYER_ID,
        command("grave"),
        { now: 1 },
      );
      expect(result?.code).toBe("CHANNEL_NOT_AVAILABLE");
    });

    test("a dead player may still not send on public or wolves", () => {
      expect(
        validateCommand(state("discussion", { status: "dead" }), PLAYER_ID, command("public"), {
          now: 1,
        })?.code,
      ).toBe("CHAT_READ_ONLY");
      expect(
        validateCommand(
          state("discussion", { status: "dead", faction: "wolves", role: "werewolf" }),
          PLAYER_ID,
          command("wolves"),
          { now: 1 },
        )?.code,
      ).toBe("CHAT_READ_ONLY");
    });

    test("a grave chat.message event is emitted with scope faction and scopeId grave", () => {
      const result = applyCommand(state("night", { status: "dead" }), PLAYER_ID, command("grave"), {
        now: 1,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("should be ok");
      expect(result.transition.events).toEqual([
        {
          kind: "chat.message",
          scope: "faction",
          scopeId: "grave",
          actorUserId: PLAYER_ID,
          payload: { channel: "grave", text: "hello" },
        },
      ]);
    });
  });
});
