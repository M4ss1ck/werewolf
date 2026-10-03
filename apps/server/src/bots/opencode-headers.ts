// OpenCode Go client identification.
//
// https://opencode.ai/docs/go#where-can-i-use-it requires third-party clients
// to identify with their own User-Agent (not a generic SDK name) and to send
// a stable `x-opencode-session` per conversation for routing and prompt-cache
// affinity. Requests missing the session header may error.

/** Our own User-Agent, never a generic SDK or HTTP-library name. */
export const OPENCODE_USER_AGENT = "werewolf-bots/1.0";

/** Header name OpenCode Go uses for session affinity. */
export const OPENCODE_SESSION_HEADER = "x-opencode-session";

/** One stable conversation per bot seat: the whole match from that seat's view. */
export function botSessionId(gameId: string, playerId: string): string {
  return `${gameId}:${playerId}`;
}

/** Static session for requests with no conversation, like the /models probe. */
export const MODEL_CATALOG_SESSION_ID = "werewolf-model-catalog";
