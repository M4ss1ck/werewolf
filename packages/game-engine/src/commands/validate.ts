import type { ActionId, GameplayCommand, UserId } from "@werewolf/protocol";
import { isUnlinkedCupid } from "../roles/cupid.ts";
import { getPerceivedRole } from "../roles/perceived.ts";
import { isPackMember, WOLF_CHAT_ROLES } from "../roles/registry.ts";
import type { DomainError, GameState } from "../state.ts";

export interface CommandContext {
  now: number;
}
export function validateCommand(
  state: GameState,
  actorId: UserId,
  command: GameplayCommand,
  context: CommandContext,
): DomainError | null {
  const player = state.players[actorId];
  if (!player) return { code: "NOT_A_MEMBER" };
  if (!state.phase || command.phaseId !== state.phase.id) return { code: "PHASE_MISMATCH" };
  if (context.now >= state.phase.endsAt) return { code: "PHASE_CLOSED" };
  if (command.type === "chat.send") {
    if (command.payload.channel === "public") {
      if (player.status !== "alive" || state.phase.type === "night") {
        return { code: "CHAT_READ_ONLY" };
      }
      return null;
    }
    if (command.payload.channel === "grave") {
      // The dead may speak in the graveyard in every phase, including night.
      // A spectator who never played is not dead and must not sit in it.
      if (player.status !== "dead") return { code: "CHANNEL_NOT_AVAILABLE" };
      return null;
    }
    if (player.role === null || !WOLF_CHAT_ROLES.has(player.role))
      return { code: "CHANNEL_NOT_AVAILABLE" };
    if (player.status !== "alive") return { code: "CHAT_READ_ONLY" };
    return null;
  }
  if (player.status !== "alive") return { code: "NOT_ALIVE" };
  if (command.type === "phase.ready") return null;
  if (command.type === "vote.set" || command.type === "vote.abstain") {
    if (state.phase.type !== "voting") return { code: "ACTION_NOT_AVAILABLE" };
    if (command.type === "vote.set") {
      const target = state.players[command.payload.targetId];
      if (!target || target.status !== "alive") return { code: "INVALID_TARGET" };
    }
    return null;
  }
  if (command.type === "night.action.set" || command.type === "night.action.clear") {
    if (state.phase.type !== "night") return { code: "ACTION_NOT_AVAILABLE" };
    if (command.type === "night.action.clear") return null;
    const target = "targetId" in command.payload ? state.players[command.payload.targetId] : null;
    const perceivedRole = getPerceivedRole(player);
    // The payload type only covers the original four actions; the serial
    // killer's actions are part of the ActionId vocabulary, so widen the
    // discriminant to accept them.
    switch (command.payload.action as ActionId) {
      case "wolf.attack":
        if (!isPackMember(player)) return { code: "ACTION_NOT_AVAILABLE" };
        if (!target || target.status !== "alive" || isPackMember(target))
          return { code: "INVALID_TARGET" };
        return null;
      case "seer.inspect":
        if (perceivedRole !== "seer") return { code: "ACTION_NOT_AVAILABLE" };
        if (!target || target.status !== "alive" || target.id === actorId)
          return { code: "INVALID_TARGET" };
        return null;
      case "sorcerer.divine":
        if (perceivedRole !== "sorcerer") return { code: "ACTION_NOT_AVAILABLE" };
        if (!target || target.status !== "alive" || target.id === actorId)
          return { code: "INVALID_TARGET" };
        return null;
      case "detective.investigate":
        if (perceivedRole !== "detective") return { code: "ACTION_NOT_AVAILABLE" };
        if (!target || target.status !== "alive" || target.id === actorId)
          return { code: "INVALID_TARGET" };
        return null;
      case "harlot.visit":
        if (perceivedRole !== "harlot") return { code: "ACTION_NOT_AVAILABLE" };
        if (!target || target.status !== "alive" || target.id === actorId)
          return { code: "INVALID_TARGET" };
        return null;
      case "harlot.stay":
        if (perceivedRole !== "harlot") return { code: "ACTION_NOT_AVAILABLE" };
        return null;
      case "serial_killer.visit":
        if (perceivedRole !== "serial_killer") return { code: "ACTION_NOT_AVAILABLE" };
        if (!target || target.status !== "alive" || target.id === actorId)
          return { code: "INVALID_TARGET" };
        return null;
      case "serial_killer.stay":
        if (perceivedRole !== "serial_killer") return { code: "ACTION_NOT_AVAILABLE" };
        return null;
      case "cupid.link": {
        if (state.day !== 1) return { code: "ACTION_NOT_AVAILABLE" };
        if (!isUnlinkedCupid(player)) return { code: "ACTION_NOT_AVAILABLE" };
        if (!("targetIds" in command.payload)) return { code: "INVALID_TARGET" };
        const [first, second] = command.payload.targetIds;
        if (!first || !second || first === second) return { code: "INVALID_TARGET" };
        for (const targetId of command.payload.targetIds) {
          const target = state.players[targetId];
          if (!target || target.status !== "alive") return { code: "INVALID_TARGET" };
        }
        return null;
      }
      case "priest.protect": {
        if (perceivedRole !== "priest") return { code: "ACTION_NOT_AVAILABLE" };
        if (!target || target.status !== "alive") return { code: "INVALID_TARGET" };
        // The priest may protect themselves, but never the same player on two
        // consecutive nights.
        if (target.id === priestLastProtectedId(player.roleState))
          return { code: "INVALID_TARGET" };
        return null;
      }
      case "guardian.bond": {
        if (perceivedRole !== "guardian") return { code: "ACTION_NOT_AVAILABLE" };
        if (state.day !== 1) return { code: "ACTION_NOT_AVAILABLE" };
        if (isGuardianBonded(player.roleState)) return { code: "ACTION_NOT_AVAILABLE" };
        if (!target || target.status !== "alive" || target.id === actorId)
          return { code: "INVALID_TARGET" };
        return null;
      }
    }
  }
  if (command.type === "day.action.set") {
    if (state.phase.type !== "discussion" && state.phase.type !== "voting")
      return { code: "ACTION_NOT_AVAILABLE" };
    const perceivedRole = getPerceivedRole(player);
    if (perceivedRole !== "mayor") return { code: "ACTION_NOT_AVAILABLE" };
    if (!isMayorState(player.roleState) || player.roleState.used)
      return { code: "ACTION_NOT_AVAILABLE" };
    if (command.payload.action === "mayor.reveal") {
      const target = state.players[command.payload.targetId];
      if (!target || target.status !== "alive") return { code: "INVALID_TARGET" };
    }
    return null;
  }
  return { code: "ACTION_NOT_AVAILABLE" };
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
