import type { GameplayCommand, UserId } from "@werewolf/protocol";
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
    if (player.faction !== "wolves") return { code: "CHANNEL_NOT_AVAILABLE" };
    if (player.status !== "alive") return { code: "CHAT_READ_ONLY" };
    return null;
  }
  if (player.status !== "alive") return { code: "NOT_ALIVE" };
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
    switch (command.payload.action) {
      case "wolf.attack":
        if (player.faction !== "wolves") return { code: "ACTION_NOT_AVAILABLE" };
        if (!target || target.status !== "alive" || target.faction === "wolves")
          return { code: "INVALID_TARGET" };
        return null;
      case "seer.inspect":
        if (player.role !== "seer") return { code: "ACTION_NOT_AVAILABLE" };
        if (!target || target.status !== "alive" || target.id === actorId)
          return { code: "INVALID_TARGET" };
        return null;
      case "harlot.visit":
        if (player.role !== "harlot") return { code: "ACTION_NOT_AVAILABLE" };
        if (!target || target.status !== "alive" || target.id === actorId)
          return { code: "INVALID_TARGET" };
        return null;
      case "harlot.stay":
        if (player.role !== "harlot") return { code: "ACTION_NOT_AVAILABLE" };
        return null;
    }
  }
  return { code: "ACTION_NOT_AVAILABLE" };
}
