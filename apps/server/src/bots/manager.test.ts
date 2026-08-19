// The bot controller's contract with the rest of the server: it goes through
// the ordinary command path, it never acts outside its decision window, and no
// provider behaviour can wedge a match.

import { describe, expect, test } from "bun:test";
import type { GameEvent, GameId, UserId } from "@werewolf/protocol";
import { CoordinatorError } from "../game/coordinator.ts";
import { LlmBotAgent } from "./agent.ts";
import {
  FakeModelProvider,
  GatedBotAgent,
  RecordingBotAgent,
  setupBots,
  testBotConfig,
  waitFor,
} from "./fixtures.ts";
import type { BotAgent, BotDecision } from "./types.ts";

const voteFirst = (input: Parameters<BotAgent["decide"]>[0]): BotDecision => {
  const vote = input.legalActions.find((action) => action.command.type === "vote.set");
  return { actionId: vote?.id ?? null, say: null, channel: null, done: false };
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

  test("a bot that says done readies immediately, even with turns left", async () => {
    const agent = new RecordingBotAgent(() => ({
      actionId: null,
      say: null,
      channel: null,
      done: true,
    }));
    const harness = await setupBots({ agent, config: testBotConfig({ BOT_CHAT_TURNS: "6" }) });
    const gameId = await harness.startBotGame(5);
    await harness.advancePhase(gameId); // discussion -> voting

    const state = await harness.state(gameId);
    const living = Object.values(state.players).filter((player) => player.status === "alive");
    expect(living.length).toBeGreaterThan(0);
    for (const player of living) {
      expect(player.phaseState.phaseId).toBe(state.phase!.id);
      expect(player.phaseState.ready).toBe(true);
    }
  });

  test("a bot that says done: false with budget remaining does not ready", async () => {
    const agent = new RecordingBotAgent(() => ({
      actionId: null,
      say: null,
      channel: null,
      done: false,
    }));
    const harness = await setupBots({ agent, config: testBotConfig({ BOT_CHAT_TURNS: "6" }) });
    const gameId = await harness.startBotGame(5);
    await harness.advancePhase(gameId); // discussion -> voting

    const state = await harness.state(gameId);
    const living = Object.values(state.players).filter((player) => player.status === "alive");
    expect(living.length).toBeGreaterThan(0);
    expect(living.every((player) => player.phaseState.ready === true)).toBe(false);
  });

  test("a bot that exhausts its turn budget readies even while saying done: false", async () => {
    const agent = new RecordingBotAgent(() => ({
      actionId: null,
      say: null,
      channel: null,
      done: false,
    }));
    const harness = await setupBots({ agent, config: testBotConfig({ BOT_CHAT_TURNS: "1" }) });
    const gameId = await harness.startBotGame(5);
    await harness.advancePhase(gameId); // discussion -> voting

    const state = await harness.state(gameId);
    const living = Object.values(state.players).filter((player) => player.status === "alive");
    expect(living.length).toBeGreaterThan(0);
    for (const player of living) {
      expect(player.phaseState.phaseId).toBe(state.phase!.id);
      expect(player.phaseState.ready).toBe(true);
    }
  });

  test("the random fallback agent readies after its decision", async () => {
    const harness = await setupBots(); // default agent is the fallback
    const gameId = await harness.startBotGame(5);
    await harness.advancePhase(gameId); // discussion -> voting

    const state = await harness.state(gameId);
    const living = Object.values(state.players).filter((player) => player.status === "alive");
    expect(living.length).toBeGreaterThan(0);
    for (const player of living) {
      expect(player.phaseState.phaseId).toBe(state.phase!.id);
      expect(player.phaseState.ready).toBe(true);
    }
  });

  test("a bot whose response is stale does NOT send a ready", async () => {
    const agent = new GatedBotAgent(
      (input) => input.phase === "night",
      (input) => ({
        actionId: input.legalActions[0]?.id ?? null,
        say: null,
        channel: null,
        done: true,
      }),
    );
    const harness = await setupBots({ agent });
    // The seed pins the resolution order so the game reliably reaches the
    // night; a victory landing in voting would leave no night decision to gate.
    const gameId = await harness.startBotGame(6, "stale-1");
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
    const agent = new RecordingBotAgent(() => ({
      actionId: 9999,
      say: null,
      channel: null,
      done: true,
    }));
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
        ? { actionId: null, say: "I have my suspicions.", channel: "public", done: false }
        : { actionId: null, say: null, channel: null, done: false },
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
        ? { actionId: null, say: "I have my suspicions.", channel: "public", done: false }
        : { actionId: null, say: null, channel: null, done: false },
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

  test("the phase-chat window holds the current phase's conversation, capped", async () => {
    const agent = new RecordingBotAgent((input) =>
      input.phase === "discussion" || input.phase === "voting"
        ? { actionId: null, say: "I have my suspicions.", channel: "public", done: false }
        : { actionId: null, say: null, channel: null, done: true },
    );
    const harness = await setupBots({
      agent,
      config: testBotConfig({ BOT_CHAT_TURNS: "6", BOT_PHASE_CHAT_LIMIT: "40" }),
    });
    const gameId = await harness.startBotGame(8); // 9 seats, so >40 messages fit
    await harness.advancePhase(gameId); // discussion -> voting

    const votingInputs = agent.inputs.filter((input) => input.phase === "voting");
    expect(votingInputs.length).toBeGreaterThan(0);
    // The fullest window is the one built last, when the conversation is over.
    const fullest = votingInputs.reduce((best, input) =>
      input.phaseChat.length > best.phaseChat.length ? input : best,
    );
    // Every message is from the current phase, never from the discussion that
    // preceded it.
    expect(fullest.phaseChat.length).toBeGreaterThan(0);
    for (const message of fullest.phaseChat) {
      expect(message.kind).toBe("chat.message");
      expect(message.createdAt).toBeGreaterThanOrEqual(fullest.playerView.game.phase!.startedAt);
    }
    // Capped at the configured limit, and the cap actually binds: more than
    // forty messages were spoken in the voting phase.
    for (const input of votingInputs) expect(input.phaseChat.length).toBeLessThanOrEqual(40);
    expect(fullest.phaseChat.length).toBe(40);
    const events = (await harness.coordinator.getVisibleEvents(gameId, 0)) as GameEvent[];
    const votingStarted = (
      events.find((event) => event.kind === "phase.started" && event.payload.type === "voting")!
        .payload as { startedAt: number }
    ).startedAt;
    const votingChat = events.filter(
      (event) => event.kind === "chat.message" && event.createdAt >= votingStarted,
    );
    expect(votingChat.length).toBeGreaterThan(40);
  });

  test("the digest names vote outcomes and night deaths from earlier days, capped", async () => {
    const agent = new RecordingBotAgent((input) => {
      const vote = input.legalActions.find((action) => action.command.type === "vote.set");
      const night = input.legalActions.find((action) => action.command.type === "night.action.set");
      return { actionId: vote?.id ?? night?.id ?? null, say: null, channel: null, done: true };
    });
    const harness = await setupBots({ agent, config: testBotConfig({ BOT_DIGEST_DAYS: "6" }) });
    // The seed pins the composition and the resolution order, so the game
    // reliably reaches day 2+ and the digest has earlier days to name.
    const gameId = await harness.startBotGame(7, "digest-3");
    for (let step = 0; step < 15; step += 1) {
      const state = await harness.state(gameId);
      if (state.status !== "running") break;
      await harness.advancePhase(gameId);
    }

    // A decision made on day 2 or later, so at least one earlier day exists.
    const late = agent.inputs.filter((input) => input.playerView.game.day >= 2);
    expect(late.length).toBeGreaterThan(0);
    const input = late.at(-1)!;
    expect(input.digest.length).toBeGreaterThan(0);
    expect(input.digest.length).toBeLessThanOrEqual(6);

    // The digest is built from the same public events the bot could see: the
    // names of the voted-out and the night-dead from the days before this
    // decision appear in it.
    const state = await harness.state(gameId);
    const nameOf = (id: UserId) => state.players[id]?.displayName ?? id;
    const events = (await harness.coordinator.getVisibleEvents(gameId, 0)) as GameEvent[];
    const dayOfPhase = (phaseId: number) => Math.floor((phaseId - 1) / 3) + 1;
    const earlierDays = input.playerView.game.day - 1;
    const votedOut = events
      .filter(
        (event) =>
          event.kind === "vote.resolved" &&
          event.payload.eliminated !== null &&
          dayOfPhase(event.payload.phaseId) <= earlierDays,
      )
      .map((event) => nameOf((event.payload as { eliminated: UserId }).eliminated));
    const nightDeaths = events
      .filter((event) => event.kind === "night.resolved")
      .slice(0, earlierDays)
      .flatMap((event) => event.payload.deaths.map(nameOf));
    const digestText = input.digest.join("\n");
    for (const name of votedOut) expect(digestText).toContain(name);
    for (const name of nightDeaths) expect(digestText).toContain(name);
  });

  test("a response that arrives after the phase moved on is discarded", async () => {
    // Only night decisions block, so the game can be driven into the night
    // with an outstanding call still in flight.
    const agent = new GatedBotAgent(
      (input) => input.phase === "night",
      (input) => ({
        actionId: input.legalActions[0]?.id ?? null,
        say: null,
        channel: null,
        done: true,
      }),
    );
    const harness = await setupBots({ agent });
    // The seed pins the resolution order so the game reliably reaches the
    // night; a victory landing in voting would leave no night decision to gate.
    const gameId = await harness.startBotGame(6, "stale-1");
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
      done: true,
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
        return { actionId: null, say: null, channel: null, done: true };
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

  test("a timed-out provider still falls back and the seat still readies", async () => {
    const agent = new LlmBotAgent(new FakeModelProvider([new Error("timeout")]), testBotConfig());
    const harness = await setupBots({ agent });
    const gameId = await harness.startBotGame(5);
    await harness.advancePhase(gameId); // discussion -> voting

    const state = await harness.state(gameId);
    const living = Object.values(state.players).filter((player) => player.status === "alive");
    expect(living.length).toBeGreaterThan(0);
    // The fallback says done, so the seat readies exactly as if the model had.
    for (const player of living) {
      expect(player.phaseState.phaseId).toBe(state.phase!.id);
      expect(player.phaseState.ready).toBe(true);
    }
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
