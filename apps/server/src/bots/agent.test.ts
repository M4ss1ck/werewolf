// Model output is an untrusted suggestion. Every way it can be wrong ends at
// the same small deterministic fallback rather than at a malformed command.

import { describe, expect, test } from "bun:test";
import type { GameId, PhaseId, UserId, ViewerGameSnapshot } from "@werewolf/protocol";
import { FallbackBotAgent, LlmBotAgent } from "./agent.ts";
import { BOT_CONFIG, FakeModelProvider, testBotConfig } from "./fixtures.ts";
import { OpenAiCompatibleProvider } from "./provider-openai.ts";
import { type BotDecisionInput, BotProviderError } from "./types.ts";

/** The fallback picked something, and it was one of the offered ids. */
function expectLegalPick(actionId: number | null) {
  expect(actionId).not.toBeNull();
  expect([0, 1]).toContain(actionId as number);
}

const id = (value: string) => value as UserId;

function input(overrides: Partial<BotDecisionInput> = {}): BotDecisionInput {
  const playerView = {
    game: {
      id: "g" as GameId,
      name: "Village",
      ownerUserId: id("p0"),
      status: "running",
      day: 1,
      phase: { id: 1 as PhaseId, type: "voting", startedAt: 0, endsAt: 60_000 },
      settings: {
        visibility: "public",
        spectatingEnabled: true,
        durations: { discussion: 60, voting: 60, night: 60 },
      },
    },
    players: [
      { userId: id("p0"), displayName: "Mira", status: "alive" },
      { userId: id("p1"), displayName: "Tobias", status: "alive" },
    ],
    availableActions: [],
    availableChannels: ["public"],
    cursor: 0,
    serverNow: 0,
  } as unknown as ViewerGameSnapshot;
  return {
    decisionId: "g:p0:1:0",
    gameId: "g" as GameId,
    playerId: id("p0"),
    phase: "voting",
    phaseId: 1 as PhaseId,
    remainingMs: 30_000,
    role: "villager",
    faction: "village",
    config: BOT_CONFIG,
    playerView,
    visibleEvents: [],
    legalActions: [
      {
        id: 0,
        command: { type: "vote.set", phaseId: 1 as PhaseId, payload: { targetId: id("p1") } },
      },
      { id: 1, command: { type: "vote.abstain", phaseId: 1 as PhaseId, payload: {} } },
    ],
    speakableChannels: ["public"],
    ...overrides,
  };
}

function agentWith(replies: (string | Error)[]) {
  const provider = new FakeModelProvider(replies);
  return { provider, agent: new LlmBotAgent(provider, testBotConfig()) };
}

describe("a seat with no model", () => {
  test("never reaches the provider", async () => {
    const { provider, agent } = agentWith([JSON.stringify({ actionId: 1 })]);
    const decision = await agent.decide(
      input({ config: { ...BOT_CONFIG, botId: "random", model: null } }),
    );
    expect(provider.requests).toEqual([]);
    expectLegalPick(decision.actionId);
    expect(decision.say).toBeNull();
  });
});

describe("fallback bot agent", () => {
  test("picks a legal action, deterministically per decision window", async () => {
    const fallback = new FallbackBotAgent();
    const first = await fallback.decide(input());
    const second = await fallback.decide(input());
    expect(first).toEqual(second);
    expectLegalPick(first.actionId);
    expect(first.say).toBeNull();
  });

  test("draws from the whole legal set, not just the first entry", async () => {
    const fallback = new FallbackBotAgent();
    const legalActions = [0, 1, 2, 3].map((index) => ({
      id: index,
      command: input().legalActions[1]!.command,
    }));
    const picks = new Set<number | null>();
    for (let seat = 0; seat < 40; seat += 1)
      picks.add(
        (await fallback.decide(input({ decisionId: `g:p${seat}:1:0`, legalActions }))).actionId,
      );
    expect([...picks].sort()).toEqual([0, 1, 2, 3]);
  });

  test("stays silent when there is nothing legal to do", async () => {
    const decision = await new FallbackBotAgent().decide(input({ legalActions: [] }));
    expect(decision).toEqual({ actionId: null, say: null, channel: null });
  });
});

describe("llm bot agent", () => {
  test("accepts a well-formed structured decision", async () => {
    const { agent } = agentWith([
      JSON.stringify({ actionId: 1, say: "I'll sit this one out.", channel: "public" }),
    ]);
    expect(await agent.decide(input())).toEqual({
      actionId: 1,
      say: "I'll sit this one out.",
      channel: "public",
    });
  });

  test("unwraps a markdown-fenced object", async () => {
    const { agent } = agentWith(['```json\n{"actionId": 0, "say": null, "channel": null}\n```']);
    expect((await agent.decide(input())).actionId).toBe(0);
  });

  test("falls back on unparseable output", async () => {
    const { agent } = agentWith(["I think we should hang Tobias, honestly"]);
    const decision = await agent.decide(input());
    expectLegalPick(decision.actionId);
    expect(decision.say).toBeNull();
  });

  test("falls back on schema-invalid output", async () => {
    const { agent } = agentWith([JSON.stringify({ actionId: "the second one" })]);
    expectLegalPick((await agent.decide(input())).actionId);
  });

  test("falls back on an empty response", async () => {
    const { agent } = agentWith([""]);
    expectLegalPick((await agent.decide(input())).actionId);
  });

  test("replaces an action that was never offered, but keeps a legal line", async () => {
    const { agent } = agentWith([
      JSON.stringify({ actionId: 42, say: "Tobias is lying.", channel: "public" }),
    ]);
    const decision = await agent.decide(input());
    expectLegalPick(decision.actionId);
    expect(decision.say).toBe("Tobias is lying.");
  });

  test("drops a line addressed to a channel this seat cannot speak on", async () => {
    const { agent } = agentWith([
      JSON.stringify({ actionId: 0, say: "Take Mira tonight.", channel: "wolves" }),
    ]);
    const decision = await agent.decide(input({ speakableChannels: ["public"] }));
    expect(decision.actionId).toBe(0);
    expect(decision.say).toBeNull();
    expect(decision.channel).toBeNull();
  });

  test("stays silent when no channel is open at all", async () => {
    const { agent } = agentWith([JSON.stringify({ actionId: 0, say: "psst", channel: "public" })]);
    const decision = await agent.decide(input({ speakableChannels: [] }));
    expect(decision.say).toBeNull();
  });

  test.each([
    ["timeout", new BotProviderError("timeout", "aborted")],
    ["network", new BotProviderError("network", "ECONNREFUSED")],
    ["provider", new BotProviderError("provider", "HTTP 500")],
    ["unexpected", new Error("boom")],
  ])("falls back on a %s failure", async (_label, error) => {
    const { agent } = agentWith([error]);
    expectLegalPick((await agent.decide(input())).actionId);
  });

  test("asks the provider for the configured model and a bounded response", async () => {
    const { provider, agent } = agentWith([JSON.stringify({ actionId: 0 })]);
    await agent.decide(input());
    const request = provider.requests[0]!;
    expect(request.model).toBe("fake-1");
    // Sampling and ceilings come from the seat, not from a global default.
    expect(request.temperature).toBe(BOT_CONFIG.temperature);
    expect(request.maxOutputTokens).toBe(BOT_CONFIG.maxOutputTokens);
    expect(request.timeoutMs).toBe(BOT_CONFIG.timeoutMs);
    // The prompt carries the bot's own seat, never the rest of the table.
    expect(request.userPrompt).toContain("Mira");
    expect(request.userPrompt).toContain("villager");
  });
});

describe("openai-compatible provider", () => {
  const request = {
    model: "m",
    systemPrompt: "s",
    userPrompt: "u",
    temperature: 0,
    maxOutputTokens: 10,
    timeoutMs: 1_000,
  };

  test("returns the first choice's content", async () => {
    const provider = new OpenAiCompatibleProvider({
      baseUrl: "https://example.test/v1/",
      apiKey: "secret",
      fetch: async (_url, init) => {
        const headers = (init ?? {}).headers as Record<string, string>;
        expect(headers.authorization).toBe("Bearer secret");
        return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }));
      },
    });
    expect(await provider.generateDecision(request)).toEqual({ text: "{}" });
  });

  test("sends no response_format, only the plain chat-completions fields", async () => {
    let body: Record<string, unknown> | undefined;
    const provider = new OpenAiCompatibleProvider({
      baseUrl: "https://example.test/v1",
      apiKey: "secret",
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }));
      },
    });
    await provider.generateDecision(request);
    expect("response_format" in (body ?? {})).toBe(false);
    expect(body?.model).toBe("m");
    expect(body?.temperature).toBe(0);
    expect(body?.max_tokens).toBe(10);
    expect(body?.messages).toEqual([
      { role: "system", content: "s" },
      { role: "user", content: "u" },
    ]);
  });

  test("categorises a non-2xx response without echoing its body", async () => {
    const provider = new OpenAiCompatibleProvider({
      baseUrl: "https://example.test/v1",
      apiKey: "secret",
      fetch: async () => new Response("quota exceeded for key sk-abc", { status: 429 }),
    });
    const error = (await provider.generateDecision(request).catch((caught) => caught)) as Error;
    expect(error).toBeInstanceOf(BotProviderError);
    expect((error as BotProviderError).category).toBe("provider");
    expect(error.message).not.toContain("sk-abc");
  });

  test("reports an empty completion as such", async () => {
    const provider = new OpenAiCompatibleProvider({
      baseUrl: "https://example.test/v1",
      apiKey: "secret",
      fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: "" } }] })),
    });
    const error = (await provider
      .generateDecision(request)
      .catch((caught) => caught)) as BotProviderError;
    expect(error.category).toBe("empty");
  });

  test("reports an aborted request as a timeout", async () => {
    const provider = new OpenAiCompatibleProvider({
      baseUrl: "https://example.test/v1",
      apiKey: "secret",
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    });
    const error = (await provider
      .generateDecision({ ...request, timeoutMs: 5 })
      .catch((caught) => caught)) as BotProviderError;
    expect(error.category).toBe("timeout");
  });
});
