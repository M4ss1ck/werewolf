// The bot/LLM boundary.
//
// `BotDecisionInput` is everything a bot is allowed to know when it decides.
// It is built from the same viewer projection a human client receives plus
// that viewer's visible events, so it is serializable by construction: no
// GameState, no repository, no socket, no credentials. Moving decisions to
// another process would mean moving this JSON and nothing else.

import type { LegalCommand } from "@werewolf/game-engine";
import type {
  BotConfig,
  ChatChannel,
  FactionId,
  GameEvent,
  GameId,
  GamePhase,
  PhaseId,
  RoleId,
  UserId,
  ViewerGameSnapshot,
} from "@werewolf/protocol";
import { z } from "zod";

/** One command the bot may pick, addressed by a small stable index so a model
 * can never name a target that was not offered. */
export interface LegalAction {
  id: number;
  command: LegalCommand;
}

export interface BotDecisionInput {
  /** `gameId:playerId:phaseId:turn` — identifies this decision window, seeds
   * the deterministic fallback and derives the idempotent command ids. */
  decisionId: string;
  gameId: GameId;
  playerId: UserId;
  phase: GamePhase;
  phaseId: PhaseId;
  /** Milliseconds left before the phase closes. */
  remainingMs: number;
  role?: RoleId;
  faction?: FactionId;
  /** The seat's own config: which model decides for it, and any personality
   * line. Never carries a key or a base URL. */
  config: BotConfig;
  playerView: ViewerGameSnapshot;
  visibleEvents: GameEvent[];
  /** Chat messages from the current phase this bot may see, newest last,
   * capped at BOT_PHASE_CHAT_LIMIT. This is what makes a reply a reply. */
  phaseChat: GameEvent[];
  /** One compact line per earlier day — who was voted out, who died in the
   * night — oldest first, capped at BOT_DIGEST_DAYS. Built deterministically
   * from the bot's visible public events, never by a model. */
  digest: string[];
  legalActions: LegalAction[];
  speakableChannels: ChatChannel[];
}

/** An untrusted suggestion. The server validates it again before executing. */
export interface BotDecision {
  /** Index into `legalActions`, or null to act on nothing this turn. */
  actionId: number | null;
  say: string | null;
  channel: ChatChannel | null;
  /** True when the bot has nothing further to say this phase. The manager
   * readies the seat on it, which is what lets the phase end early. */
  done: boolean;
}

/** Lenient on the way in — a cheap model that omits a field should degrade to
 * "no action" rather than to a schema failure — strict on what it produces. */
export const BotDecisionSchema = z.object({
  actionId: z
    .number()
    .int()
    .nullish()
    .transform((value) => value ?? null),
  say: z
    .string()
    .max(400)
    .nullish()
    .transform((value) => value ?? null),
  channel: z
    .enum(["public", "wolves", "cult"])
    .nullish()
    .transform((value) => value ?? null),
  done: z
    .boolean()
    .nullish()
    .transform((value) => value ?? false),
});

export interface BotAgent {
  decide(input: BotDecisionInput): Promise<BotDecision>;
}

export interface BotModelRequest {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  temperature: number;
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface BotModelResponse {
  /** Raw model text, expected to be JSON. Never trusted, always validated. */
  text: string;
}

/** The only vendor-facing surface. Swapping providers means another class
 * here, not a change anywhere in the game code. */
export interface BotModelProvider {
  readonly name: string;
  generateDecision(request: BotModelRequest): Promise<BotModelResponse>;
}

export class BotProviderError extends Error {
  constructor(
    readonly category: "timeout" | "network" | "provider" | "empty",
    message: string,
  ) {
    super(message);
    this.name = "BotProviderError";
  }
}
