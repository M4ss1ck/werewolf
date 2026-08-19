// Server-driven available-actions model: the client renders its night controls
// from this instead of switching on its own knowledge of roles. Every other
// player is listed as a target with an enabled flag, so the client shows
// ineligible players as disabled rather than hiding them.

import type { AvailableAction, UserId } from "@werewolf/protocol";
import { isUnlinkedCupid } from "../roles/cupid.ts";
import { getPerceivedRole } from "../roles/perceived.ts";
import { isPackMember } from "../roles/registry.ts";
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
    if (isPackMember(player)) {
      available.push({
        id: "wolf.attack",
        type: "target",
        targets: others.map((target) => ({
          userId: target.id,
          enabled: target.status === "alive" && !isPackMember(target),
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
    if (perceivedRole === "sorcerer") {
      available.push({
        id: "sorcerer.divine",
        type: "target",
        targets: others.map((target) => ({
          userId: target.id,
          enabled: target.status === "alive",
        })),
        ...(stored["sorcerer.divine"]?.targetId
          ? { selectedTargetId: stored["sorcerer.divine"]!.targetId }
          : {}),
      });
    }
    if (perceivedRole === "detective") {
      available.push({
        id: "detective.investigate",
        type: "target",
        targets: others.map((target) => ({
          userId: target.id,
          enabled: target.status === "alive",
        })),
        ...(stored["detective.investigate"]?.targetId
          ? { selectedTargetId: stored["detective.investigate"]!.targetId }
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
    if (state.day === 1 && isUnlinkedCupid(player)) {
      const all = Object.values(state.players);
      available.push({
        id: "cupid.link",
        type: "targets",
        count: 2,
        targets: all.map((target) => ({
          userId: target.id,
          enabled: target.status === "alive",
        })),
        ...(stored["cupid.link"]?.targetIds
          ? { selectedTargetIds: stored["cupid.link"]!.targetIds }
          : {}),
      });
    }
    if (perceivedRole === "priest") {
      const lastProtectedId = priestLastProtectedId(player.roleState);
      const all = Object.values(state.players);
      available.push({
        id: "priest.protect",
        type: "target",
        targets: all.map((target) => ({
          userId: target.id,
          enabled: target.status === "alive" && target.id !== lastProtectedId,
        })),
        ...(stored["priest.protect"]?.targetId
          ? { selectedTargetId: stored["priest.protect"]!.targetId }
          : {}),
      });
    }
    if (perceivedRole === "guardian" && state.day === 1 && !isGuardianBonded(player.roleState)) {
      const all = Object.values(state.players);
      available.push({
        id: "guardian.bond",
        type: "target",
        targets: all.map((target) => ({
          userId: target.id,
          enabled: target.status === "alive" && target.id !== player.id,
        })),
        ...(stored["guardian.bond"]?.targetId
          ? { selectedTargetId: stored["guardian.bond"]!.targetId }
          : {}),
      });
    }
    if (perceivedRole === "cult_leader") {
      available.push({
        id: "cult.convert",
        type: "target",
        targets: others.map((target) => ({
          userId: target.id,
          enabled: target.status === "alive" && target.id !== player.id,
        })),
        ...(stored["cult.convert"]?.targetId
          ? { selectedTargetId: stored["cult.convert"]!.targetId }
          : {}),
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

function priestLastProtectedId(value: unknown): UserId | null {
  if (typeof value !== "object" || value === null || !("lastProtectedId" in value)) return null;
  return (value as { lastProtectedId: UserId | null }).lastProtectedId ?? null;
}

function isGuardianBonded(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "protegeeId" in value &&
    (value as { protegeeId: unknown }).protegeeId !== null
  );
}
