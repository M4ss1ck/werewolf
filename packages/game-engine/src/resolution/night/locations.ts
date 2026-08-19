import type { UserId } from "@werewolf/protocol";
import { getActionSpec } from "../../roles/action-spec.ts";
import { isPackMember } from "../../roles/registry.ts";
import type { GameState, PlayerState } from "../../state.ts";
import type { FrozenIntents } from "./freeze.ts";

/** Where every living player spends the night: a map from player id to the id
 * of the player whose house they are in. Everyone starts at home; the pack
 * gathers at the balloted target's house (or stay home on a tie or empty
 * ballot), and anyone whose action travels walks to their target's house.
 *
 * Travel keys on whoever STORED the action, not on who is really a detective:
 * a Drunk who believes they are the Detective genuinely walks to that house
 * and genuinely dies there. Locations are about where a body is, not about
 * whether a power is real. */
export function resolveNightLocations(
  state: GameState,
  frozen: FrozenIntents,
  wolfTargetId: UserId | null,
): Map<UserId, UserId> {
  const locations = new Map<UserId, UserId>();
  for (const player of livingPlayers(state)) locations.set(player.id, player.id);
  // The pack gathers at the balloted house; they stay home on a tie or an
  // empty ballot.
  if (wolfTargetId !== null)
    for (const player of livingPlayers(state))
      if (isPackMember(player)) locations.set(player.id, wolfTargetId);
  // Everyone else who travels does so because their action says it walks to
  // the target's house. Locations are about where a body is, not about
  // whether a power is real, so a mimicking Drunk travels too.
  for (const [actionId, intents] of frozen) {
    if (getActionSpec(actionId)?.travelsToTarget !== true) continue;
    for (const intent of intents)
      if (intent.targetId) locations.set(intent.actorId, intent.targetId);
  }
  return locations;
}

function livingPlayers(state: GameState): PlayerState[] {
  return Object.values(state.players).filter((player) => player.status === "alive");
}
