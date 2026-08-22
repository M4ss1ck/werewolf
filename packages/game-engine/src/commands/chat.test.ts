import { describe, expect, test } from "bun:test";
import {
  type ChatChannel,
  type ChatMention,
  GameplayCommandSchema,
  type UserId,
} from "@werewolf/protocol";
import {
  availableChatChannels,
  hasChatReadEntitlement,
  knownMentionTargets,
  projectedPlayerLabel,
} from "../chat.ts";
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

function command(
  channel: ChatChannel,
  text = "hello",
  mentions: ChatMention[] = [],
): Parameters<typeof validateCommand>[2] {
  return {
    commandId: "c1",
    phaseId: 1 as never,
    type: "chat.send" as const,
    payload: { channel, text, mentions },
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
      { faction: "wolves", originalRole: "werewolf", role: "werewolf" },
      null,
    ],
    [
      "dead wolf is blocked from wolves",
      "night",
      "wolves",
      { faction: "wolves", originalRole: "werewolf", role: "werewolf", status: "dead" },
      "CHAT_READ_ONLY",
    ],
    [
      "wolf role without a channel marker cannot send",
      "discussion",
      "wolves",
      { faction: "wolves", role: "werewolf" },
      "CHANNEL_NOT_AVAILABLE",
    ],
    [
      "cult role without a channel marker cannot send",
      "discussion",
      "cult",
      { faction: "cult", role: "cultist" },
      "CHANNEL_NOT_AVAILABLE",
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
            payload: { channel: "public", text: "hello", mentions: [] },
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
          state("discussion", {
            status: "dead",
            faction: "wolves",
            originalRole: "werewolf",
            role: "werewolf",
          }),
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
          payload: { channel: "grave", text: "hello", mentions: [] },
        },
      ]);
    });
  });

  describe("mentions", () => {
    function rosterState(channel: ChatChannel): GameState {
      const result = state("discussion", {
        role: "werewolf",
        originalRole: "werewolf",
        faction: "wolves",
      });
      result.players = {
        actor: {
          ...result.players[PLAYER_ID]!,
          id: "actor" as UserId,
          displayName: "Actor",
          originalRole: channel === "cult" ? "cult_leader" : "werewolf",
          role: channel === "cult" ? "cult_leader" : "werewolf",
          faction: channel === "cult" ? "cult" : "wolves",
        },
        target: {
          ...result.players[PLAYER_ID]!,
          id: "target" as UserId,
          displayName: "Target",
          originalRole: channel === "cult" ? "cultist" : "werewolf",
          role: channel === "cult" ? "cultist" : "werewolf",
          faction: channel === "cult" ? "cult" : "wolves",
        },
      } as GameState["players"];
      return result;
    }

    test.each(["public", "wolves", "cult", "grave"] as const)(
      "valid mention emits canonical content on %s",
      (channel) => {
        const game =
          channel === "public"
            ? {
                ...state("discussion", { displayName: "Actor" }),
                players: {
                  actor: {
                    ...state("discussion", { displayName: "Actor" }).players[PLAYER_ID]!,
                    id: "actor" as UserId,
                    displayName: "Actor",
                  },
                  target: {
                    ...state().players[PLAYER_ID]!,
                    id: "target" as UserId,
                    displayName: "Target",
                  },
                },
              }
            : channel === "grave"
              ? {
                  ...state("discussion", { status: "dead", displayName: "Actor" }),
                  players: {
                    actor: {
                      ...state("discussion", { status: "dead", displayName: "Actor" }).players[
                        PLAYER_ID
                      ]!,
                      id: "actor" as UserId,
                      displayName: "Actor",
                      status: "dead" as const,
                    },
                    target: {
                      ...state("discussion", { status: "dead" }).players[PLAYER_ID]!,
                      id: "target" as UserId,
                      displayName: "Target",
                      status: "dead" as const,
                    },
                  },
                }
              : rosterState(channel);
        const text = "hello @Target";
        const mentions = [{ userId: "target" as UserId, start: 6, length: 7 }];
        const result = applyCommand(game, "actor" as UserId, command(channel, text, mentions), {
          now: 1,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.transition.events[0]?.payload).toEqual({
          channel,
          text,
          mentions,
        });
      },
    );

    test.each([
      ["self", [{ userId: "actor", start: 0, length: 6 }], "@Actor", "public"],
      ["unknown", [{ userId: "nobody", start: 6, length: 8 }], "hello @Nobody", "public"],
      ["wrong-known-set", [{ userId: "target", start: 6, length: 8 }], "hello @Nobody", "public"],
      ["wrong-slice", [{ userId: "target", start: 6, length: 7 }], "hello @Wrong", "public"],
      [
        "overlap",
        [
          { userId: "target", start: 0, length: 7 },
          { userId: "actor", start: 3, length: 6 },
        ],
        "@Target @Actor",
        "public",
      ],
    ] as const)("rejects %s mentions with INVALID_MENTION", (_name, mentions, text, channel) => {
      const game = {
        ...state("discussion", { displayName: "Actor" }),
        players: {
          actor: {
            ...state("discussion", { displayName: "Actor" }).players[PLAYER_ID]!,
            id: "actor" as UserId,
            displayName: "Actor",
          },
          target: {
            ...state().players[PLAYER_ID]!,
            id: "target" as UserId,
            displayName: "Target",
          },
        },
      };
      const result = applyCommand(
        game,
        "actor" as UserId,
        command(channel, text, mentions as unknown as ChatMention[]),
        { now: 1 },
      );
      expect(result).toEqual({ ok: false, error: { code: "INVALID_MENTION" } });
    });

    test("a ninth distinct target is rejected defensively", () => {
      const game = state("discussion", { displayName: "Actor" });
      game.players = Object.fromEntries(
        ["actor", ...Array.from({ length: 9 }, (_, index) => `target-${index}`)].map((userId) => [
          userId,
          {
            ...game.players[PLAYER_ID]!,
            id: userId as UserId,
            displayName: userId,
          },
        ]),
      ) as GameState["players"];
      const text = Array.from({ length: 9 }, (_, index) => `@target-${index}`).join(" ");
      const mentions = Array.from({ length: 9 }, (_, index) => {
        const start = text.indexOf(`@target-${index}`);
        return { userId: `target-${index}` as UserId, start, length: `@target-${index}`.length };
      });
      const result = applyCommand(game, "actor" as UserId, command("public", text, mentions), {
        now: 1,
      });
      expect(result).toEqual({ ok: false, error: { code: "INVALID_MENTION" } });
    });

    test("ordinary send legality is checked before mention semantics", () => {
      const result = validateCommand(
        state("night", { status: "dead" }),
        PLAYER_ID,
        command("public", "@Nobody", [{ userId: "nobody" as UserId, start: 0, length: 8 }]),
        { now: 1 },
      );
      expect(result).toEqual({ code: "CHAT_READ_ONLY" });
    });

    test("the protocol canonicalizes a legacy mentionless command before the engine", () => {
      const parsed = GameplayCommandSchema.parse({
        commandId: "legacy-chat",
        phaseId: 1,
        type: "chat.send",
        payload: { channel: "public", text: "  hello  " },
      });
      const result = applyCommand(state("discussion"), PLAYER_ID, parsed, { now: 1 });
      expect(result).toEqual({
        ok: true,
        transition: {
          playerPatches: [],
          events: [
            {
              kind: "chat.message",
              scope: "public",
              actorUserId: PLAYER_ID,
              payload: { channel: "public", text: "hello", mentions: [] },
            },
          ],
          ephemeral: [],
        },
      });
    });

    test.each([
      ["negative start", { userId: "target", start: -1, length: 7 }],
      ["fractional start", { userId: "target", start: 0.5, length: 7 }],
      ["zero length", { userId: "target", start: 0, length: 0 }],
      ["negative length", { userId: "target", start: 0, length: -1 }],
      ["out of bounds", { userId: "target", start: 1, length: 7 }],
      [
        "overflow-shaped range",
        { userId: "target", start: Number.MAX_SAFE_INTEGER, length: Number.MAX_SAFE_INTEGER },
      ],
    ] as const)("rejects a %s internal mention range without an event", (_name, mention) => {
      const game = {
        ...state("discussion"),
        players: {
          actor: {
            ...state("discussion").players[PLAYER_ID]!,
            id: "actor" as UserId,
            displayName: "Actor",
          },
          target: {
            ...state("discussion").players[PLAYER_ID]!,
            id: "target" as UserId,
            displayName: "Target",
          },
        },
      } as GameState;
      const result = applyCommand(
        game,
        "actor" as UserId,
        command("public", "@Target", [mention as unknown as ChatMention]),
        { now: 1 },
      );
      expect(result).toEqual({ ok: false, error: { code: "INVALID_MENTION" } });
    });

    test.each([
      ["unknown", "nobody", "@Nobody"],
      ["guessed original", "original", "@Original"],
      ["guessed pre-marker conversion", "earlier", "@Earlier"],
    ] as const)(
      "rejects a %s secret target with the same error and no event",
      (_name, targetId, text) => {
        const game = state("discussion", {
          faction: "wolves",
          originalRole: "cursed",
          role: "werewolf",
          channelSince: { wolves: 20 as never },
        });
        game.players = {
          actor: { ...game.players[PLAYER_ID]!, id: "actor" as UserId, displayName: "Actor" },
          original: {
            ...game.players[PLAYER_ID]!,
            id: "original" as UserId,
            displayName: "Original",
            originalRole: "werewolf",
          },
          earlier: {
            ...game.players[PLAYER_ID]!,
            id: "earlier" as UserId,
            displayName: "Earlier",
            channelSince: { wolves: 19 as never },
          },
        } as GameState["players"];
        const result = applyCommand(
          game,
          "actor" as UserId,
          command("wolves", text, [{ userId: targetId as UserId, start: 0, length: text.length }]),
          { now: 1 },
        );
        expect(result).toEqual({ ok: false, error: { code: "INVALID_MENTION" } });
      },
    );

    test("known targets exclude self, lobby and spectator seats and sort by id", () => {
      const game = state("discussion");
      game.players = Object.fromEntries(
        [
          ["actor", { status: "alive" }],
          ["zeta", { status: "dead" }],
          ["alpha", { status: "alive" }],
          ["lobby", { status: "lobby" }],
          ["spectator", { status: "spectator" }],
        ].map(([userId, changes]) => [
          userId,
          {
            ...game.players[PLAYER_ID]!,
            id: userId as UserId,
            ...(changes as Partial<PlayerState>),
          },
        ]),
      ) as GameState["players"];
      expect(
        knownMentionTargets(game, "actor" as UserId, "public").map((player) => player.id),
      ).toEqual(["alpha" as UserId, "zeta" as UserId]);
    });
  });

  describe("chat knowledge policy", () => {
    test("projected labels use displayName when present and id otherwise", () => {
      const named = state().players[PLAYER_ID]!;
      named.displayName = "";
      expect(projectedPlayerLabel(named)).toBe("");
      delete named.displayName;
      expect(projectedPlayerLabel(named)).toBe(PLAYER_ID);
    });

    test.each([
      ["public is available to a member", {}, "public", true],
      ["public is available to a non-member projection", undefined, "public", true],
      ["grave is available only to the dead", { status: "dead" }, "grave", true],
      ["grave is unavailable to the living", {}, "grave", false],
      ["wolf chat requires the current wolf role", { role: "werewolf" }, "wolves", false],
      [
        "wolf chat accepts a starting wolf",
        { role: "werewolf", originalRole: "werewolf" },
        "wolves",
        true,
      ],
      [
        "wolf chat accepts a marked conversion",
        { role: "werewolf", channelSince: { wolves: 4 as never } },
        "wolves",
        true,
      ],
      [
        "wolf chat rejects a missing marker",
        { role: "werewolf", originalRole: "villager" },
        "wolves",
        false,
      ],
      [
        "wolf chat rejects a lost current role",
        { role: "villager", originalRole: "werewolf" },
        "wolves",
        false,
      ],
    ] as const)("%s", (_name, changes, channel, expected) => {
      const player =
        changes === undefined ? undefined : state("discussion", changes).players[PLAYER_ID];
      expect(hasChatReadEntitlement(player, channel)).toBe(expected);
    });

    test("available channels have the fixed order and fail closed for a spectator", () => {
      expect(availableChatChannels(undefined)).toEqual(["public"]);
      expect(
        availableChatChannels(
          state("discussion", {
            status: "dead",
            role: "werewolf",
            originalRole: "werewolf",
          }).players[PLAYER_ID],
        ),
      ).toEqual(["public", "wolves", "grave"]);
      expect(
        availableChatChannels(state("discussion", { status: "spectator" }).players[PLAYER_ID]),
      ).toEqual(["public"]);
    });

    test("converted secret members know only equal or later converted members", () => {
      const base = state("discussion", {
        role: "werewolf",
        originalRole: "cursed",
        faction: "wolves",
        channelSince: { wolves: 20 as never },
      });
      base.players = {
        actor: { ...base.players[PLAYER_ID]!, id: "actor" as UserId },
        original: {
          ...base.players[PLAYER_ID]!,
          id: "original" as UserId,
          originalRole: "werewolf",
          channelSince: undefined,
        },
        earlier: {
          ...base.players[PLAYER_ID]!,
          id: "earlier" as UserId,
          channelSince: { wolves: 19 as never },
        },
        equal: {
          ...base.players[PLAYER_ID]!,
          id: "equal" as UserId,
          channelSince: { wolves: 20 as never },
        },
        later: {
          ...base.players[PLAYER_ID]!,
          id: "later" as UserId,
          channelSince: { wolves: 21 as never },
        },
        missing: {
          ...base.players[PLAYER_ID]!,
          id: "missing" as UserId,
          channelSince: undefined,
        },
        lost: {
          ...base.players[PLAYER_ID]!,
          id: "lost" as UserId,
          role: "villager",
          channelSince: { wolves: 30 as never },
        },
      } as GameState["players"];
      expect(
        knownMentionTargets(base, "actor" as UserId, "wolves").map((player) => player.id),
      ).toEqual(["equal" as UserId, "later" as UserId]);
    });

    test("converted cult members know only equal or later converted members", () => {
      const base = state("discussion", {
        role: "cultist",
        originalRole: "villager",
        faction: "cult",
        channelSince: { cult: 20 as never },
      });
      base.players = {
        actor: { ...base.players[PLAYER_ID]!, id: "actor" as UserId },
        original: {
          ...base.players[PLAYER_ID]!,
          id: "original" as UserId,
          originalRole: "cult_leader",
          role: "cult_leader",
        },
        earlier: {
          ...base.players[PLAYER_ID]!,
          id: "earlier" as UserId,
          channelSince: { cult: 19 as never },
        },
        equal: {
          ...base.players[PLAYER_ID]!,
          id: "equal" as UserId,
          channelSince: { cult: 20 as never },
        },
        later: {
          ...base.players[PLAYER_ID]!,
          id: "later" as UserId,
          channelSince: { cult: 21 as never },
        },
        missing: {
          ...base.players[PLAYER_ID]!,
          id: "missing" as UserId,
          channelSince: undefined,
        },
      } as GameState["players"];
      expect(
        knownMentionTargets(base, "actor" as UserId, "cult").map((player) => player.id),
      ).toEqual(["equal" as UserId, "later" as UserId]);
    });

    test("grave targets include dead bot seats", () => {
      const base = state("discussion", { status: "dead" });
      base.players = {
        actor: { ...base.players[PLAYER_ID]!, id: "actor" as UserId },
        bot: {
          ...base.players[PLAYER_ID]!,
          id: "bot" as UserId,
          controller: {
            type: "bot",
            config: {
              botId: "dummy",
              provider: "builtin",
              model: null,
              temperature: 0,
              maxOutputTokens: 1,
              timeoutMs: 1,
            },
          },
        },
        human: { ...base.players[PLAYER_ID]!, id: "human" as UserId },
      } as GameState["players"];
      expect(
        knownMentionTargets(base, "actor" as UserId, "grave").map((player) => player.id),
      ).toEqual(["bot" as UserId, "human" as UserId]);
    });

    test("starting secret members know all currently entitled members, including dead", () => {
      const base = state("discussion", {
        role: "werewolf",
        originalRole: "werewolf",
        faction: "wolves",
      });
      base.players = {
        actor: { ...base.players[PLAYER_ID]!, id: "actor" as UserId },
        dead: {
          ...base.players[PLAYER_ID]!,
          id: "dead" as UserId,
          status: "dead",
        },
        converted: {
          ...base.players[PLAYER_ID]!,
          id: "converted" as UserId,
          originalRole: "cursed",
          channelSince: { wolves: 10 as never },
        },
      } as GameState["players"];
      expect(
        knownMentionTargets(base, "actor" as UserId, "wolves").map((player) => player.id),
      ).toEqual(["converted" as UserId, "dead" as UserId]);
    });

    test("a missing actor marker or unavailable channel yields no targets", () => {
      const base = state("discussion", {
        role: "werewolf",
        originalRole: "cursed",
        faction: "wolves",
      });
      expect(knownMentionTargets(base, PLAYER_ID, "wolves")).toEqual([]);
      expect(knownMentionTargets(base, PLAYER_ID, "cult")).toEqual([]);
      expect(knownMentionTargets(base, "missing" as UserId, "public")).toEqual([]);
    });
  });
});
