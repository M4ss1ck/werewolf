import { describe, expect, test } from "bun:test";
import type { GameEvent, UserId } from "@werewolf/protocol";
import type { GameState, PlayerState } from "../state.ts";
import { filterVisibleEvents } from "./events.ts";
import { canViewEvent } from "./permissions.ts";
import { projectSnapshot } from "./snapshot.ts";

const id = (value: string) => value as UserId;

function makeState(): GameState {
  const players: Record<string, PlayerState> = {};
  for (const [userId, role, status] of [
    ["wolf", "werewolf", "alive"],
    ["seer", "seer", "alive"],
    ["dead-wolf", "werewolf", "dead"],
  ] as const) {
    players[userId] = {
      id: id(userId),
      displayName: userId,
      status,
      originalRole: role,
      role,
      faction: role === "werewolf" ? "wolves" : "village",
      roleState: {},
      phaseState: { phaseId: 1 as never },
    };
  }
  return {
    id: "game" as GameState["id"],
    name: "Game",
    ownerUserId: id("seer"),
    status: "running",
    day: 1,
    phase: {
      id: 1 as never,
      type: "night",
      startedAt: 0,
      endsAt: 10,
    },
    players,
    settings: { discussionDurationMs: 1000, votingDurationMs: 1000, nightDurationMs: 1000 },
    balanceVersion: 1,
    nightsWithoutElimination: 0,
    winner: null,
    version: 1,
  };
}

const event = (id: number, scope: GameEvent["scope"], kind: GameEvent["kind"], scopeId?: string) =>
  ({
    id: id as GameEvent["id"],
    kind,
    scope,
    ...(scopeId ? { scopeId } : {}),
    createdAt: 0,
    payload:
      kind === "seer.result" ? { targetId: "wolf" as UserId, role: "werewolf" as const } : {},
  }) as GameEvent;

function addPlayer(
  state: GameState,
  userId: string,
  role: NonNullable<PlayerState["role"]>,
  status: PlayerState["status"],
): void {
  state.players[id(userId)] = {
    id: id(userId),
    displayName: userId,
    status,
    originalRole: role,
    role,
    faction: role === "werewolf" ? "wolves" : "village",
    roleState: {},
    phaseState: { phaseId: state.phase!.id },
  };
}

describe("viewer projection security", () => {
  test("living roles stay hidden, dead roles are public, and a member sees only their own role", () => {
    const state = makeState();
    const snapshot = projectSnapshot(state, { userId: id("seer"), cursor: 4, serverNow: 5 });
    expect(snapshot.game.ownerUserId).toBe(id("seer"));
    expect(snapshot.me?.role).toBe("seer");
    expect(snapshot.players.find((player) => player.userId === id("wolf"))).not.toHaveProperty(
      "revealedRole",
    );
    expect(snapshot.players.find((player) => player.userId === id("dead-wolf"))).toHaveProperty(
      "revealedRole",
      "werewolf",
    );
  });

  test("a non-member has no me and no living roles", () => {
    const snapshot = projectSnapshot(makeState(), {
      userId: id("spectator"),
      cursor: 0,
      serverNow: 0,
    });
    expect(snapshot.me).toBeUndefined();
    expect(
      snapshot.players.every((player) => !player.revealedRole || player.status === "dead"),
    ).toBe(true);
  });

  test("event scopes protect private, wolf, and server events", () => {
    const state = makeState();
    const privateEvent = event(1, "player", "seer.result", "seer");
    const wolfEvent = event(2, "faction", "chat.message", "wolves");
    const oldWolfEvent = event(3, "faction", "chat.message", "wolves");
    state.players[id("seer")]!.channelSince = { wolves: 4 as GameEvent["id"] };
    expect(canViewEvent(privateEvent, id("seer"), state)).toBe(true);
    expect(canViewEvent(privateEvent, id("wolf"), state)).toBe(false);
    expect(canViewEvent(wolfEvent, id("seer"), state)).toBe(false);
    expect(canViewEvent(oldWolfEvent, id("dead-wolf"), state)).toBe(true);
    expect(filterVisibleEvents([privateEvent, wolfEvent], id("spectator"), state)).toEqual([]);
    expect(canViewEvent(event(5, "server", "audit.vote"), id("wolf"), state)).toBe(false);
  });

  test("converted wolves only see events from conversion onward", () => {
    const state = makeState();
    state.players[id("seer")]!.faction = "wolves";
    state.players[id("seer")]!.role = "werewolf";
    state.players[id("seer")]!.channelSince = { wolves: 10 as GameEvent["id"] };
    expect(canViewEvent(event(9, "faction", "chat.message", "wolves"), id("seer"), state)).toBe(
      false,
    );
    expect(canViewEvent(event(10, "faction", "chat.message", "wolves"), id("seer"), state)).toBe(
      true,
    );
  });

  test("availableChannels includes grave for a dead viewer and not for a living one", () => {
    const state = makeState();
    expect(projectSnapshot(state, id("dead-wolf")).availableChannels).toContain("grave");
    expect(projectSnapshot(state, id("seer")).availableChannels).not.toContain("grave");
  });

  test("secret knowledge contains exactly known targets and no public or grave map", () => {
    const state = makeState();
    const wolfSnapshot = projectSnapshot(state, id("wolf"));
    expect(wolfSnapshot.knownChannelMemberIds).toEqual({ wolves: [id("dead-wolf")] });
    expect(wolfSnapshot.knownChannelMemberIds).not.toHaveProperty("public");
    expect(wolfSnapshot.knownChannelMemberIds).not.toHaveProperty("grave");

    const nonMemberSnapshot = projectSnapshot(state, id("spectator"));
    expect(nonMemberSnapshot.knownChannelMemberIds).toBeUndefined();
    expect(nonMemberSnapshot.availableChannels).toEqual(["public"]);
  });

  test("a dead secret member keeps secret knowledge while gaining grave chat", () => {
    const snapshot = projectSnapshot(makeState(), id("dead-wolf"));
    expect(snapshot.availableChannels).toEqual(["public", "wolves", "grave"]);
    expect(snapshot.knownChannelMemberIds).toEqual({ wolves: [id("wolf")] });
  });

  test("a converted member's snapshot lists only equal or later conversions", () => {
    const state = makeState();
    state.players[id("wolf")]!.originalRole = "cursed";
    state.players[id("wolf")]!.channelSince = { wolves: 20 as GameEvent["id"] };
    delete state.players[id("dead-wolf")]!.channelSince;
    addPlayer(state, "converted-earlier", "werewolf", "alive");
    state.players[id("converted-earlier")]!.originalRole = "cursed";
    state.players[id("converted-earlier")]!.channelSince = { wolves: 19 as GameEvent["id"] };
    addPlayer(state, "converted-later", "werewolf", "alive");
    state.players[id("converted-later")]!.originalRole = "cursed";
    state.players[id("converted-later")]!.channelSince = { wolves: 21 as GameEvent["id"] };

    const snapshot = projectSnapshot(state, id("wolf"));
    expect(snapshot.availableChannels).toContain("wolves");
    expect(snapshot.knownChannelMemberIds).toEqual({ wolves: [id("converted-later")] });
  });

  test("an available secret channel is projected with an empty known list", () => {
    const state = makeState();
    delete state.players[id("dead-wolf")];
    const snapshot = projectSnapshot(state, id("wolf"));
    expect(snapshot.availableChannels).toEqual(["public", "wolves"]);
    expect(snapshot.knownChannelMemberIds).toEqual({ wolves: [] });
  });
});

describe("finished games reveal roles and expose the winner", () => {
  function finishedState(): GameState {
    const state = makeState();
    state.status = "finished";
    state.phase = null;
    state.winner = {
      winningFactions: ["village"],
      winningPlayers: [id("seer")],
      reason: "wolves_eliminated",
    };
    return state;
  }

  test("every role is revealed once the game is finished, alive or dead", () => {
    const snapshot = projectSnapshot(finishedState(), id("seer"));
    for (const player of snapshot.players) {
      expect(player.revealedRole).toBe(player.userId === id("seer") ? "seer" : "werewolf");
    }
  });

  test("the winner is exposed on the snapshot when finished", () => {
    const snapshot = projectSnapshot(finishedState(), id("seer"));
    expect(snapshot.game.winner).toEqual({
      winningFactions: ["village"],
      winningPlayers: [id("seer")],
      reason: "wolves_eliminated",
    });
  });

  test("the winner stays absent while the game is running", () => {
    const snapshot = projectSnapshot(makeState(), id("seer"));
    expect(snapshot.game.winner).toBeUndefined();
  });
});

describe("voting tallies", () => {
  function votingState(): GameState {
    const state = makeState();
    state.status = "running";
    state.day = 2;
    state.phase = { id: 7 as never, type: "voting", startedAt: 0, endsAt: 60 };
    return state;
  }

  test("voteTallies aggregate live players' votes for the current phase", () => {
    const state = votingState();
    // Stale vote from a previous phase and a dead player's vote are both excluded.
    state.players[id("wolf")]!.phaseState = {
      phaseId: 6 as never,
      vote: { type: "player", targetId: id("seer") },
    };
    state.players[id("dead-wolf")]!.phaseState = {
      phaseId: 7 as never,
      vote: { type: "player", targetId: id("seer") },
    };
    addPlayer(state, "hunter", "villager", "alive");
    state.players[id("seer")]!.phaseState = {
      phaseId: 7 as never,
      vote: { type: "player", targetId: id("hunter") },
    };
    const snapshot = projectSnapshot(state, id("seer"));
    expect(snapshot.voteTallies).toEqual([{ targetId: id("hunter"), count: 1 }]);
  });

  test("voteTallies sort by count descending then target ascending, omitting zero-vote targets", () => {
    const state = votingState();
    addPlayer(state, "hunter", "villager", "alive");
    addPlayer(state, "mason", "mason", "alive");
    state.players[id("wolf")]!.phaseState = {
      phaseId: 7 as never,
      vote: { type: "player", targetId: id("seer") },
    };
    state.players[id("seer")]!.phaseState = {
      phaseId: 7 as never,
      vote: { type: "player", targetId: id("hunter") },
    };
    state.players[id("hunter")]!.phaseState = {
      phaseId: 7 as never,
      vote: { type: "player", targetId: id("seer") },
    };
    // Mason abstains: no pseudo-target, and targets nobody voted for stay omitted.
    state.players[id("mason")]!.phaseState = {
      phaseId: 7 as never,
      vote: { type: "abstain" },
    };
    const snapshot = projectSnapshot(state, id("seer"));
    expect(snapshot.voteTallies).toEqual([
      { targetId: id("seer"), count: 2 },
      { targetId: id("hunter"), count: 1 },
    ]);
  });

  test("voteTallies never expose voter identities", () => {
    const state = votingState();
    addPlayer(state, "hunter", "villager", "alive");
    state.players[id("wolf")]!.phaseState = {
      phaseId: 7 as never,
      vote: { type: "player", targetId: id("seer") },
    };
    state.players[id("seer")]!.phaseState = { phaseId: 7 as never, vote: { type: "abstain" } };
    state.players[id("hunter")]!.phaseState = { phaseId: 7 as never, vote: { type: "abstain" } };
    const snapshot = projectSnapshot(state, id("seer"));
    expect(snapshot.voteTallies).toEqual([{ targetId: id("seer"), count: 1 }]);
    const serialized = JSON.stringify(snapshot.voteTallies);
    expect(serialized).not.toContain(id("wolf"));
    expect(serialized).not.toContain(id("hunter"));
  });

  test("voteTallies is absent outside a voting phase", () => {
    const snapshot = projectSnapshot(makeState(), id("seer"));
    expect(snapshot).not.toHaveProperty("voteTallies");
  });
});

describe("readiness projection", () => {
  test("the snapshot no longer carries progress", () => {
    const snapshot = projectSnapshot(makeState(), id("seer"));
    expect(snapshot).not.toHaveProperty("progress");
  });

  test("me.ready reflects the viewer's own flag and others' readiness appears nowhere", () => {
    const state = makeState();
    state.players[id("seer")]!.phaseState = { phaseId: 1 as never, ready: true };
    state.players[id("wolf")]!.phaseState = { phaseId: 1 as never, ready: true };
    const snapshot = projectSnapshot(state, id("seer"));
    expect(snapshot.me?.ready).toBe(true);
    // No other player's object may carry a ready flag.
    for (const player of snapshot.players) {
      expect(player).not.toHaveProperty("ready");
    }
  });

  test("me.ready is absent when the viewer is not ready", () => {
    const state = makeState();
    state.players[id("seer")]!.phaseState = { phaseId: 1 as never, ready: false };
    const snapshot = projectSnapshot(state, id("seer"));
    expect(snapshot.me).not.toHaveProperty("ready");
  });

  test("me.ready is absent when the viewer's phaseState is stale", () => {
    const state = makeState();
    state.players[id("seer")]!.phaseState = { phaseId: 0 as never, ready: true };
    const snapshot = projectSnapshot(state, id("seer"));
    expect(snapshot.me).not.toHaveProperty("ready");
  });
});
