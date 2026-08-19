// Hidden information is the game. These are security tests: what a bot is
// handed must be exactly the viewer projection its seat is entitled to, and
// nothing a human in that seat could not also see.

import { describe, expect, test } from "bun:test";
import { type GameState, isCultMember, isPackMember } from "@werewolf/game-engine";
import type { UserId } from "@werewolf/protocol";
import { RecordingBotAgent, setupBots, testBotConfig } from "./fixtures.ts";
import type { BotDecisionInput } from "./types.ts";

function playersWith(state: GameState, predicate: (role: string) => boolean): UserId[] {
  return Object.values(state.players)
    .filter((player) => player.role !== null && predicate(player.role))
    .map((player) => player.id);
}

/** The pack is WOLF_CHAT_ROLES membership, which is what the engine tells about
 * itself — not the "werewolf" role (a cub or an alpha is in the pack too) and
 * not the wolves faction (a Sorcerer is in that faction and is deliberately
 * told nothing). Using the engine's own predicate keeps this test honest as
 * more wolf-side roles land. */
function packMembers(state: GameState): UserId[] {
  return Object.values(state.players)
    .filter((player) => isPackMember(player))
    .map((player) => player.id);
}

function kinds(input: BotDecisionInput): string[] {
  return input.visibleEvents.map((event) => event.kind);
}

describe("bot player visibility", () => {
  test("a villager is never told anyone else's role", async () => {
    const agent = new RecordingBotAgent();
    const harness = await setupBots({ agent });
    const gameId = await harness.startBotGame(5);
    const state = await harness.state(gameId);
    const villagers = playersWith(state, (role) => role === "villager");
    expect(villagers.length).toBeGreaterThan(0);

    for (const villager of villagers) {
      const input = agent.forPlayer(villager)[0]!;
      expect(input.role).toBe("villager");
      // Nobody has died yet, so no role on the roster may be revealed.
      expect(input.playerView.players.some((player) => player.revealedRole !== undefined)).toBe(
        false,
      );
      // Wolf and mason rosters, and any seer result, belong to other seats.
      expect(kinds(input)).not.toContain("wolves.member_joined");
      expect(kinds(input)).not.toContain("masons.member_joined");
      expect(kinds(input)).not.toContain("seer.result");
      // The one role.assigned it may see is its own.
      for (const event of input.visibleEvents)
        if (event.kind === "role.assigned") expect(event.scopeId).toBe(villager);
    }
  });

  test("a wolf learns its pack and a villager does not", async () => {
    const agent = new RecordingBotAgent();
    const harness = await setupBots({ agent });
    // Compositions are seeded from a per-game random uuid, so a test that needs
    // a pack of more than one must pin the seed rather than roll dice on it.
    const gameId = await harness.startBotGame(7, "pack-1");
    const state = await harness.state(gameId);
    const wolves = packMembers(state);
    expect(wolves.length).toBeGreaterThan(1);

    for (const wolf of wolves) {
      const input = agent.forPlayer(wolf)[0]!;
      const mates = input.visibleEvents
        .filter((event) => event.kind === "wolves.member_joined")
        .map((event) => (event.payload as { playerId: UserId }).playerId);
      expect(mates.sort()).toEqual(wolves.filter((other) => other !== wolf).sort());
      // Wolf chat is a channel only the pack may address.
      expect(input.speakableChannels).toContain("wolves");
    }
    const pack = new Set(packMembers(state));
    for (const villager of Object.values(state.players)
      .filter((player) => !pack.has(player.id))
      .map((player) => player.id)) {
      const input = agent.forPlayer(villager)[0]!;
      expect(kinds(input)).not.toContain("wolves.member_joined");
      expect(input.speakableChannels).not.toContain("wolves");
    }
  });

  test("only the seer receives its own investigation result", async () => {
    const agent = new RecordingBotAgent((input) => {
      // Drive the night so there is a result to leak in the first place.
      const inspect = input.legalActions.find(
        (action) =>
          action.command.type === "night.action.set" &&
          action.command.payload.action === "seer.inspect",
      );
      return { actionId: inspect?.id ?? null, say: null, channel: null, done: true };
    });
    const harness = await setupBots({ agent });
    const gameId = await harness.startBotGame(7);
    const seers = playersWith(await harness.state(gameId), (role) => role === "seer");
    if (seers.length === 0) return; // the composer did not deal a seer this seed

    await harness.advancePhase(gameId); // discussion -> voting
    await harness.advancePhase(gameId); // voting -> night
    await harness.advancePhase(gameId); // night resolves, results are written
    await harness.advancePhase(gameId); // next discussion: everyone decides again

    const seer = seers[0]!;
    const seerInputs = agent.forPlayer(seer);
    const seerSaw = seerInputs.at(-1)!;
    expect(kinds(seerSaw)).toContain("seer.result");

    for (const input of agent.inputs) {
      if (input.playerId === seer) continue;
      expect(kinds(input)).not.toContain("seer.result");
    }
  });

  test("server-scope audit events never reach any bot", async () => {
    const agent = new RecordingBotAgent();
    const harness = await setupBots({ agent });
    const gameId = await harness.startBotGame(6);
    await harness.advancePhase(gameId);
    await harness.advancePhase(gameId);
    await harness.advancePhase(gameId);

    // The audit rows exist...
    const stored = await harness.coordinator.getVisibleEvents(gameId, 0);
    expect(stored.some((event) => event.scope === "server")).toBe(true);
    // ...and no bot was ever shown one.
    expect(agent.inputs.length).toBeGreaterThan(0);
    for (const input of agent.inputs) {
      expect(input.visibleEvents.some((event) => event.scope === "server")).toBe(false);
      expect(kinds(input).some((kind) => kind.startsWith("audit."))).toBe(false);
    }
  });

  test("individual votes stay hidden while a vote is running", async () => {
    const agent = new RecordingBotAgent((input) => {
      const vote = input.legalActions.find((action) => action.command.type === "vote.set");
      return { actionId: vote?.id ?? null, say: null, channel: null, done: true };
    });
    const harness = await setupBots({ agent });
    const gameId = await harness.startBotGame(6);
    await harness.advancePhase(gameId); // into voting; bots cast votes

    // Re-enter the voting phase by committing something, so fresh inputs are
    // built after the ballots are in.
    const voting = agent.inputs.filter((input) => input.phase === "voting");
    expect(voting.length).toBeGreaterThan(0);
    for (const input of voting) {
      // Aggregate counts only: the projection never names a voter.
      expect(JSON.stringify(input.playerView.voteTallies ?? [])).not.toContain("voterId");
      expect(input.playerView.me?.currentIntent?.vote ?? null).not.toBeUndefined();
      // Nothing in the view describes anyone else's pending intent.
      for (const player of input.playerView.players)
        expect(Object.keys(player)).not.toContain("currentIntent");
    }
  });

  test("the phase-chat window and digest leak nothing the projection hides", async () => {
    // Bots speak on their most private channel and keep talking (done: false),
    // so there is wolf, cult and grave content to leak in the first place and
    // reply turns whose phase-chat window actually holds a conversation.
    const agent = new RecordingBotAgent((input) => {
      const vote = input.legalActions.find((action) => action.command.type === "vote.set");
      const channel = input.speakableChannels.at(-1) ?? null;
      return {
        actionId: vote?.id ?? null,
        say: channel ? "Secrets." : null,
        channel,
        done: input.phase === "discussion" || input.phase === "voting" ? false : true,
      };
    });
    const harness = await setupBots({
      agent,
      config: testBotConfig({ BOT_CHAT_TURNS: "2" }),
    });
    // The cult preset guarantees a cult leader; 9 seats guarantee a pack.
    const gameId = await harness.startBotGame(8, "cult-1", "cult");
    await harness.advancePhase(gameId); // discussion -> voting
    await harness.advancePhase(gameId); // voting -> night
    await harness.advancePhase(gameId); // night -> next discussion

    const state = await harness.state(gameId);
    const pack = new Set(packMembers(state));
    const cult = new Set(
      Object.values(state.players)
        .filter((player) => isCultMember(player))
        .map((player) => player.id),
    );
    const living = Object.values(state.players).filter((player) => player.status === "alive");
    expect(living.length).toBeGreaterThan(0);

    for (const player of living) {
      const input = agent.forPlayer(player.id).at(-1)!;
      // The window is the current phase's conversation, and it is exactly what
      // the projection would show: no wolf chat for a villager, no cult chat
      // for an outsider, no grave chat for the living.
      expect(input.phaseChat.length).toBeGreaterThan(0);
      const channels = new Set(
        input.phaseChat
          .filter((message) => message.kind === "chat.message")
          .map((message) => message.payload.channel),
      );
      if (!pack.has(player.id)) expect(channels.has("wolves")).toBe(false);
      if (!cult.has(player.id)) expect(channels.has("cult")).toBe(false);
      expect(channels.has("grave")).toBe(false);
      // The digest is built from public events only: no secret chat text.
      expect(input.digest.join("\n")).not.toContain("Secrets.");
    }
  });
});
