import type { UserId } from "@werewolf/protocol";
import type { GameState, PlayerState } from "../state.ts";
import type { ActionSpec } from "./action-spec.ts";

/** The target list for an action, every candidate with an enabled flag.
 * The single place a target list is built, so the client's rendering, the
 * server's validation and the bot's legal moves cannot disagree. */
export function resolveTargets(
  spec: ActionSpec,
  player: PlayerState,
  state: GameState,
): { userId: UserId; enabled: boolean }[] {
  if (spec.target === null) return [];
  const pool =
    spec.target.pool === "all"
      ? Object.values(state.players)
      : Object.values(state.players).filter((other) => other.id !== player.id);
  return pool.map((target) => ({
    userId: target.id,
    enabled:
      target.status === "alive" &&
      !(spec.target!.excludeSelf && target.id === player.id) &&
      (spec.eligible?.({ player, target, state }) ?? true),
  }));
}
