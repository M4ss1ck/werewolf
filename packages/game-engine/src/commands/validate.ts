import {
  type ActionId,
  CHAT_MAX_MENTION_RECIPIENTS,
  type ChatChannel,
  type ChatMention,
  type GameplayCommand,
  type UserId,
} from "@werewolf/protocol";
import { hasChatReadEntitlement, knownMentionTargets, projectedPlayerLabel } from "../chat.ts";
import { getActionSpecsFor } from "../roles/action-spec.ts";
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
    } else if (command.payload.channel === "grave") {
      // The dead may speak in the graveyard in every phase, including night.
      // A spectator who never played is not dead and must not sit in it.
      if (player.status !== "dead") return { code: "CHANNEL_NOT_AVAILABLE" };
    } else if (command.payload.channel === "cult") {
      // The cult channel is for the cult: the leader and converted cultists,
      // alive. Mirrors the wolves channel.
      if (!hasChatReadEntitlement(player, "cult")) return { code: "CHANNEL_NOT_AVAILABLE" };
      if (player.status !== "alive") return { code: "CHAT_READ_ONLY" };
    } else {
      if (!hasChatReadEntitlement(player, "wolves")) return { code: "CHANNEL_NOT_AVAILABLE" };
      if (player.status !== "alive") return { code: "CHAT_READ_ONLY" };
    }
    return validateChatMentions(
      state,
      actorId,
      command.payload.channel,
      command.payload.text,
      command.payload.mentions,
    );
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

function validateChatMentions(
  state: GameState,
  actorId: UserId,
  channel: ChatChannel,
  text: string,
  mentions: ChatMention[] | undefined,
): DomainError | null {
  const normalizedMentions = mentions ?? [];
  if (
    new Set(normalizedMentions.map((mention) => mention.userId)).size > CHAT_MAX_MENTION_RECIPIENTS
  )
    return { code: "INVALID_MENTION" };

  const sorted = [...normalizedMentions].sort(
    (left, right) => left.start - right.start || left.length - right.length,
  );
  for (let index = 0; index < sorted.length; index += 1) {
    const mention = sorted[index]!;
    if (
      !Number.isInteger(mention.start) ||
      mention.start < 0 ||
      !Number.isInteger(mention.length) ||
      mention.length <= 0 ||
      mention.start + mention.length > text.length
    )
      return { code: "INVALID_MENTION" };
    const previous = sorted[index - 1];
    if (previous && mention.start < previous.start + previous.length)
      return { code: "INVALID_MENTION" };
  }

  const targets = new Map(
    knownMentionTargets(state, actorId, channel).map((target) => [target.id, target]),
  );
  for (const mention of normalizedMentions) {
    if (mention.userId === actorId) return { code: "INVALID_MENTION" };
    const target = targets.get(mention.userId);
    if (!target) return { code: "INVALID_MENTION" };
    if (
      text.slice(mention.start, mention.start + mention.length) !==
      `@${projectedPlayerLabel(target)}`
    )
      return { code: "INVALID_MENTION" };
  }
  return null;
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
