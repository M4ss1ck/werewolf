// Bot agents: the thing that turns a decision input into a decision.
//
// `FallbackBotAgent` is the whole of the non-LLM behaviour, on purpose. It is
// not a strategy engine and must not become one: it picks uniformly from the
// legal actions using the seeded RNG, so a failing provider degrades a match
// into a deterministic, still-progressing one rather than wedging it.
//
// `LlmBotAgent` wraps a provider and falls back to exactly that on every
// failure mode: timeout, network error, provider error, unparseable JSON,
// schema mismatch, empty response, or an action the model was never offered.

import { createRng } from "@werewolf/game-engine";
import { type BotRuntimeConfig, loadBotConfig } from "./config.ts";
import { type BotLogger, silentBotLogger } from "./log.ts";
import { BOT_DECISION_JSON_SCHEMA, BOT_SYSTEM_PROMPT, buildUserPrompt } from "./prompt.ts";
import {
  type BotAgent,
  type BotDecision,
  type BotDecisionInput,
  BotDecisionSchema,
  type BotModelProvider,
  BotProviderError,
} from "./types.ts";

const SILENT: BotDecision = { actionId: null, say: null, channel: null };

/** Deterministic given the decision id, which is itself derived from the game,
 * player, phase and turn — so a replayed test picks the same action. */
export class FallbackBotAgent implements BotAgent {
  decide(input: BotDecisionInput): Promise<BotDecision> {
    if (input.legalActions.length === 0) return Promise.resolve(SILENT);
    const rng = createRng(input.decisionId);
    const choice = input.legalActions[rng.int(input.legalActions.length)]!;
    return Promise.resolve({ actionId: choice.id, say: null, channel: null });
  }
}

/** Cheap models like to wrap JSON in a markdown fence. Unwrapping one is not
 * "parsing prose": anything else still goes to the fallback. */
function unfence(text: string): string {
  const fenced = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return (fenced?.[1] ?? text).trim();
}

export class LlmBotAgent implements BotAgent {
  private readonly fallback = new FallbackBotAgent();

  constructor(
    private readonly provider: BotModelProvider,
    private readonly config: BotRuntimeConfig = loadBotConfig(),
    private readonly log: BotLogger = silentBotLogger,
  ) {}

  async decide(input: BotDecisionInput): Promise<BotDecision> {
    const model = input.config.model;
    const startedAt = Date.now();
    const userPrompt = buildUserPrompt(input);
    if (this.config.BOT_LOG_PROMPTS)
      this.log("prompt", { decisionId: input.decisionId, model, prompt: userPrompt });

    let text: string;
    try {
      const response = await this.provider.generateDecision({
        model,
        systemPrompt: BOT_SYSTEM_PROMPT,
        userPrompt,
        temperature: input.config.temperature ?? this.config.BOT_AI_TEMPERATURE,
        maxOutputTokens: this.config.BOT_AI_MAX_OUTPUT_TOKENS,
        timeoutMs: this.config.BOT_AI_TIMEOUT_MS,
        schema: BOT_DECISION_JSON_SCHEMA as unknown as {
          name: string;
          schema: Record<string, unknown>;
        },
      });
      text = response.text;
    } catch (error) {
      return this.giveUp(input, model, startedAt, categorise(error));
    }
    if (this.config.BOT_LOG_PROMPTS)
      this.log("response", { decisionId: input.decisionId, model, response: text });

    let raw: unknown;
    try {
      raw = JSON.parse(unfence(text));
    } catch {
      return this.giveUp(input, model, startedAt, "invalid_json");
    }
    const parsed = BotDecisionSchema.safeParse(raw);
    if (!parsed.success) return this.giveUp(input, model, startedAt, "schema_invalid");

    const decision = this.sanitise(parsed.data, input);
    // An action the model was never offered is a failure of the same kind as a
    // bad schema, but the line it spoke is still legal, so keep it.
    const illegal = parsed.data.actionId !== null && decision.actionId === null;
    if (illegal) {
      const replacement = await this.fallback.decide(input);
      this.log("decided", {
        decisionId: input.decisionId,
        provider: this.provider.name,
        model,
        latencyMs: Date.now() - startedAt,
        outcome: "illegal_action",
      });
      return { ...decision, actionId: replacement.actionId };
    }
    this.log("decided", {
      decisionId: input.decisionId,
      provider: this.provider.name,
      model,
      latencyMs: Date.now() - startedAt,
      outcome: "ok",
      spoke: decision.say !== null,
    });
    return decision;
  }

  /** Every failure path lands here: log the category, then act deterministically. */
  private async giveUp(
    input: BotDecisionInput,
    model: string,
    startedAt: number,
    outcome: string,
  ): Promise<BotDecision> {
    this.log("decided", {
      decisionId: input.decisionId,
      provider: this.provider.name,
      model,
      latencyMs: Date.now() - startedAt,
      outcome,
    });
    return this.fallback.decide(input);
  }

  /** The model's output is a suggestion. Anything it was not offered is
   * dropped here; the coordinator validates whatever survives all over again. */
  private sanitise(
    decision: { actionId: number | null; say: string | null; channel: string | null },
    input: BotDecisionInput,
  ): BotDecision {
    const offered = input.legalActions.some((action) => action.id === decision.actionId);
    const say = decision.say?.trim() ? decision.say.trim().slice(0, 300) : null;
    const channel =
      decision.channel === "public" || decision.channel === "wolves"
        ? decision.channel
        : (input.speakableChannels[0] ?? null);
    const maySpeak = channel !== null && input.speakableChannels.includes(channel);
    return {
      actionId: offered ? decision.actionId : null,
      say: say !== null && maySpeak ? say : null,
      channel: say !== null && maySpeak ? channel : null,
    };
  }
}

function categorise(error: unknown): string {
  if (error instanceof BotProviderError) return error.category;
  return "network";
}
