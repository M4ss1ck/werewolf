import { describe, expect, test } from "bun:test";
import { STALEMATE_NIGHTS } from "../composer/balance-v1.ts";
import type { GameState, PlayerState } from "../state.ts";
import { checkVictory } from "./victory.ts";

function player(
  id: string,
  role: PlayerState["role"],
  overrides: Partial<PlayerState> = {},
): PlayerState {
  return {
    id: id as PlayerState["id"],
    status: "alive",
    originalRole: role,
    role,
    faction:
      role === "werewolf" || role === "cursed"
        ? "wolves"
        : role === "serial_killer"
          ? "serial_killer"
          : role === "veteran"
            ? "veteran"
            : role === "cult_leader" || role === "cultist"
              ? "cult"
              : "village",
    roleState: {},
    phaseState: { phaseId: 1 as never },
    ...overrides,
  };
}
function game(players: PlayerState[], nightsWithoutElimination = 0): GameState {
  return {
    id: "g" as GameState["id"],
    ownerUserId: players[0]?.id ?? ("owner" as PlayerState["id"]),
    status: "running",
    day: 1,
    phase: { id: 1 as never, type: "voting", startedAt: 0, endsAt: 100 },
    players: Object.fromEntries(players.map((p) => [p.id, p])),
    settings: { discussionDurationMs: 1, votingDurationMs: 1, nightDurationMs: 1 },
    balanceVersion: 1,
    nightsWithoutElimination,
    winner: null,
    version: 1,
  } as unknown as GameState;
}

describe("victory checks", () => {
  test("no wolves left means the village wins", () => {
    const state = game([
      player("p0", "villager"),
      player("p1", "villager"),
      player("p2", "werewolf", { status: "dead" }),
    ]);
    expect(checkVictory(state)).toEqual({
      winningFactions: ["village"],
      winningPlayers: ["p0" as PlayerState["id"], "p1" as PlayerState["id"]],
      reason: "wolves_eliminated",
    });
  });

  test("a lone serial killer wins", () => {
    const state = game([player("p0", "serial_killer")]);
    expect(checkVictory(state)).toEqual({
      winningFactions: ["serial_killer"],
      winningPlayers: ["p0" as PlayerState["id"]],
      reason: "serial_killer_survives",
    });
  });

  test("a lone serial killer wins with dead faction members included", () => {
    const state = game([
      player("p0", "serial_killer", { status: "dead" }),
      player("p1", "serial_killer"),
    ]);
    expect(checkVictory(state)).toEqual({
      winningFactions: ["serial_killer"],
      winningPlayers: ["p0" as PlayerState["id"], "p1" as PlayerState["id"]],
      reason: "serial_killer_survives",
    });
  });

  test("wolves win when every living player is a wolf", () => {
    const state = game([
      player("p0", "werewolf"),
      player("p1", "werewolf"),
      player("p2", "villager", { status: "dead" }),
    ]);
    expect(checkVictory(state)).toEqual({
      winningFactions: ["wolves"],
      winningPlayers: ["p0" as PlayerState["id"], "p1" as PlayerState["id"]],
      reason: "village_eliminated",
    });
  });

  test("wolves and a serial killer alive together is not a win for anybody", () => {
    const state = game([player("p0", "werewolf"), player("p1", "serial_killer")]);
    expect(checkVictory(state)).toBeNull();
  });

  test("two wolves against one villager is an immediate pack win", () => {
    const state = game([
      player("p0", "werewolf"),
      player("p1", "werewolf"),
      player("p2", "villager"),
    ]);
    expect(checkVictory(state)).toEqual({
      winningFactions: ["wolves"],
      winningPlayers: ["p0" as PlayerState["id"], "p1" as PlayerState["id"]],
      reason: "village_eliminated",
    });
  });

  test("wolves fewer than villagers means the game continues", () => {
    const state = game([
      player("p0", "werewolf"),
      player("p1", "villager"),
      player("p2", "villager"),
    ]);
    expect(checkVictory(state)).toBeNull();
  });

  test("dead players on the winning side appear in winningPlayers", () => {
    const state = game([
      player("p0", "cursed", { status: "dead" }),
      player("p1", "werewolf"),
      player("p2", "villager", { status: "dead" }),
    ]);
    expect(checkVictory(state)).toEqual({
      winningFactions: ["wolves"],
      winningPlayers: ["p0" as PlayerState["id"], "p1" as PlayerState["id"]],
      reason: "village_eliminated",
    });
  });

  // Branch 1: nobody alive.
  test("all players dead is a no_survivors draw, not a village win", () => {
    const state = game([
      player("p0", "villager", { status: "dead" }),
      player("p1", "werewolf", { status: "dead" }),
    ]);
    expect(checkVictory(state)).toEqual({
      winningFactions: [],
      winningPlayers: [],
      reason: "no_survivors",
    });
  });

  // Branch 2: every living player is a serial killer.
  test("all living players being serial killers is a serial killer win", () => {
    const state = game([
      player("p0", "serial_killer"),
      player("p1", "serial_killer"),
      player("p2", "villager", { status: "dead" }),
    ]);
    expect(checkVictory(state)).toEqual({
      winningFactions: ["serial_killer"],
      winningPlayers: ["p0" as PlayerState["id"], "p1" as PlayerState["id"]],
      reason: "serial_killer_survives",
    });
  });

  // Branch 3: every living player is a wolf.
  test("all living players being wolves is a wolves win", () => {
    const state = game([
      player("p0", "werewolf"),
      player("p1", "werewolf"),
      player("p2", "villager", { status: "dead" }),
    ]);
    expect(checkVictory(state)).toEqual({
      winningFactions: ["wolves"],
      winningPlayers: ["p0" as PlayerState["id"], "p1" as PlayerState["id"]],
      reason: "village_eliminated",
    });
  });

  // Branch 4: every living player is a cultist.
  test("all living players being cultists is a cult win", () => {
    const state = game([
      player("p0", "cult_leader"),
      player("p1", "cultist"),
      player("p2", "villager", { status: "dead" }),
    ]);
    expect(checkVictory(state)).toEqual({
      winningFactions: ["cult"],
      winningPlayers: ["p0" as PlayerState["id"], "p1" as PlayerState["id"]],
      reason: "cult_survives",
    });
  });

  // Branch 4 regression: a living villager plus living cultists is NOT a
  // village win. Without the "no living cult" guard in branch 5, a village
  // with one survivor and three cultists alive would report a village win.
  test("one living villager plus living cultists is not a village win", () => {
    const state = game([
      player("p0", "villager"),
      player("p1", "cultist"),
      player("p2", "cultist"),
      player("p3", "cultist"),
    ]);
    expect(checkVictory(state)).toMatchObject({
      winningFactions: ["cult"],
      reason: "cult_survives",
    });
  });

  // Branch 5: a cult and wolves both alive is not a win for anyone yet.
  test("a cult and wolves both alive is not a win for anyone", () => {
    const state = game([player("p0", "cult_leader"), player("p1", "werewolf")]);
    expect(checkVictory(state)).toBeNull();
  });

  // Branch 5: no wolves, no serial killers, no cultists, at least one villager.
  test("no wolves, serial killers or cultists alive with a living villager is a village win", () => {
    const state = game([
      player("p0", "villager"),
      player("p1", "werewolf", { status: "dead" }),
      player("p2", "cultist", { status: "dead" }),
    ]);
    expect(checkVictory(state)).toEqual({
      winningFactions: ["village"],
      winningPlayers: ["p0" as PlayerState["id"]],
      reason: "wolves_eliminated",
    });
  });

  // Branch 5 regression: only a living veteran, no living villager.
  test("the only living player being a veteran is a stalemate", () => {
    const state = game([
      player("p0", "veteran"),
      player("p1", "villager", { status: "dead" }),
      player("p2", "werewolf", { status: "dead" }),
    ]);
    expect(checkVictory(state)).toEqual({
      winningFactions: [],
      winningPlayers: [],
      reason: "stalemate",
    });
  });

  test("one wolf and one villager is an immediate pack win", () => {
    expect(checkVictory(game([player("p0", "werewolf"), player("p1", "villager")]))).toEqual({
      winningFactions: ["wolves"],
      winningPlayers: ["p0" as PlayerState["id"]],
      reason: "village_eliminated",
    });
  });

  test.each(["priest", "princess", "harlot", "guardian"] as const)(
    "a lone wolf immediately beats a %s",
    (role) => {
      expect(checkVictory(game([player("p0", "werewolf"), player("p1", role)]))).toMatchObject({
        winningFactions: ["wolves"],
        reason: "village_eliminated",
      });
    },
  );

  test.each([
    ["sorcerer", "stalemate"],
    ["cultist", "stalemate"],
  ] as const)("a lone %s is doomed", (role, reason) => {
    expect(
      checkVictory(
        game([player("p0", role, { faction: role === "sorcerer" ? "wolves" : "cult" })]),
      ),
    ).toMatchObject({
      winningFactions: [],
      reason,
    });
  });

  test.each(["hunter", "mayor"] as const)(
    "a drunk perceiving %s does not contest",
    (perceivedRole) => {
      expect(
        checkVictory(
          game([
            player("p0", "drunk", { roleState: { perceivedRole } }),
            player("p1", "sorcerer", { faction: "wolves" }),
          ]),
        ),
      ).toMatchObject({ reason: "stalemate" });
    },
  );

  test.each([
    ["hunter", "village", "wolves_eliminated"],
    ["cult_leader", "cult", "cult_survives"],
    ["serial_killer", "serial_killer", "serial_killer_survives"],
  ] as const)("%s contests while living", (role, winningFaction, reason) => {
    expect(checkVictory(game([player("p0", role), player("p1", "veteran")]))).toMatchObject({
      winningFactions: [winningFaction],
      reason,
    });
  });

  test("a mayor contests before its override and not after", () => {
    expect(
      checkVictory(
        game([
          player("p0", "mayor", { roleState: { used: false } }),
          player("p1", "sorcerer", { faction: "wolves" }),
        ]),
      ),
    ).toMatchObject({ winningFactions: ["village"], reason: "wolves_eliminated" });
    expect(
      checkVictory(
        game([
          player("p0", "mayor", { roleState: { used: true } }),
          player("p1", "sorcerer", { faction: "wolves" }),
        ]),
      ),
    ).toMatchObject({ reason: "stalemate" });
  });

  test("one wolf, one serial killer, and one villager continues", () => {
    expect(
      checkVictory(
        game([player("p0", "werewolf"), player("p1", "serial_killer"), player("p2", "villager")]),
      ),
    ).toBeNull();
  });

  test("a veteran among a healthy village and a wolf does not end the game", () => {
    expect(
      checkVictory(
        game([
          player("p0", "villager"),
          player("p1", "villager"),
          player("p2", "werewolf"),
          player("p3", "veteran"),
        ]),
      ),
    ).toBeNull();
  });

  test("a converted hunter remains a contesting cult member", () => {
    expect(
      checkVictory(game([player("p0", "hunter", { faction: "cult" }), player("p1", "villager")])),
    ).toMatchObject({ winningFactions: ["cult"], reason: "cult_survives" });
  });

  test("cross-faction lover blocs resolve identically regardless of insertion order", () => {
    const cupid = player("cup", "cupid", {
      status: "dead",
      roleState: { linked: ["vLover", "wLover"] },
    });
    const villageOther = player("vOther", "villager");
    const wolfOther = player("wOther", "cursed");
    const villageLover = player("vLover", "hunter");
    const wolfLover = player("wLover", "werewolf");
    const first = checkVictory(game([cupid, villageOther, wolfOther, villageLover, wolfLover]));
    const second = checkVictory(game([cupid, wolfOther, villageOther, wolfLover, villageLover]));
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      winningFactions: ["wolves"],
      reason: "village_eliminated",
    });
  });

  // Branch 6: stalemate.
  test("the stalemate branch fires at exactly STALEMATE_NIGHTS", () => {
    const state = game(
      [
        player("p0", "veteran"),
        player("p1", "sorcerer", { faction: "wolves" }),
        player("p2", "cultist", { faction: "cult" }),
      ],
      STALEMATE_NIGHTS,
    );
    expect(checkVictory(state)).toEqual({
      winningFactions: [],
      winningPlayers: [],
      reason: "stalemate",
    });
  });

  test("the stalemate branch does not fire at STALEMATE_NIGHTS - 1", () => {
    const state = game(
      [
        player("p0", "veteran"),
        player("p1", "sorcerer", { faction: "wolves" }),
        player("p2", "cultist", { faction: "cult" }),
      ],
      STALEMATE_NIGHTS - 1,
    );
    expect(checkVictory(state)).toBeNull();
  });

  test("the stalemate branch does not fire when an earlier branch matches", () => {
    // A lone serial killer wins even with a huge counter.
    const state = game([player("p0", "serial_killer")], STALEMATE_NIGHTS);
    expect(checkVictory(state)).toEqual({
      winningFactions: ["serial_killer"],
      winningPlayers: ["p0" as PlayerState["id"]],
      reason: "serial_killer_survives",
    });
  });

  // Invariant: any non-empty winning faction has at least one living member.
  test("every named winning faction has at least one living member", () => {
    // Enumerate every population of living players with counts 0..3 per faction.
    for (let v = 0; v <= 3; v += 1) {
      for (let w = 0; w <= 3; w += 1) {
        for (let vet = 0; vet <= 3; vet += 1) {
          for (let sk = 0; sk <= 3; sk += 1) {
            for (let c = 0; c <= 3; c += 1) {
              const players: PlayerState[] = [];
              let index = 0;
              for (const [faction, count] of [
                ["village", v],
                ["wolves", w],
                ["veteran", vet],
                ["serial_killer", sk],
                ["cult", c],
              ] as const) {
                for (let i = 0; i < count; i += 1) {
                  players.push({
                    id: `p${index++}` as PlayerState["id"],
                    status: "alive",
                    originalRole: null,
                    role: null,
                    faction,
                    roleState: {},
                    phaseState: { phaseId: 1 as never },
                  });
                }
              }
              const result = checkVictory(game(players));
              if (result && result.winningFactions.length > 0) {
                for (const faction of result.winningFactions) {
                  expect(
                    players.some((p) => p.faction === faction),
                    `faction ${faction} must have a living member for population v=${v} w=${w} vet=${vet} sk=${sk} c=${c}`,
                  ).toBe(true);
                }
              }
            }
          }
        }
      }
    }
  });
});
