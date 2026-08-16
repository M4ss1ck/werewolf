// The only vendor-facing code in the project: an OpenAI-compatible chat
// completions client. DeepSeek, OpenAI, OpenRouter, Groq and a local llama.cpp
// server all speak this, so changing model means changing environment, not
// code.
//
// Structured output is requested natively via `response_format`. Providers
// that ignore the field still return JSON because the prompt demands it, and
// the caller validates the text either way — the schema request is an
// optimisation, never the guarantee.

import {
  type BotModelProvider,
  type BotModelRequest,
  type BotModelResponse,
  BotProviderError,
} from "./types.ts";

/** Structural, not `typeof globalThis.fetch`: the runtime's own fetch carries
 * extras a test double has no business implementing. */
type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  apiKey: string;
  /** Reported in logs; the configured provider label, not a secret. */
  name?: string;
  fetch?: Fetch;
}

export class OpenAiCompatibleProvider implements BotModelProvider {
  readonly name: string;
  private readonly fetch: Fetch;

  constructor(private readonly options: OpenAiCompatibleOptions) {
    this.name = options.name ?? "openai-compatible";
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async generateDecision(request: BotModelRequest): Promise<BotModelResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    let response: Response;
    try {
      response = await this.fetch(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({
          model: request.model,
          temperature: request.temperature,
          max_tokens: request.maxOutputTokens,
          response_format: {
            type: "json_schema",
            json_schema: { ...request.schema, strict: true },
          },
          messages: [
            { role: "system", content: request.systemPrompt },
            { role: "user", content: request.userPrompt },
          ],
        }),
      });
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      throw new BotProviderError(aborted ? "timeout" : "network", String(error));
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // The body may carry the provider's own error prose; the status is
      // enough to categorise, and it cannot contain the API key.
      throw new BotProviderError("provider", `HTTP ${response.status}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new BotProviderError("provider", `unparseable body: ${String(error)}`);
    }

    const text = (body as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]
      ?.message?.content;
    if (typeof text !== "string" || text.trim().length === 0)
      throw new BotProviderError("empty", "no content in first choice");
    return { text };
  }
}
