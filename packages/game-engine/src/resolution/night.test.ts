import { describe, expect, test } from "bun:test";
import type { EventPayloads } from "@werewolf/protocol";
import { SeededRng } from "../rng/rng.ts";
import type { DomainTransition, GameState, PlayerState } from "../state.ts";
import { resolveNight } from "./night.ts";

const id = (value: string) => value as PlayerState["id"];

function makeState(
  roles: PlayerState["role"][],
  actions: Record<string, Record<string, unknown>> = {},
  phaseId = 1,
): GameState {
  const players = Object.fromEntries(
    roles.map((role, index) => {
      const playerId = id(`p${index}`);
      return [
        playerId,
        {
          id: playerId,
          status: "alive",
          originalRole: role,
          role,
          faction: role === "werewolf" ? "wolves" : "village",
          roleState: {},
          phaseState: { phaseId, actions: actions[`p${index}`] },
        },
      ];
    }),
  );
  return {
    id: id("g") as unknown as GameState["id"],
    status: "running",
    day: 1,
    phase: { id: phaseId as never, type: "night", startedAt: 0, endsAt: 100 },
    players,
    settings: { discussionDurationMs: 10, votingDurationMs: 10, nightDurationMs: 10 },
    balanceVersion: 1,
    winner: null,
    version: 1,
  } as unknown as GameState;
}

function resolve(state: GameState, seed = "seed") {
  const result = resolveNight(state, { now: 100, rng: new SeededRng(seed) });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.code);
  return result.transition;
}

function action(target: string) {
  return { "wolf.attack": { targetId: id(target) } };
}

function deadPlayerIds(transition: DomainTransition): string[] {
  return transition.playerPatches
    .filter((patch) => patch.changes.status === "dead")
    .map((patch) => String(patch.playerId))
    .sort();
}

function auditDeaths(transition: DomainTransition): EventPayloads["audit.night"]["deaths"] {
  const event = transition.events.find((candidate) => candidate.kind === "audit.night");
  if (!event) return [];
  return (event.payload as EventPayloads["audit.night"]).deaths;
}

describe("night resolution", () => {
  test.each([
    [
      "wolves attack a villager who dies",
      ["werewolf", "werewolf", "villager"],
      { p0: action("p2"), p1: action("p2") },
      ["p2"],
      { p2: "dead" },
      "seed",
    ],
    [
      "wolves attack the Cursed who converts instead of dying",
      ["werewolf", "werewolf", "cursed"],
      { p0: action("p2"), p1: action("p2") },
      [],
      { p2: "werewolf" },
      "seed",
    ],
    [
      "wolves attack the Hunter who repels and kills a wolf",
      ["werewolf", "werewolf", "hunter", "villager"],
      { p0: action("p2"), p1: action("p2") },
      ["p0"],
      { p2: "alive" },
      "c",
    ],
    [
      "wolves attack the Hunter who fails and dies",
      ["werewolf", "werewolf", "hunter", "villager"],
      { p0: action("p2"), p1: action("p2") },
      ["p2"],
      { p2: "dead" },
      "seed",
    ],
    [
      "wolves attack the Harlot while she is away and the attack fails",
      ["werewolf", "werewolf", "harlot", "villager"],
      { p0: action("p2"), p1: action("p2"), p2: { "harlot.visit": { targetId: id("p3") } } },
      [],
      { p2: "alive" },
      "seed",
    ],
  ] as const)("%s", (_name, roles, actions, deaths, expected, seed = "seed") => {
    const transition = resolve(makeState(roles as unknown as PlayerState["role"][], actions), seed);
    expect(deadPlayerIds(transition)).toEqual([...deaths].map(String).sort());
    if (expected.p2 === "werewolf")
      expect(transition.playerPatches).toContainEqual({
        playerId: id("p2"),
        changes: { role: "werewolf", faction: "wolves" },
      });
  });

  test.each([
    [
      "the Harlot visits a wolf and dies",
      ["werewolf", "harlot", "villager"],
      { p1: { "harlot.visit": { targetId: id("p0") } } },
      ["p1"],
      "seed",
    ],
    [
      "the Harlot visits the ordinary balloted target and both die",
      ["werewolf", "harlot", "villager"],
      { p0: action("p2"), p1: { "harlot.visit": { targetId: id("p2") } } },
      ["p1", "p2"],
      "seed",
    ],
    [
      "the Harlot visits the Cursed who converts and the Harlot dies",
      ["werewolf", "harlot", "cursed"],
      { p0: action("p2"), p1: { "harlot.visit": { targetId: id("p2") } } },
      ["p1"],
      "seed",
    ],
    [
      "the Harlot visits the Hunter who repels and both survive",
      ["werewolf", "harlot", "hunter", "villager"],
      { p0: action("p2"), p1: { "harlot.visit": { targetId: id("p2") } } },
      ["p0"],
      "c",
    ],
    [
      "the Harlot visits the Hunter who fails and both die",
      ["werewolf", "harlot", "hunter", "villager"],
      { p0: action("p2"), p1: { "harlot.visit": { targetId: id("p2") } } },
      ["p1", "p2"],
      "seed",
    ],
  ] as const)("%s", (_name, roles, actions, deaths, seed = "seed") => {
    const transition = resolve(makeState(roles as unknown as PlayerState["role"][], actions), seed);
    expect(deadPlayerIds(transition)).toEqual([...deaths].map(String).sort());
  });

  test("seer sees a Cursed before conversion", () => {
    const transition = resolve(
      makeState(["werewolf", "seer", "cursed"], {
        p0: action("p2"),
        p1: { "seer.inspect": { targetId: id("p2") } },
      }),
    );
    expect(transition.events).toContainEqual({
      kind: "seer.result",
      scope: "player",
      scopeId: "p1",
      payload: { targetId: id("p2"), role: "cursed" },
    });
  });

  test("a tied wolf ballot attacks nobody", () => {
    const transition = resolve(
      makeState(["werewolf", "werewolf", "villager", "villager"], {
        p0: action("p2"),
        p1: action("p3"),
      }),
    );
    expect(transition.events).toContainEqual({
      kind: "night.resolved",
      scope: "public",
      payload: { deaths: [] },
    });
  });

  test("same seed reproduces the outcome and dawn hides causes", () => {
    const tie = resolve(
      makeState(["werewolf", "werewolf", "villager", "villager"], {
        p0: action("p2"),
        p1: action("p3"),
      }),
      "same",
    );
    const away = resolve(
      makeState(["werewolf", "werewolf", "harlot", "villager"], {
        p0: action("p2"),
        p1: action("p2"),
        p2: { "harlot.visit": { targetId: id("p3") } },
      }),
      "same",
    );
    expect(
      resolve(
        makeState(["werewolf", "werewolf", "hunter", "villager"], {
          p0: action("p2"),
          p1: action("p2"),
        }),
        "same",
      ),
    ).toEqual(
      resolve(
        makeState(["werewolf", "werewolf", "hunter", "villager"], {
          p0: action("p2"),
          p1: action("p2"),
        }),
        "same",
      ),
    );
    expect(tie.events.filter((event) => event.scope === "public")).toEqual(
      away.events.filter((event) => event.scope === "public"),
    );
  });

  test("public dawn never reveals which mechanism killed someone", () => {
    const attack = resolve(
      makeState(["werewolf", "villager", "villager", "villager"], {
        p0: action("p1"),
      }),
    );
    const retaliation = resolve(
      makeState(["werewolf", "werewolf", "hunter", "villager", "villager"], {
        p0: action("p2"),
        p1: action("p2"),
      }),
      "c",
    );
    const exposure = resolve(
      makeState(["werewolf", "harlot", "villager", "villager"], {
        p1: { "harlot.visit": { targetId: id("p0") } },
      }),
    );
    const normalize = (transition: DomainTransition) =>
      transition.events
        .filter((event) => event.scope === "public")
        .map((event) => {
          switch (event.kind) {
            case "player.eliminated":
              return {
                kind: event.kind,
                playerId: "X",
                role: "R",
                cause: (event.payload as EventPayloads["player.eliminated"]).cause,
              };
            case "night.resolved":
              return {
                kind: event.kind,
                deaths: (event.payload as EventPayloads["night.resolved"]).deaths.map(() => "X"),
              };
            default:
              return { kind: event.kind };
          }
        });
    expect(normalize(attack)).toEqual(normalize(retaliation));
    expect(normalize(retaliation)).toEqual(normalize(exposure));
    for (const transition of [attack, retaliation, exposure]) {
      for (const event of transition.events) {
        if (event.kind === "player.eliminated" && event.scope === "public")
          expect((event.payload as EventPayloads["player.eliminated"]).cause).toBe("night");
      }
    }
    expect(auditDeaths(attack)).toEqual([{ playerId: id("p1"), cause: "wolf_attack" }]);
    expect(auditDeaths(retaliation)).toEqual([{ playerId: id("p0"), cause: "hunter_retaliation" }]);
    expect(auditDeaths(exposure)).toEqual([{ playerId: id("p1"), cause: "harlot_exposure" }]);
  });
});
