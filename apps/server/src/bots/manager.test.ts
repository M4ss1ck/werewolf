// The bot controller's contract with the rest of the server: it goes through
// the ordinary command path, it never acts outside its decision window, and no
// provider behaviour can wedge a match.

import { describe, expect, test } from "bun:test";
import {
  type GameState,
  getLegalCommands,
  getSpeakableChannels,
  isCultMember,
  isPackMember,
  knownMentionTargets,
} from "@werewolf/game-engine";
import type { GameEvent, GameId, GameplayCommand, UserId } from "@werewolf/protocol";
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
  return { actionId: vote?.id ?? null, say: null, channel: null, mentionIds: [], done: false };
};

describe("bot command path", () => {
  test("builds public candidates from known targets with stable numbering", async () => {
    const agent = new RecordingBotAgent();
    const harness = await setupBots({ agent });
    const gameId = await harness.startBotGame(5);
    const state = await harness.state(gameId);
    const first = agent.inputs[0]!;
    const expected = Object.values(state.players)
      .filter(
        (player) =>
          player.id !== first.playerId && (player.status === "alive" || player.status === "dead"),
      )
      .map((player) => player.id)
      .sort();
    expect(first.mentionCandidates.map((candidate) => candidate.userId)).toEqual(expected);
    expect(first.mentionCandidates.map((candidate) => candidate.id)).toEqual(
      expected.map((_userId, index) => index + 1),
    );
    expect(
      first.mentionCandidates.every((candidate) => candidate.channels.join(",") === "public"),
    ).toBe(true);
  });

  test("unions secret candidates by full id and never offers an unknown secret member", async () => {
    const agent = new RecordingBotAgent();
    const harness = await setupBots({ agent });
    const gameId = await harness.startBotGame(8, "pack-1", "cult");
    const state = await harness.state(gameId);
    const secretInputs = agent.inputs.filter((input) => input.speakableChannels.includes("wolves"));
    const packInput = secretInputs.find((input) => isPackMember(state.players[input.playerId]!));
    expect(packInput).toBeDefined();
    const input = packInput!;
    const expectedSecret = knownMentionTargets(state, input.playerId, "wolves")
      .map((target) => target.id)
      .sort();
    const secretCandidates = input.mentionCandidates
      .filter((candidate) => candidate.channels.includes("wolves"))
      .map((candidate) => candidate.userId);
    expect(secretCandidates).toEqual(expectedSecret);
    for (const candidate of input.mentionCandidates) {
      const canonical = [...candidate.channels].sort(
        (left, right) =>
          ["public", "wolves", "grave", "cult"].indexOf(left) -
          ["public", "wolves", "grave", "cult"].indexOf(right),
      );
      expect(candidate.channels).toEqual(canonical);
    }
    const cultInput = agent.inputs.find((entry) => isCultMember(state.players[entry.playerId]!));
    if (cultInput && cultInput.speakableChannels.includes("cult")) {
      expect(
        cultInput.mentionCandidates
          .filter((candidate) => candidate.channels.includes("cult"))
          .map((candidate) => candidate.userId),
      ).toEqual(
        knownMentionTargets(state, cultInput.playerId, "cult")
          .map((target) => target.id)
          .sort(),
      );
    }
  });

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
      mentionIds: [],
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
      mentionIds: [],
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
      mentionIds: [],
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
        ? {
            actionId: null,
            say: "I have my suspicions.",
            channel: "public",
            mentionIds: [],
            done: false,
          }
        : { actionId: null, say: null, channel: null, mentionIds: [], done: false },
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

  test("a structured direct mention supplies a follow-up turn", async () => {
    const agent = new RecordingBotAgent(() => ({
      actionId: null,
      say: null,
      channel: null,
      mentionIds: [],
      done: false,
    }));
    const harness = await setupBots({ agent, config: testBotConfig({ BOT_CHAT_TURNS: "2" }) });
    const gameId = await harness.startBotGame(5);
    const state = await harness.state(gameId);
    expect(state.phase?.type).toBe("discussion");
    const bots = Object.values(state.players).filter(
      (player) => player.status === "alive" && player.controller?.type === "bot",
    );
    const speaker = bots[0]!;
    const target = bots[1]!;
    const text = `@${target.displayName} answer me`;
    await harness.coordinator.executeCommand(gameId, speaker.id, {
      commandId: "direct-mention",
      phaseId: state.phase!.id,
      type: "chat.send",
      payload: {
        channel: "public",
        text,
        mentions: [{ userId: target.id, start: 0, length: target.displayName!.length + 1 }],
      },
    });
    await harness.bots.whenIdle();
    const followUp = agent.forPlayer(target.id).at(-1)!;
    expect(followUp.directMentions).toHaveLength(1);
    expect(followUp.directMentions[0]!.payload).toMatchObject({ text });
  });

  test("captures in-flight direct mentions, coalesces newest messages, and waits for one follow-up", async () => {
    let hold = false;
    let targetId: UserId | null = null;
    const agent = new GatedBotAgent(
      (input) => hold && input.phase === "discussion" && input.playerId === targetId,
      () => ({ actionId: null, say: null, channel: null, mentionIds: [], done: false }),
    );
    const harness = await setupBots({
      agent,
      config: testBotConfig({ BOT_CHAT_TURNS: "3", BOT_PHASE_CHAT_LIMIT: "2" }),
    });
    const gameId = await harness.startBotGame(5);
    const initial = await harness.state(gameId);
    const bots = Object.values(initial.players).filter(
      (player) => player.status === "alive" && player.controller?.type === "bot",
    );
    const speaker = bots[0]!;
    const target = bots[1]!;
    targetId = target.id;
    hold = true;

    await harness.coordinator.executeCommand(gameId, speaker.id, {
      commandId: "start-in-flight",
      phaseId: initial.phase!.id,
      type: "chat.send",
      payload: { channel: "public", text: "ordinary", mentions: [] },
    });
    await waitFor(
      () => agent.gated.some((input) => input.playerId === target.id),
      "target in-flight",
    );
    const forTarget = () => agent.inputs.filter((input) => input.playerId === target.id);
    const beforeFollowUp = forTarget().length;
    const mention = (text: string) =>
      harness.coordinator.executeCommand(gameId, speaker.id, {
        commandId: `mention-${text}`,
        phaseId: initial.phase!.id,
        type: "chat.send",
        payload: {
          channel: "public",
          text: `@${target.displayName} ${text}`,
          mentions: [{ userId: target.id, start: 0, length: target.displayName!.length + 1 }],
        },
      });
    await mention("one");
    await mention("two");
    await mention("three");
    hold = false;
    agent.releaseAll();
    await harness.bots.whenIdle();

    const targetInputs = forTarget();
    expect(targetInputs.length).toBe(beforeFollowUp + 1);
    const followUp = targetInputs.at(-1)!;
    expect(
      followUp.directMentions.map((event) =>
        event.kind === "chat.message" ? event.payload.text : "",
      ),
    ).toEqual([`@${target.displayName} two`, `@${target.displayName} three`]);
    const settledCount = targetInputs.length;
    await harness.bots.whenIdle();
    expect(forTarget()).toHaveLength(settledCount);
  });

  test("keeps authoritative newest pending mentions across overlapping reactions", async () => {
    let hold = false;
    let targetId: UserId | null = null;
    const agent = new GatedBotAgent(
      (input) => hold && input.phase === "discussion" && input.playerId === targetId,
      () => ({ actionId: null, say: null, channel: null, mentionIds: [], done: false }),
    );
    const harness = await setupBots({
      agent,
      config: testBotConfig({ BOT_CHAT_TURNS: "3", BOT_PHASE_CHAT_LIMIT: "2" }),
    });
    const gameId = await harness.startBotGame(5);
    const initial = await harness.state(gameId);
    const bots = Object.values(initial.players).filter(
      (player) => player.status === "alive" && player.controller?.type === "bot",
    );
    const speaker = bots[0]!;
    const target = bots[1]!;
    targetId = target.id;
    hold = true;
    const initialCalls = agent.inputs.length;

    await harness.coordinator.executeCommand(gameId, speaker.id, {
      commandId: "overlap-start-in-flight",
      phaseId: initial.phase!.id,
      type: "chat.send",
      payload: { channel: "public", text: "ordinary", mentions: [] },
    });
    await waitFor(
      () => agent.gated.some((input) => input.playerId === target.id),
      "target in-flight",
    );
    await waitFor(
      () => agent.inputs.length >= initialCalls + bots.length - 1,
      "ordinary reactions",
    );
    const beforeFollowUp = agent.inputs.filter((input) => input.playerId === target.id).length;

    let releaseFirst!: () => void;
    let firstLoadStarted = false;
    let completedLoads = 0;
    const originalLoad = harness.coordinator.loadGameState.bind(harness.coordinator);
    harness.coordinator.loadGameState = async (id) => {
      if (id === gameId && !firstLoadStarted) {
        firstLoadStarted = true;
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      const state = await originalLoad(id);
      if (id === gameId) completedLoads += 1;
      return state;
    };

    const mention = (text: string) =>
      harness.coordinator.executeCommand(gameId, speaker.id, {
        commandId: `overlap-${text}`,
        phaseId: initial.phase!.id,
        type: "chat.send",
        payload: {
          channel: "public",
          text: `@${target.displayName} ${text}`,
          mentions: [{ userId: target.id, start: 0, length: target.displayName!.length + 1 }],
        },
      });

    const first = mention("first");
    await waitFor(() => firstLoadStarted, "first reaction load");
    const second = mention("second");
    await waitFor(() => completedLoads >= 1, "second reaction load");
    const third = mention("third");
    await Promise.all([first, second, third]);

    releaseFirst();
    hold = false;
    agent.releaseAll();
    await harness.bots.whenIdle();

    const targetInputs = agent.inputs.filter((input) => input.playerId === target.id);
    expect(targetInputs).toHaveLength(beforeFollowUp + 1);
    expect(
      targetInputs
        .at(-1)!
        .directMentions.map((event) => (event.kind === "chat.message" ? event.payload.text : "")),
    ).toEqual([`@${target.displayName} second`, `@${target.displayName} third`]);
    const settledCount = targetInputs.length;
    await harness.bots.whenIdle();
    expect(agent.inputs.filter((input) => input.playerId === target.id)).toHaveLength(settledCount);
  });

  test("submits composed ranges with the decision-derived idempotent command id", async () => {
    const agent = new RecordingBotAgent((input) => {
      const candidate = input.mentionCandidates.find((entry) => entry.channels.includes("public"));
      return {
        actionId: null,
        say: "legal speech",
        channel: "public",
        mentionIds: candidate ? [candidate.id] : [],
        done: true,
      };
    });
    const harness = await setupBots({ agent });
    const commands: { userId: UserId; command: GameplayCommand }[] = [];
    const execute = harness.coordinator.executeCommand.bind(harness.coordinator);
    harness.coordinator.executeCommand = async (gameId, userId, command) => {
      commands.push({ userId, command });
      return execute(gameId, userId, command);
    };
    await harness.startBotGame(5);
    const chat = commands.find(({ command }) => command.type === "chat.send");
    expect(chat).toBeDefined();
    const input = agent.inputs.find((entry) => entry.playerId === chat!.userId)!;
    expect(chat!.command.commandId).toBe(`${input.decisionId}:say`);
    if (chat!.command.type !== "chat.send") throw new Error("expected chat command");
    expect(chat!.command.payload.text).toBe(
      "@" + input.mentionCandidates[0]!.displayName + " legal speech",
    );
    expect(chat!.command.payload.mentions).toEqual([
      {
        userId: input.mentionCandidates[0]!.userId,
        start: 0,
        length: input.mentionCandidates[0]!.displayName.length + 1,
      },
    ]);
  });

  test("invalid model mention choices still submit legal speech", async () => {
    const agent = new RecordingBotAgent(() => ({
      actionId: null,
      say: "still legal",
      channel: "public",
      mentionIds: [999, 1000],
      done: true,
    }));
    const harness = await setupBots({ agent });
    const commands: GameplayCommand[] = [];
    const execute = harness.coordinator.executeCommand.bind(harness.coordinator);
    harness.coordinator.executeCommand = async (gameId, userId, command) => {
      commands.push(command);
      return execute(gameId, userId, command);
    };
    await harness.startBotGame(5);
    const chat = commands.find((command) => command.type === "chat.send");
    expect(chat).toMatchObject({
      type: "chat.send",
      payload: { text: "still legal", mentions: [] },
    });
  });

  test("turn cap suppresses pending direct-mention work", async () => {
    const agent = new RecordingBotAgent(() => ({
      actionId: null,
      say: null,
      channel: null,
      mentionIds: [],
      done: false,
    }));
    const harness = await setupBots({ agent, config: testBotConfig({ BOT_CHAT_TURNS: "1" }) });
    const gameId = await harness.startBotGame(5);
    const state = await harness.state(gameId);
    const bots = Object.values(state.players).filter((player) => player.status === "alive");
    const speaker = bots[0]!;
    const target = bots[1]!;
    const before = agent.forPlayer(target.id).length;
    await harness.coordinator.executeCommand(gameId, speaker.id, {
      commandId: "over-cap-mention",
      phaseId: state.phase!.id,
      type: "chat.send",
      payload: {
        channel: "public",
        text: `@${target.displayName} too late`,
        mentions: [{ userId: target.id, start: 0, length: target.displayName!.length + 1 }],
      },
    });
    await harness.bots.whenIdle();
    expect(agent.forPlayer(target.id)).toHaveLength(before);
  });

  test("phase change clears in-flight pending mentions", async () => {
    let hold = false;
    let targetId: UserId | null = null;
    const agent = new GatedBotAgent(
      (input) => hold && input.phase === "discussion" && input.playerId === targetId,
      () => ({ actionId: null, say: null, channel: null, mentionIds: [], done: false }),
    );
    const harness = await setupBots({ agent, config: testBotConfig({ BOT_CHAT_TURNS: "3" }) });
    const gameId = await harness.startBotGame(5);
    const before = await harness.state(gameId);
    const bots = Object.values(before.players).filter((player) => player.status === "alive");
    const speaker = bots[0]!;
    const target = bots[1]!;
    targetId = target.id;
    hold = true;
    await harness.coordinator.executeCommand(gameId, speaker.id, {
      commandId: "phase-race-start",
      phaseId: before.phase!.id,
      type: "chat.send",
      payload: { channel: "public", text: "ordinary", mentions: [] },
    });
    await waitFor(
      () => agent.gated.some((input) => input.playerId === target.id),
      "target in-flight",
    );
    await harness.coordinator.executeCommand(gameId, speaker.id, {
      commandId: "phase-race-mention",
      phaseId: before.phase!.id,
      type: "chat.send",
      payload: {
        channel: "public",
        text: `@${target.displayName} wait`,
        mentions: [{ userId: target.id, start: 0, length: target.displayName!.length + 1 }],
      },
    });
    const beforeRelease = agent.inputs.filter((input) => input.playerId === target.id).length;
    harness.clock.now = before.phase!.endsAt;
    await harness.coordinator.resolvePhase(gameId);
    hold = false;
    agent.releaseAll();
    await harness.bots.whenIdle();
    expect(
      agent.inputs
        .filter((input) => input.playerId === target.id)
        .slice(beforeRelease)
        .every((input) => input.directMentions.length === 0),
    ).toBe(true);
  });

  test("deadline clears pending mentions even if the phase has not resolved yet", async () => {
    let hold = false;
    let targetId: UserId | null = null;
    const agent = new GatedBotAgent(
      (input) => hold && input.phase === "discussion" && input.playerId === targetId,
      () => ({ actionId: null, say: null, channel: null, mentionIds: [], done: false }),
    );
    const harness = await setupBots({ agent, config: testBotConfig({ BOT_CHAT_TURNS: "3" }) });
    const gameId = await harness.startBotGame(5);
    const before = await harness.state(gameId);
    const bots = Object.values(before.players).filter((player) => player.status === "alive");
    const speaker = bots[0]!;
    const target = bots[1]!;
    targetId = target.id;
    hold = true;
    await harness.coordinator.executeCommand(gameId, speaker.id, {
      commandId: "deadline-race-start",
      phaseId: before.phase!.id,
      type: "chat.send",
      payload: { channel: "public", text: "ordinary", mentions: [] },
    });
    await waitFor(
      () => agent.gated.some((input) => input.playerId === target.id),
      "target in-flight",
    );
    await harness.coordinator.executeCommand(gameId, speaker.id, {
      commandId: "deadline-race-mention",
      phaseId: before.phase!.id,
      type: "chat.send",
      payload: {
        channel: "public",
        text: `@${target.displayName} wait`,
        mentions: [{ userId: target.id, start: 0, length: target.displayName!.length + 1 }],
      },
    });
    const beforeRelease = agent.inputs.filter((input) => input.playerId === target.id).length;
    harness.clock.now = before.phase!.endsAt;
    hold = false;
    agent.releaseAll();
    await harness.bots.whenIdle();
    expect(agent.inputs.filter((input) => input.playerId === target.id)).toHaveLength(
      beforeRelease,
    );
  });

  test("a wolf-chat mention at night wakes a pack seat that may speak on the channel", async () => {
    const agent = new RecordingBotAgent((input) => ({
      actionId: input.legalActions[0]?.id ?? null,
      say: null,
      channel: null,
      mentionIds: [],
      done: false,
    }));
    const harness = await setupBots({ agent, config: testBotConfig({ BOT_CHAT_TURNS: "3" }) });
    const gameId = await harness.startBotGame(8, "pack-1", "cult");
    await harness.advancePhase(gameId); // discussion -> voting
    const voting = await harness.state(gameId);
    harness.clock.now = voting.phase!.endsAt;
    await harness.coordinator.resolvePhase(gameId); // voting -> night
    await harness.bots.whenIdle();
    const night = await harness.state(gameId);
    expect(night.phase?.type).toBe("night");
    const nightPack = Object.values(night.players).filter(
      (player) => player.status === "alive" && isPackMember(player),
    );
    expect(nightPack.length).toBeGreaterThanOrEqual(2);
    const speaker = nightPack[0]!;
    const target = nightPack[1]!;
    const before = agent.forPlayer(target.id).length;
    const text = `@${target.displayName} wolf business`;
    expect(knownMentionTargets(night, speaker.id, "wolves").map((player) => player.id)).toContain(
      target.id,
    );
    await harness.coordinator.executeCommand(gameId, speaker.id, {
      commandId: "night-structured-mention",
      phaseId: night.phase!.id,
      type: "chat.send",
      payload: {
        channel: "wolves",
        text,
        mentions: [{ userId: target.id, start: 0, length: target.displayName!.length + 1 }],
      },
    });
    await harness.bots.whenIdle();
    const targetInputs = agent.forPlayer(target.id);
    expect(targetInputs).toHaveLength(before + 1);
    const followUp = targetInputs.at(-1)!;
    expect(followUp.directMentions).toHaveLength(1);
    expect(followUp.directMentions[0]!.payload).toMatchObject({ text });
    const after = await harness.state(gameId);
    // Turns remain and the decision did not say done, so the seat holds its
    // ready instead of collapsing the night under the pack's conversation.
    expect(after.players[target.id]!.phaseState.ready === true).toBe(false);
    expect(after.phase?.id).toBe(night.phase!.id);
  });

  test("loss of act and speak work suppresses pending follow-up", async () => {
    let hold = false;
    let targetId: UserId | null = null;
    const agent = new GatedBotAgent(
      (input) => hold && input.phase === "discussion" && input.playerId === targetId,
      () => ({ actionId: null, say: null, channel: null, mentionIds: [], done: false }),
    );
    const harness = await setupBots({ agent, config: testBotConfig({ BOT_CHAT_TURNS: "3" }) });
    const gameId = await harness.startBotGame(5);
    const before = await harness.state(gameId);
    const bots = Object.values(before.players).filter((player) => player.status === "alive");
    const speaker = bots[0]!;
    const target = bots[1]!;
    targetId = target.id;
    hold = true;
    await harness.coordinator.executeCommand(gameId, speaker.id, {
      commandId: "no-work-start",
      phaseId: before.phase!.id,
      type: "chat.send",
      payload: { channel: "public", text: "ordinary", mentions: [] },
    });
    await waitFor(
      () => agent.gated.some((input) => input.playerId === target.id),
      "target in-flight",
    );
    await harness.coordinator.executeCommand(gameId, speaker.id, {
      commandId: "no-work-mention",
      phaseId: before.phase!.id,
      type: "chat.send",
      payload: {
        channel: "public",
        text: `@${target.displayName} wait`,
        mentions: [{ userId: target.id, start: 0, length: target.displayName!.length + 1 }],
      },
    });
    const originalLoad = harness.coordinator.loadGameState.bind(harness.coordinator);
    harness.coordinator.loadGameState = async (id) => {
      const state = await originalLoad(id);
      if (state && id === gameId && state.phase?.id === before.phase!.id)
        state.players[target.id] = { ...state.players[target.id]!, status: "spectator" };
      return state;
    };
    const beforeRelease = agent.inputs.filter((input) => input.playerId === target.id).length;
    hold = false;
    agent.releaseAll();
    await harness.bots.whenIdle();
    expect(agent.inputs.filter((input) => input.playerId === target.id)).toHaveLength(
      beforeRelease,
    );
  });

  test("a dead bot mentioned in grave chat receives no model call", async () => {
    const agent = new RecordingBotAgent((input) => {
      const action = input.legalActions[0];
      return {
        actionId: action?.id ?? null,
        say: null,
        channel: null,
        mentionIds: [],
        done: true,
      };
    });
    const harness = await setupBots({ agent, config: testBotConfig({ BOT_CHAT_TURNS: "1" }) });
    const gameId = await harness.startBotGame(8, "dead-grave-1", "cult");
    let deadBots: GameState["players"][UserId][] = [];
    for (let step = 0; step < 12; step += 1) {
      const state = await harness.state(gameId);
      deadBots = Object.values(state.players).filter(
        (player) => player.status === "dead" && player.controller?.type === "bot",
      );
      if (deadBots.length >= 2 && state.status === "running" && state.phase) break;
      if (state.status !== "running" || !state.phase) break;
      await harness.advancePhase(gameId);
    }
    expect(deadBots.length).toBeGreaterThanOrEqual(2);
    const state = await harness.state(gameId);
    expect(state.status).toBe("running");
    expect(state.phase).not.toBeNull();
    const actor = deadBots[0]!;
    const target = deadBots[1]!;
    const before = agent.inputs.filter((input) => input.playerId === target.id).length;
    await harness.coordinator.executeCommand(gameId, actor.id, {
      commandId: "grave-dead-mention",
      phaseId: state.phase!.id,
      type: "chat.send",
      payload: {
        channel: "grave",
        text: `@${target.displayName} ghost`,
        mentions: [{ userId: target.id, start: 0, length: target.displayName!.length + 1 }],
      },
    });
    await harness.bots.whenIdle();
    expect(agent.inputs.filter((input) => input.playerId === target.id)).toHaveLength(before);
  });

  test("clears a pending structured mention when the in-flight bot dies", async () => {
    let hold = false;
    let targetId: UserId | null = null;
    const agent = new GatedBotAgent(
      (input) => hold && input.phase === "voting" && input.playerId === targetId,
      () => ({ actionId: null, say: null, channel: null, mentionIds: [], done: false }),
    );
    const harness = await setupBots({ agent, config: testBotConfig({ BOT_CHAT_TURNS: "3" }) });
    const gameId = await harness.startBotGame(6, "pending-death-1");
    const discussion = await harness.state(gameId);
    const alive = Object.values(discussion.players).filter((player) => player.status === "alive");
    const target = alive[0]!;
    const speaker = alive[1]!;
    targetId = target.id;
    harness.clock.now = discussion.phase!.endsAt;
    hold = true;
    await harness.coordinator.resolvePhase(gameId); // discussion -> voting
    await waitFor(
      () => agent.gated.some((input) => input.playerId === target.id),
      "voting target in-flight",
    );
    const voting = await harness.state(gameId);
    const text = `@${target.displayName} before death`;
    await harness.coordinator.executeCommand(gameId, speaker.id, {
      commandId: "pending-death-mention",
      phaseId: voting.phase!.id,
      type: "chat.send",
      payload: {
        channel: "public",
        text,
        mentions: [{ userId: target.id, start: 0, length: target.displayName!.length + 1 }],
      },
    });
    const beforeRelease = agent.inputs.filter((input) => input.playerId === target.id).length;
    for (const player of Object.values(voting.players)) {
      if (player.status !== "alive" || player.id === target.id) continue;
      await harness.coordinator.executeCommand(gameId, player.id, {
        commandId: `kill-${player.id}`,
        phaseId: voting.phase!.id,
        type: "vote.set",
        payload: { targetId: target.id },
      });
    }
    harness.clock.now = voting.phase!.endsAt;
    await harness.coordinator.resolvePhase(gameId);
    const dead = await harness.state(gameId);
    expect(dead.players[target.id]!.status).toBe("dead");
    hold = false;
    agent.releaseAll();
    await harness.bots.whenIdle();
    expect(agent.inputs.filter((input) => input.playerId === target.id)).toHaveLength(
      beforeRelease,
    );
  });

  test("a bot answers a chat message during voting, under the same cap", async () => {
    const agent = new RecordingBotAgent((input) =>
      input.phase === "voting"
        ? {
            actionId: null,
            say: "I have my suspicions.",
            channel: "public",
            mentionIds: [],
            done: false,
          }
        : { actionId: null, say: null, channel: null, mentionIds: [], done: false },
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
        ? {
            actionId: null,
            say: "I have my suspicions.",
            channel: "public",
            mentionIds: [],
            done: false,
          }
        : { actionId: null, say: null, channel: null, mentionIds: [], done: true },
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
      mentionIds: [],
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
      payload: { channel: "public", text: "Morning, all.", mentions: [] },
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
        return { actionId: null, say: null, channel: null, mentionIds: [], done: true };
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

describe("night secret-channel chat", () => {
  // A message on a secret channel at night wakes a pack seat that may speak
  // on it; a public message wakes nobody. Each case drives a game to night
  // and sends one message from a pack mate.
  const messageCases = [
    {
      name: "a wolf bot replies to a human wolf-chat message at night",
      channel: "wolves" as const,
      expectFollowUp: true,
    },
    {
      name: "a public-channel event at night wakes nobody",
      channel: "public" as const,
      expectFollowUp: false,
    },
  ];
  for (const c of messageCases) {
    test(c.name, async () => {
      const agent = new RecordingBotAgent((input) =>
        input.phase === "night"
          ? {
              actionId: input.legalActions[0]?.id ?? null,
              say: null,
              channel: null,
              mentionIds: [],
              done: false,
            }
          : { actionId: null, say: null, channel: null, mentionIds: [], done: false },
      );
      const harness = await setupBots({ agent, config: testBotConfig({ BOT_CHAT_TURNS: "3" }) });
      const gameId = await harness.startBotGame(8, "pack-1", "cult");
      await harness.advancePhase(gameId); // discussion -> voting
      const voting = await harness.state(gameId);
      harness.clock.now = voting.phase!.endsAt;
      await harness.coordinator.resolvePhase(gameId); // voting -> night
      await harness.bots.whenIdle();
      const night = await harness.state(gameId);
      expect(night.phase?.type).toBe("night");
      const nightPack = Object.values(night.players).filter(
        (player) => player.status === "alive" && isPackMember(player),
      );
      expect(nightPack.length).toBeGreaterThanOrEqual(2);
      const speaker = nightPack[0]!;
      const target = nightPack[1]!;
      const before = agent.forPlayer(target.id).length;
      const send = harness.coordinator.executeCommand(gameId, speaker.id, {
        commandId: `night-${c.channel}`,
        phaseId: night.phase!.id,
        type: "chat.send",
        payload: { channel: c.channel, text: "Who do we take?", mentions: [] },
      });
      if (c.channel === "public") {
        // Public chat is closed at night, so the engine refuses the message
        // before any event exists to wake a seat.
        await expect(send).rejects.toBeInstanceOf(CoordinatorError);
      } else {
        await send;
      }
      await harness.bots.whenIdle();
      expect(agent.forPlayer(target.id).length).toBe(c.expectFollowUp ? before + 1 : before);
    });
  }

  test("a villager bot at night still takes exactly one turn and readies", async () => {
    const agent = new RecordingBotAgent((input) => ({
      actionId: input.legalActions[0]?.id ?? null,
      say: null,
      channel: null,
      mentionIds: [],
      done: false,
    }));
    const harness = await setupBots({ agent, config: testBotConfig({ BOT_CHAT_TURNS: "3" }) });
    const gameId = await harness.startBotGame(8, "pack-1", "cult");
    await harness.advancePhase(gameId); // discussion -> voting
    const voting = await harness.state(gameId);
    harness.clock.now = voting.phase!.endsAt;
    await harness.coordinator.resolvePhase(gameId); // voting -> night
    await harness.bots.whenIdle();
    const night = await harness.state(gameId);
    expect(night.phase?.type).toBe("night");
    // A seat with a night action but no secret channel: its first decision is
    // still its last, and it readies — the night-chat change only touches
    // seats that can speak on a secret channel.
    const lone = Object.values(night.players).find(
      (player) =>
        player.status === "alive" &&
        player.controller?.type === "bot" &&
        getLegalCommands(night, player.id, harness.clock.now).length > 0 &&
        !getSpeakableChannels(night, player.id, harness.clock.now).includes("wolves") &&
        !getSpeakableChannels(night, player.id, harness.clock.now).includes("cult"),
    );
    expect(lone).toBeDefined();
    const nightInputs = agent.forPlayer(lone!.id).filter((input) => input.phase === "night");
    expect(nightInputs).toHaveLength(1);
    expect(night.players[lone!.id]!.phaseState.ready === true).toBe(true);
  });

  test("a wolf bot does not exceed BOT_CHAT_TURNS at night", async () => {
    // Chat only, no action: a decision then commits exactly one command, so
    // the reply cascade is deterministic instead of racing the action commit.
    const agent = new RecordingBotAgent((input) =>
      input.phase === "night"
        ? {
            actionId: null,
            say: "Understood.",
            channel: "wolves",
            mentionIds: [],
            done: false,
          }
        : { actionId: null, say: null, channel: null, mentionIds: [], done: false },
    );
    const harness = await setupBots({ agent, config: testBotConfig({ BOT_CHAT_TURNS: "2" }) });
    const gameId = await harness.startBotGame(8, "pack-1", "cult");
    await harness.advancePhase(gameId); // discussion -> voting
    const voting = await harness.state(gameId);
    harness.clock.now = voting.phase!.endsAt;
    await harness.coordinator.resolvePhase(gameId); // voting -> night
    await harness.bots.whenIdle();
    const night = await harness.state(gameId);
    expect(night.phase?.type).toBe("night");
    const nightPack = Object.values(night.players).filter(
      (player) => player.status === "alive" && isPackMember(player),
    );
    expect(nightPack.length).toBeGreaterThanOrEqual(2);
    const counts = nightPack.map(
      (wolf) => agent.forPlayer(wolf.id).filter((input) => input.phase === "night").length,
    );
    // The cap terminates the night cascade, and the cascade actually happened:
    // at least one seat earned a reply turn.
    for (const count of counts) expect(count).toBeLessThanOrEqual(2);
    expect(counts.some((count) => count > 1)).toBe(true);
  });

  test("a wolf bot does not ready after its first night turn while turns remain, and does ready when its decision says done", async () => {
    const cases = [
      { done: false, expectReady: false },
      { done: true, expectReady: true },
    ];
    for (const c of cases) {
      const agent = new RecordingBotAgent((input) => ({
        actionId: input.legalActions[0]?.id ?? null,
        say: null,
        channel: null,
        mentionIds: [],
        done: c.done,
      }));
      const harness = await setupBots({ agent, config: testBotConfig({ BOT_CHAT_TURNS: "3" }) });
      const gameId = await harness.startBotGame(8, "pack-1", "cult");
      await harness.advancePhase(gameId); // discussion -> voting
      const voting = await harness.state(gameId);
      harness.clock.now = voting.phase!.endsAt;
      await harness.coordinator.resolvePhase(gameId); // voting -> night
      await harness.bots.whenIdle();
      const night = await harness.state(gameId);
      expect(night.phase?.type).toBe("night");
      const wolf = Object.values(night.players).find(
        (player) => player.status === "alive" && isPackMember(player),
      )!;
      expect(wolf).toBeDefined();
      expect(wolf.phaseState.ready === true).toBe(c.expectReady);
    }
  });

  test("a wolf-chat mention that lands while a pack seat is in flight is delivered once the decision settles", async () => {
    let hold = false;
    let targetId: UserId | null = null;
    const agent = new GatedBotAgent(
      (input) => hold && input.phase === "night" && input.playerId === targetId,
      (input) => ({
        actionId: input.legalActions[0]?.id ?? null,
        say: null,
        channel: null,
        mentionIds: [],
        done: false,
      }),
    );
    const harness = await setupBots({ agent, config: testBotConfig({ BOT_CHAT_TURNS: "3" }) });
    const gameId = await harness.startBotGame(8, "pack-1", "cult");
    await harness.advancePhase(gameId); // discussion -> voting
    const voting = await harness.state(gameId);
    const pack = Object.values(voting.players).filter(
      (player) => player.status === "alive" && isPackMember(player),
    );
    expect(pack.length).toBeGreaterThanOrEqual(2);
    hold = true;
    targetId = pack[0]!.id;
    harness.clock.now = voting.phase!.endsAt;
    await harness.coordinator.resolvePhase(gameId); // voting -> night
    const night = await harness.state(gameId);
    await waitFor(
      () => agent.gated.some((input) => input.playerId === targetId),
      "night target in-flight",
    );
    expect(night.phase?.type).toBe("night");
    const target = night.players[targetId]!;
    const nightPack = Object.values(night.players).filter(
      (player) => player.status === "alive" && isPackMember(player),
    );
    const speaker = nightPack.find((player) => player.id !== targetId)!;
    expect(speaker).toBeDefined();
    const before = agent.inputs.filter((input) => input.playerId === targetId).length;
    const text = `@${target.displayName} wolf business`;
    expect(knownMentionTargets(night, speaker.id, "wolves").map((player) => player.id)).toContain(
      targetId,
    );
    await harness.coordinator.executeCommand(gameId, speaker.id, {
      commandId: "night-in-flight-mention",
      phaseId: night.phase!.id,
      type: "chat.send",
      payload: {
        channel: "wolves",
        text,
        mentions: [{ userId: targetId, start: 0, length: target.displayName!.length + 1 }],
      },
    });
    hold = false;
    agent.releaseAll();
    await harness.bots.whenIdle();
    const targetInputs = agent.inputs.filter((input) => input.playerId === targetId);
    expect(targetInputs).toHaveLength(before + 1);
    const followUp = targetInputs.at(-1)!;
    expect(followUp.directMentions).toHaveLength(1);
    expect(followUp.directMentions[0]!.payload).toMatchObject({ text });
  });
});
