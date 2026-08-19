import type { ActionId, GameplayCommand, UserId } from "@werewolf/protocol";
import { getActionSpecsFor } from "../roles/action-spec.ts";
import { CULT_CHAT_ROLES, WOLF_CHAT_ROLES } from "../roles/registry.ts";
import { resolveTargets } from "../roles/targets.ts";
import type { DomainError, GameState, PlayerState } from "../state.ts";

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
    if (command.payload.channel === "cult") {
      // The cult channel is for the cult: the leader and converted cultists,
      // alive. Mirrors the wolves channel.
      if (player.role === null || !CULT_CHAT_ROLES.has(player.role))
        return { code: "CHANNEL_NOT_AVAILABLE" };
      if (player.status !== "alive") return { code: "CHAT_READ_ONLY" };
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
    return validateActionPayload(state, player, command.payload);
  }
  if (command.type === "day.action.set") {
    if (state.phase.type !== "discussion" && state.phase.type !== "voting")
      return { code: "ACTION_NOT_AVAILABLE" };
    return validateActionPayload(state, player, command.payload);
  }
  return { code: "ACTION_NOT_AVAILABLE" };
}

function validateActionPayload(
  state: GameState,
  player: PlayerState,
  payload: { action: string; targetId?: UserId; targetIds?: UserId[] },
): DomainError | null {
  const actionId = payload.action as ActionId;
  // Availability is exactly what the projection offers: one model, so a
  // client cannot render a control the server would reject, and a bot
  // cannot pick a move that is not really legal.
  const spec = getActionSpecsFor(state, player).find((candidate) => candidate.id === actionId);
  if (!spec) return { code: "ACTION_NOT_AVAILABLE" };

  if (spec.target === null) return null;

  const eligible = new Set(
    resolveTargets(spec, player, state)
      .filter((target) => target.enabled)
      .map((target) => target.userId),
  );

  if (spec.target.kind === "pair") {
    if (!("targetIds" in payload) || payload.targetIds === undefined)
      return { code: "INVALID_TARGET" };
    const [first, second] = payload.targetIds;
    if (!first || !second || first === second) return { code: "INVALID_TARGET" };
    for (const targetId of payload.targetIds)
      if (!eligible.has(targetId)) return { code: "INVALID_TARGET" };
    return null;
  }

  if (!("targetId" in payload) || payload.targetId === undefined) return { code: "INVALID_TARGET" };
  return eligible.has(payload.targetId) ? null : { code: "INVALID_TARGET" };
}
