// The bot controller's contract with the rest of the server: it goes through
// the ordinary command path, it never acts outside its decision window, and no
// provider behaviour can wedge a match.

import { describe, expect, test } from "bun:test";
import type { GameId, UserId } from "@werewolf/protocol";
import { CoordinatorError } from "../game/coordinator.ts";
import { GatedBotAgent, RecordingBotAgent, setupBots, testBotConfig, waitFor } from "./fixtures.ts";
import type { BotAgent, BotDecision } from "./types.ts";

const voteFirst = (input: Parameters<BotAgent["decide"]>[0]): BotDecision => {
  const vote = input.legalActions.find((action) => action.command.type === "vote.set");
  return { actionId: vote?.id ?? null, say: null, channel: null };
};

describe("bot command path", () => {
  test("a bot's vote lands through the same path a human's does", async () => {
    const agent = new RecordingBotAgent(voteFirst);
    const harness = await setupBots({ agent });
    const gameId = await harness.startBotGame(5);
    await harness.advancePhase(gameId); // discussion -> voting

    const state = await harness.state(gameId);
    const voters = Object.values(state.players).filter(
      (player) => player.status === "alive" && player.phaseState.vote?.type === "player",
    );
    expect(voters.length).toBe(
      Object.values(state.players).filter((player) => player.status === "alive").length,
    );
    // The intent is stored on the phase currently in progress, exactly as the
    // HTTP command route would have stored it.
    for (const voter of voters) expect(voter.phaseState.phaseId).toBe(state.phase!.id);
  });

  test("a bot readies once its last turn of the phase is spent", async () => {
    // One turn per phase, so the bot's first decision is also its last and it
    // readies immediately.
    const agent = new RecordingBotAgent(voteFirst);
    const harness = await setupBots({ agent, config: testBotConfig({ BOT_CHAT_TURNS: "1" }) });
    const gameId = await harness.startBotGame(5);
    await harness.advancePhase(gameId); // discussion -> voting

    const state = await harness.state(gameId);
    const living = Object.values(state.players).filter((player) => player.status === "alive");
    expect(living.length).toBeGreaterThan(0);
    // Every living bot readied for the current phase, even though the vote was
    // the only thing the model was asked to choose.
    for (const player of living) {
      expect(player.phaseState.phaseId).toBe(state.phase!.id);
      expect(player.phaseState.ready).toBe(true);
    }
  });

  test("a bot with a reply turn still owed does not ready yet", async () => {
    // Two turns per phase: after the first decision the bot may still be asked
    // to reply, so readying now would end the phase before it ever could.
    // Holding back is what keeps a discussion a discussion.
    const agent = new RecordingBotAgent(voteFirst);
    const harness = await setupBots({ agent, config: testBotConfig({ BOT_CHAT_TURNS: "2" }) });
    const gameId = await harness.startBotGame(5);
    await harness.advancePhase(gameId); // discussion -> voting

    const state = await harness.state(gameId);
    const living = Object.values(state.players).filter((player) => player.status === "alive");
    expect(living.length).toBeGreaterThan(0);
    expect(living.every((player) => player.phaseState.ready === true)).toBe(false);
  });

  test("a bot whose response is stale does NOT send a ready", async () => {
    const agent = new GatedBotAgent(
      (input) => input.phase === "night",
      (input) => ({ actionId: input.legalActions[0]?.id ?? null, say: null, channel: null }),
    );
    const harness = await setupBots({ agent });
    const gameId = await harness.startBotGame(6);
    await harness.advancePhase(gameId); // -> voting
    const voting = await harness.state(gameId);
    harness.clock.now = voting.phase!.endsAt;
    await harness.coordinator.resolvePhase(gameId);
    await waitFor(() => agent.gated.length > 0, "a night decision to start");

    const night = await harness.state(gameId);
    const nightPhaseId = night.phase!.id;
    expect(night.phase!.type).toBe("night");

    // The night runs out and resolves while the model is still thinking.
    harness.clock.now = night.phase!.endsAt;
    await harness.coordinator.resolvePhase(gameId);
    const after = await harness.state(gameId);
    expect(after.phase!.id).not.toBe(nightPhaseId);

    // Now the answers come back, stale.
    agent.releaseAll();
    await harness.bots.whenIdle();

    // No ready was written for the phase that has already been resolved.
    const settled = await harness.state(gameId);
    for (const player of Object.values(settled.players))
      expect(player.phaseState.phaseId === nightPhaseId && player.phaseState.ready === true).toBe(
        false,
      );
  });

  test("a bot seat has no privileged route into the engine", async () => {
    const harness = await setupBots({ agent: new RecordingBotAgent() });
    const gameId = await harness.startBotGame(5);
    const state = await harness.state(gameId);
    const villager = Object.values(state.players).find((player) => player.faction === "village")!;

    // The command a malicious model would want: a village seat calling the
    // wolf attack. It goes through executeCommand like everything else, and
    // is refused there.
    await expect(
      harness.coordinator.executeCommand(gameId, villager.id, {
        commandId: "forged",
        phaseId: state.phase!.id,
        type: "night.action.set",
        payload: { action: "wolf.attack", targetId: state.ownerUserId },
      }),
    ).rejects.toBeInstanceOf(CoordinatorError);
  });

  test("an action the model was never offered is never submitted", async () => {
    const agent = new RecordingBotAgent(() => ({ actionId: 9999, say: null, channel: null }));
    const harness = await setupBots({ agent });
    const gameId = await harness.startBotGame(5);
    await harness.advancePhase(gameId); // into voting

    const state = await harness.state(gameId);
    const voted = Object.values(state.players).filter(
      (player) => player.phaseState.phaseId === state.phase!.id && player.phaseState.vote,
    );
    expect(voted).toEqual([]);
  });

  test("one decision per bot per voting phase, however many commits land", async () => {
    const agent = new RecordingBotAgent(voteFirst);
    const harness = await setupBots({ agent });
    const gameId = await harness.startBotGame(5);
    await harness.advancePhase(gameId);

    const votingCalls = agent.inputs.filter((input) => input.phase === "voting");
    const perPlayer = new Map<UserId, number>();
    for (const input of votingCalls)
      perPlayer.set(input.playerId, (perPlayer.get(input.playerId) ?? 0) + 1);
    // Six seats each vote; each of those commits wakes the manager again, and
    // none of them earns anyone a second call.
    expect(votingCalls.length).toBe(6);
    for (const count of perPlayer.values()) expect(count).toBe(1);
  });

  test("discussion turns are capped, so a chat cascade terminates", async () => {
    const agent = new RecordingBotAgent((input) =>
      input.phase === "discussion"
        ? { actionId: null, say: "I have my suspicions.", channel: "public" }
        : { actionId: null, say: null, channel: null },
    );
    const harness = await setupBots({
      agent,
      config: testBotConfig({ BOT_CHAT_TURNS: "2" }),
    });
    const gameId = await harness.startBotGame(5);

    const perPlayer = new Map<UserId, number>();
    for (const input of agent.inputs.filter((entry) => entry.phase === "discussion"))
      perPlayer.set(input.playerId, (perPlayer.get(input.playerId) ?? 0) + 1);
    expect(perPlayer.size).toBe(6);
    for (const count of perPlayer.values()) expect(count).toBeLessThanOrEqual(2);
    // And everyone actually got to speak, rather than the cap silencing them.
    const events = await harness.coordinator.getVisibleEvents(gameId, 0);
    expect(events.filter((event) => event.kind === "chat.message").length).toBeGreaterThan(0);
  });

  test("a bot answers a chat message during voting, under the same cap", async () => {
    const agent = new RecordingBotAgent((input) =>
      input.phase === "voting"
        ? { actionId: null, say: "I have my suspicions.", channel: "public" }
        : { actionId: null, say: null, channel: null },
    );
    const harness = await setupBots({
      agent,
      config: testBotConfig({ BOT_CHAT_TURNS: "2" }),
    });
    const gameId = await harness.startBotGame(5);
    await harness.advancePhase(gameId); // discussion -> voting

    const perPlayer = new Map<UserId, number>();
    for (const input of agent.inputs.filter((entry) => entry.phase === "voting"))
      perPlayer.set(input.playerId, (perPlayer.get(input.playerId) ?? 0) + 1);
    // A reply is earned for what somebody said during voting too, not just
    // during discussion: at least one seat got a second voting decision.
    expect([...perPlayer.values()].some((count) => count > 1)).toBe(true);
    // ...but the same per-phase cap still terminates the cascade.
    for (const count of perPlayer.values()) expect(count).toBeLessThanOrEqual(2);
    // And the replies were actual messages, not just extra model calls.
    const events = await harness.coordinator.getVisibleEvents(gameId, 0);
    expect(events.filter((event) => event.kind === "chat.message").length).toBeGreaterThan(0);
  });

  test("a response that arrives after the phase moved on is discarded", async () => {
    // Only night decisions block, so the game can be driven into the night
    // with an outstanding call still in flight.
    const agent = new GatedBotAgent(
      (input) => input.phase === "night",
      (input) => ({ actionId: input.legalActions[0]?.id ?? null, say: null, channel: null }),
    );
    const harness = await setupBots({ agent });
    const gameId = await harness.startBotGame(6);
    await harness.advancePhase(gameId); // -> voting
    // Into the night without waiting for the bots: their calls block there,
    // which is the situation under test.
    const voting = await harness.state(gameId);
    harness.clock.now = voting.phase!.endsAt;
    await harness.coordinator.resolvePhase(gameId);
    await waitFor(() => agent.gated.length > 0, "a night decision to start");

    const night = await harness.state(gameId);
    const nightPhaseId = night.phase!.id;
    expect(night.phase!.type).toBe("night");

    // The night runs out and resolves while the model is still thinking.
    harness.clock.now = night.phase!.endsAt;
    await harness.coordinator.resolvePhase(gameId);
    const after = await harness.state(gameId);
    expect(after.phase!.id).not.toBe(nightPhaseId);

    // Now the answers come back.
    agent.releaseAll();
    await harness.bots.whenIdle();

    // Nothing was written for the phase that has already been resolved.
    const settled = await harness.state(gameId);
    for (const player of Object.values(settled.players))
      expect(
        player.phaseState.phaseId === nightPhaseId &&
          Object.keys(player.phaseState.actions ?? {}).length > 0,
      ).toBe(false);
    expect(harness.logs.some((entry) => entry.fields.reason === "stale_response")).toBe(true);
  });

  test("a duplicated chat submission produces exactly one message", async () => {
    const agent = new RecordingBotAgent(() => ({
      actionId: null,
      say: "Morning, all.",
      channel: "public",
    }));
    const harness = await setupBots({
      agent,
      config: testBotConfig({ BOT_CHAT_TURNS: "1" }),
    });
    const gameId = await harness.startBotGame(5);

    const state = await harness.state(gameId);
    const speaker = Object.values(state.players)[0]!;
    // Replaying the very first decision window: the command id is derived from
    // it, so the repository's idempotency rejects the second insert.
    const decisionId = `${gameId}:${speaker.id}:${state.phase!.id}:0`;
    await harness.coordinator.executeCommand(gameId, speaker.id, {
      commandId: `${decisionId}:say`,
      phaseId: state.phase!.id,
      type: "chat.send",
      payload: { channel: "public", text: "Morning, all." },
    });

    const messages = (await harness.coordinator.getVisibleEvents(gameId, 0)).filter(
      (event) => event.kind === "chat.message" && event.actorUserId === speaker.id,
    );
    expect(messages.length).toBe(1);
  });

  test("model calls are capped, so a full room cannot stampede the provider", async () => {
    let inFlight = 0;
    let peak = 0;
    const agent: BotAgent = {
      decide: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return { actionId: null, say: null, channel: null };
      },
    };
    const harness = await setupBots({
      agent,
      config: testBotConfig({ BOT_MAX_CONCURRENT_CALLS: "2" }),
    });
    // Eight seats all want to decide the moment the phase opens.
    await harness.startBotGame(7);
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(0);
  });

  test("an agent that always throws leaves the match playable", async () => {
    const broken: BotAgent = { decide: () => Promise.reject(new Error("provider down")) };
    const harness = await setupBots({ agent: broken });
    const gameId: GameId = await harness.startBotGame(5);

    for (let step = 0; step < 6; step += 1) await harness.advancePhase(gameId);

    const state = await harness.state(gameId);
    // No bot ever acted, so the game proceeds on its clock alone — which is
    // exactly the rule: phases end on time, not on completion.
    expect(["running", "finished"]).toContain(state.status);
    expect(harness.logs.some((entry) => entry.event === "error")).toBe(true);
  });
});
