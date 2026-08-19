// Server-driven available-actions model: the client renders its night controls
// from this instead of switching on its own knowledge of roles. Every other
// player is listed as a target with an enabled flag, so the client shows
// ineligible players as disabled rather than hiding them.

import type { AvailableAction, UserId } from "@werewolf/protocol";
import { getActionSpecsFor } from "../roles/action-spec.ts";
import { resolveTargets } from "../roles/targets.ts";
import type { GameState } from "../state.ts";

export function getAvailableActions(state: GameState, playerId: UserId): AvailableAction[] {
  const player = state.players[playerId];
  if (!player || !state.phase) return [];
  const stored =
    player.phaseState.phaseId === state.phase.id ? (player.phaseState.actions ?? {}) : {};
  return getActionSpecsFor(state, player).map((spec) => {
    const saved = stored[spec.id];
    if (spec.target === null) {
      return { id: spec.id, type: "choice", ...(spec.id in stored ? { selected: true } : {}) };
    }
    const targets = resolveTargets(spec, player, state);
    if (spec.target.kind === "pair") {
      return {
        id: spec.id,
        type: "targets",
        count: 2,
        targets,
        ...(saved?.targetIds ? { selectedTargetIds: saved.targetIds } : {}),
      };
    }
    return {
      id: spec.id,
      type: "target",
      targets,
      ...(saved?.targetId ? { selectedTargetId: saved.targetId } : {}),
    };
  });
}
