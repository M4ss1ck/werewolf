import { describe, expect, test } from "bun:test";
import type { GameplayCommand } from "@werewolf/protocol";
import { validateCommand } from "../commands/validate.ts";
import type { GameState, PlayerState } from "../state.ts";
import { getLegalCommands, getSpeakableChannels } from "./legal-commands.ts";

const uid = (id: string) => id as PlayerState["id"];

function state(
  roles: PlayerState["role"][],
  phase: "discussion" | "voting" | "night" = "night",
  dead: string[] = [],
): GameState {
  const players = Object.fromEntries(
    roles.map((role, index) => {
      const id = uid(`p${index}`);
      return [
        id,
        {
          id,
          status: dead.includes(id) ? "dead" : "alive",
          originalRole: role,
          role,
          faction: role === "werewolf" ? "wolves" : "village",
          roleState: {},
          phaseState: { phaseId: 1 },
        },
      ];
    }),
  );
  return {
    id: "g" as GameState["id"],
    ownerUserId: uid("p0"),
    status: "running",
    day: 1,
    phase: { id: 1 as never, type: phase, startedAt: 0, endsAt: 100 },
    players,
    settings: { discussionDurationMs: 1, votingDurationMs: 1, nightDurationMs: 1 },
    balanceVersion: 1,
    winner: null,
    version: 1,
  } as unknown as GameState;
}

describe("legal command projection", () => {
  test("offers every living target plus abstain during voting", () => {
    const game = state(["werewolf", "villager", "seer", "villager", "villager"], "voting", ["p3"]);
    const legal = getLegalCommands(game, uid("p1"), 1);
    expect(legal.filter((command) => command.type === "vote.abstain")).toHaveLength(1);
    const targets = legal
      .filter((command) => command.type === "vote.set")
      .map((command) => command.payload.targetId);
    expect(targets).toEqual([uid("p0"), uid("p1"), uid("p2"), uid("p4")]);
  });

  test("offers no vote to a dead player", () => {
    const game = state(["werewolf", "villager", "seer", "villager", "villager"], "voting", ["p1"]);
    expect(getLegalCommands(game, uid("p1"), 1)).toEqual([]);
  });

  test("offers the wolf only non-wolf targets at night", () => {
    const game = state(["werewolf", "werewolf", "seer", "villager", "villager"], "night");
    const targets = getLegalCommands(game, uid("p0"), 1).map((command) =>
      command.type === "night.action.set" && "targetId" in command.payload
        ? command.payload.targetId
        : null,
    );
    expect(targets).toEqual([uid("p2"), uid("p3"), uid("p4")]);
  });

  test("offers the harlot both visiting and staying home", () => {
    const game = state(["werewolf", "harlot", "seer", "villager", "villager"], "night");
    const legal = getLegalCommands(game, uid("p1"), 1);
    const actions = legal.map((command) =>
      command.type === "night.action.set" ? command.payload.action : command.type,
    );
    expect(actions.filter((action) => action === "harlot.visit")).toHaveLength(4);
    expect(actions.filter((action) => action === "harlot.stay")).toHaveLength(1);
  });

  test("offers a plain villager nothing at night", () => {
    const game = state(["werewolf", "villager", "seer", "villager", "villager"], "night");
    expect(getLegalCommands(game, uid("p1"), 1)).toEqual([]);
    expect(getSpeakableChannels(game, uid("p1"), 1)).toEqual([]);
  });

  // The point of enumerating from `validateCommand` rather than re-deriving the
  // rules: whatever this offers must be accepted by the authoritative check.
  test("every offered command passes the authoritative validator", () => {
    for (const phase of ["discussion", "voting", "night"] as const) {
      const game = state(["werewolf", "harlot", "seer", "villager", "werewolf"], phase);
      for (const playerId of Object.keys(game.players)) {
        for (const command of getLegalCommands(game, uid(playerId), 1)) {
          const full = { ...command, commandId: "c" } as GameplayCommand;
          expect(validateCommand(game, uid(playerId), full, { now: 1 })).toBeNull();
        }
      }
    }
  });

  test("nobody may speak once the phase deadline has passed", () => {
    const game = state(["werewolf", "villager", "seer", "villager", "villager"], "discussion");
    expect(getSpeakableChannels(game, uid("p1"), 1)).toEqual(["public"]);
    expect(getSpeakableChannels(game, uid("p1"), 100)).toEqual([]);
    expect(getLegalCommands(game, uid("p1"), 100)).toEqual([]);
  });

  test("a wolf may speak on both channels by day and only wolf chat at night", () => {
    expect(
      getSpeakableChannels(
        state(["werewolf", "villager", "seer", "villager", "villager"]),
        uid("p0"),
        1,
      ),
    ).toEqual(["wolves"]);
    expect(
      getSpeakableChannels(
        state(["werewolf", "villager", "seer", "villager", "villager"], "discussion"),
        uid("p0"),
        1,
      ),
    ).toEqual(["public", "wolves"]);
  });

  test("a dead player may speak on grave in every phase", () => {
    for (const phase of ["discussion", "voting", "night"] as const) {
      const game = state(["werewolf", "villager", "seer", "villager", "villager"], phase, ["p1"]);
      expect(getSpeakableChannels(game, uid("p1"), 1)).toEqual(["grave"]);
    }
  });
});
