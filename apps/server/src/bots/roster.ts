// The bot roster: a list of named personas the host can seat, each with its
// own model and sampling settings. It is deployment configuration, not game
// state, so it lives in a JSON file rather than the database.
//
// Settings are per bot on purpose. One roster can mix a cheap fast model for
// most seats with a slower one for a couple of them, and give each a different
// temperature and personality, without any of it being a global default.

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { BotConfig, BotRosterEntry } from "@werewolf/protocol";
import { z } from "zod";
import type { BotLogger } from "./log.ts";
import { silentBotLogger } from "./log.ts";

export const BotRosterDefinitionSchema = z.object({
  id: z.string().min(1).max(40),
  displayName: z.string().min(1).max(24),
  /** Null means no model: this bot plays random legal actions. */
  model: z.string().min(1).nullable(),
  temperature: z.number().min(0).max(2).default(0.8),
  maxOutputTokens: z.number().int().positive().max(2000).default(180),
  timeoutMs: z.number().int().positive().max(120_000).default(15_000),
  personality: z.string().max(200).optional(),
});
export type BotRosterDefinition = z.infer<typeof BotRosterDefinitionSchema>;

const BotRosterFileSchema = z.array(BotRosterDefinitionSchema).max(50);

/** Always present and always available: it needs no provider, so an unattended
 * match and the test suite work with no account and at no cost. Built in
 * rather than listed in the file so it cannot be removed by accident. */
export const RANDOM_BOT: BotRosterDefinition = {
  id: "random",
  displayName: "Dummy",
  model: null,
  temperature: 0,
  maxOutputTokens: 0,
  timeoutMs: 1,
};

export function parseBotRoster(source: unknown): BotRosterDefinition[] {
  const parsed = BotRosterFileSchema.safeParse(source);
  if (!parsed.success) {
    const where = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid bot roster: ${where}`);
  }
  const seen = new Set<string>([RANDOM_BOT.id]);
  for (const entry of parsed.data) {
    if (seen.has(entry.id)) throw new Error(`Duplicate bot id in roster: ${entry.id}`);
    seen.add(entry.id);
  }
  return [RANDOM_BOT, ...parsed.data];
}

// The repository root, from this module's own location rather than the working
// directory. `bun run dev:server` runs with cwd apps/server while the
// production image runs with cwd /app, so a cwd-relative roster path resolves
// to two different places and silently misses in one of them.
const REPO_ROOT = new URL("../../../../", import.meta.url).pathname;

/** Where a configured roster path actually points. Absolute paths are used as
 * given; a relative one is anchored to the repository root. */
export function resolveRosterPath(path: string): string {
  return isAbsolute(path) ? path : resolve(REPO_ROOT, path);
}

/** Reads the roster file. A missing file is not fatal — the deployment then
 * offers only the built-in random bot — but it is always reported, because a
 * roster that quietly failed to load looks exactly like a roster of one. A
 * malformed file is fatal, and fails at startup rather than at the first lobby. */
export function loadBotRoster(
  path: string,
  log: BotLogger = silentBotLogger,
): BotRosterDefinition[] {
  const resolved = resolveRosterPath(path);
  let text: string;
  try {
    text = readFileSync(resolved, "utf8");
  } catch {
    log("roster_missing", { path, resolved });
    return [RANDOM_BOT];
  }
  let source: unknown;
  try {
    source = JSON.parse(text);
  } catch (error) {
    throw new Error(`Bot roster at ${resolved} is not valid JSON: ${String(error)}`);
  }
  const roster = parseBotRoster(source);
  log("roster_loaded", { resolved, count: roster.length });
  return roster;
}

/** Narrow view of the model catalog, so the roster does not depend on how
 * availability is discovered. */
export interface ModelAvailability {
  readonly configured: boolean;
  has(model: string): boolean;
}

/** The roster as one lobby sees it: identity and model only, plus why an entry
 * cannot be seated. Never carries the key or the endpoint. */
export function describeRoster(
  roster: readonly BotRosterDefinition[],
  availability: ModelAvailability,
  seatedBotIds: ReadonlySet<string>,
): BotRosterEntry[] {
  return roster.map((entry) => {
    const reason = seatedBotIds.has(entry.id)
      ? "ALREADY_SEATED"
      : entry.model === null
        ? undefined
        : !availability.configured
          ? "PROVIDER_NOT_CONFIGURED"
          : !availability.has(entry.model)
            ? "MODEL_NOT_AVAILABLE"
            : undefined;
    return {
      id: entry.id,
      displayName: entry.displayName,
      model: entry.model,
      ...(entry.personality ? { personality: entry.personality } : {}),
      available: reason === undefined,
      ...(reason ? { reason } : {}),
    };
  });
}

/** Freeze a roster entry onto a seat. Resolved at seating time so a later edit
 * to the roster file cannot change how a game in progress behaves. */
export function toSeatConfig(entry: BotRosterDefinition, provider: string): BotConfig {
  return {
    botId: entry.id,
    provider,
    model: entry.model,
    temperature: entry.temperature,
    maxOutputTokens: entry.maxOutputTokens,
    timeoutMs: entry.timeoutMs,
    ...(entry.personality ? { personality: entry.personality } : {}),
  };
}
