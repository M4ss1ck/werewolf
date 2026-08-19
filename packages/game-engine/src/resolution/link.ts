import type { UserId } from "@werewolf/protocol";
import type { GameState } from "../state.ts";

/** The established lover pair, read from the cupid's roleState. The bond
 * outlives the cupid, so the cupid is found whether alive or dead. */
export function getLinkPair(state: GameState): [UserId, UserId] | null {
  const cupid = Object.values(state.players).find((player) => player.role === "cupid");
  if (!cupid) return null;
  const linked = (cupid.roleState as { linked?: [UserId, UserId] | null } | null)?.linked;
  return linked ?? null;
}

/** The partner of `playerId` in an established pair, if that partner is alive
 * and not already among the dead this resolution. */
export function loverPartner(
  state: GameState,
  playerId: UserId,
  alreadyDead: ReadonlySet<UserId>,
): UserId | null {
  const pair = getLinkPair(state);
  if (!pair) return null;
  const [a, b] = pair;
  const partner = a === playerId ? b : b === playerId ? a : null;
  if (!partner) return null;
  if (alreadyDead.has(partner)) return null;
  if (state.players[partner]?.status !== "alive") return null;
  return partner;
}
