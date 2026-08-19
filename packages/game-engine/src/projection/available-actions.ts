// Server-driven available-actions model: the client renders its night controls
// from this instead of switching on its own knowledge of roles. Every other
// player is listed as a target with an enabled flag, so the client shows
// ineligible players as disabled rather than hiding them.

import type { AvailableAction, UserId } from "@werewolf/protocol";
import { getPerceivedRole } from "../roles/perceived.ts";
import type { GameState } from "../state.ts";

export function getAvailableActions(state: GameState, playerId: UserId): AvailableAction[] {
  const player = state.players[playerId];
  if (!player || player.status !== "alive") return [];
  if (!state.phase) return [];
  const others = Object.values(state.players).filter((other) => other.id !== playerId);
  const stored =
    player.phaseState.phaseId === state.phase.id ? (player.phaseState.actions ?? {}) : {};
  const perceivedRole = getPerceivedRole(player);
  const available: AvailableAction[] = [];
  if (state.phase.type === "night") {
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
    if (perceivedRole === "seer") {
      available.push({
        id: "seer.inspect",
        type: "target",
        targets: others.map((target) => ({
          userId: target.id,
          enabled: target.status === "alive",
        })),
        ...(stored["seer.inspect"]?.targetId
          ? { selectedTargetId: stored["seer.inspect"]!.targetId }
          : {}),
      });
    }
    if (perceivedRole === "harlot") {
      available.push({
        id: "harlot.visit",
        type: "target",
        targets: others.map((target) => ({
          userId: target.id,
          enabled: target.status === "alive",
        })),
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
    if (perceivedRole === "serial_killer") {
      available.push({
        id: "serial_killer.visit",
        type: "target",
        targets: others.map((target) => ({
          userId: target.id,
          enabled: target.status === "alive",
        })),
        ...(stored["serial_killer.visit"]?.targetId
          ? { selectedTargetId: stored["serial_killer.visit"]!.targetId }
          : {}),
      });
      available.push({
        id: "serial_killer.stay",
        type: "choice",
        ...("serial_killer.stay" in stored ? { selected: true } : {}),
      });
    }
    return available;
  }
  if (state.phase.type === "discussion" || state.phase.type === "voting") {
    if (perceivedRole === "mayor" && isMayorState(player.roleState) && !player.roleState.used) {
      available.push({
        id: "mayor.reveal",
        type: "target",
        targets: others.map((target) => ({
          userId: target.id,
          enabled: target.status === "alive",
        })),
      });
      available.push({
        id: "mayor.pardon",
        type: "choice",
      });
    }
  }
  return available;
}

function isMayorState(value: unknown): value is { used: boolean } {
  return (
    typeof value === "object" &&
    value !== null &&
    "used" in value &&
    typeof (value as { used: unknown }).used === "boolean"
  );
}
