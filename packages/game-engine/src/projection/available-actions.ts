// Server-driven available-actions model: the client renders its night controls
// from this instead of switching on its own knowledge of roles. Every other
// player is listed as a target with an enabled flag, so the client shows
// ineligible players as disabled rather than hiding them.

import type { AvailableAction, UserId } from "@werewolf/protocol";
import type { GameState } from "../state.ts";

export function getAvailableActions(state: GameState, playerId: UserId): AvailableAction[] {
  const player = state.players[playerId];
  if (!player || player.status !== "alive") return [];
  if (!state.phase || state.phase.type !== "night") return [];
  const others = Object.values(state.players).filter((other) => other.id !== playerId);
  const stored =
    player.phaseState.phaseId === state.phase.id ? (player.phaseState.actions ?? {}) : {};
  const available: AvailableAction[] = [];
  if (player.faction === "wolves") {
    available.push({
      id: "wolf.attack",
      type: "target",
      targets: others.map((target) => ({
        userId: target.id,
        enabled: target.status === "alive" && target.faction !== "wolves",
      })),
      ...(stored["wolf.attack"]?.targetId
        ? { selectedTargetId: stored["wolf.attack"]!.targetId }
        : {}),
    });
  }
  if (player.role === "seer") {
    available.push({
      id: "seer.inspect",
      type: "target",
      targets: others.map((target) => ({ userId: target.id, enabled: target.status === "alive" })),
      ...(stored["seer.inspect"]?.targetId
        ? { selectedTargetId: stored["seer.inspect"]!.targetId }
        : {}),
    });
  }
  if (player.role === "harlot") {
    available.push({
      id: "harlot.visit",
      type: "target",
      targets: others.map((target) => ({ userId: target.id, enabled: target.status === "alive" })),
      ...(stored["harlot.visit"]?.targetId
        ? { selectedTargetId: stored["harlot.visit"]!.targetId }
        : {}),
    });
    available.push({
      id: "harlot.stay",
      type: "choice",
      ...("harlot.stay" in stored ? { selected: true } : {}),
    });
  }
  return available;
}
