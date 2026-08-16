// Which models this deployment can actually reach.
//
// Probed once at startup from the provider's OpenAI-compatible /models
// endpoint and cached, so listing the lobby roster costs nothing.
//
// A failed probe means "unknown", not "unavailable": a transient network
// error at boot must not disable every bot in the roster. It fails open with a
// warning, and a genuinely wrong model id then surfaces as a provider error on
// the first call, where the fallback catches it.

import type { BotLogger } from "./log.ts";
import { silentBotLogger } from "./log.ts";

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export interface ModelCatalogOptions {
  baseUrl: string;
  apiKey?: string | undefined;
  timeoutMs?: number;
  fetch?: Fetch;
  logger?: BotLogger;
}

export class ModelCatalog {
  private models: Set<string> | null = null;
  private probed = false;
  private readonly fetch: Fetch;
  private readonly log: BotLogger;

  constructor(private readonly options: ModelCatalogOptions) {
    this.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.log = options.logger ?? silentBotLogger;
  }

  /** Whether a provider is configured at all. Nothing with a model can be
   * seated without one. */
  get configured(): boolean {
    return Boolean(this.options.apiKey);
  }

  async probe(): Promise<void> {
    this.probed = true;
    if (!this.configured) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 10_000);
    try {
      const response = await this.fetch(`${this.options.baseUrl.replace(/\/$/, "")}/models`, {
        signal: controller.signal,
        headers: { authorization: `Bearer ${this.options.apiKey}` },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { data?: { id?: unknown }[] };
      const ids = (body.data ?? [])
        .map((entry) => entry.id)
        .filter((id): id is string => typeof id === "string");
      if (ids.length === 0) throw new Error("empty model list");
      this.models = new Set(ids);
      this.log("models_probed", { count: ids.length });
    } catch (error) {
      // Fail open. The alternative is a boot-time blip disabling the feature.
      this.models = null;
      this.log("models_probe_failed", { message: String(error) });
    } finally {
      clearTimeout(timer);
    }
  }

  /** True when the model is known to be reachable, or when the catalog could
   * not be determined. False only when the provider answered and left it out. */
  has(model: string): boolean {
    if (!this.probed || this.models === null) return true;
    return this.models.has(model);
  }
}
