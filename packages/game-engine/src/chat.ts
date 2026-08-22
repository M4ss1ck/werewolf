import type { ChatChannel, UserId } from "@werewolf/protocol";
import { CULT_CHAT_ROLES, WOLF_CHAT_ROLES } from "./roles/registry.ts";
import type { GameState, PlayerState } from "./state.ts";

export function projectedPlayerLabel(player: PlayerState): string {
  return player.displayName ?? player.id;
}

export function hasChatReadEntitlement(
  player: PlayerState | undefined,
  channel: ChatChannel,
): boolean {
  if (channel === "public") return true;
  if (!player) return false;
  if (channel === "grave") return player.status === "dead";

  const roles = channel === "wolves" ? WOLF_CHAT_ROLES : CULT_CHAT_ROLES;
  if (player.role === null || !roles.has(player.role)) return false;
  if (player.originalRole !== null && roles.has(player.originalRole)) return true;
  return player.channelSince?.[channel] !== undefined;
}

export function availableChatChannels(player: PlayerState | undefined): ChatChannel[] {
  if (!player) return ["public"];
  const channels: ChatChannel[] = ["public"];
  if (hasChatReadEntitlement(player, "wolves")) channels.push("wolves");
  if (hasChatReadEntitlement(player, "cult")) channels.push("cult");
  if (hasChatReadEntitlement(player, "grave")) channels.push("grave");
  return channels;
}

function sortById(players: PlayerState[]): PlayerState[] {
  return players.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

function secretMentionTargets(
  state: GameState,
  actor: PlayerState,
  channel: Extract<ChatChannel, "wolves" | "cult">,
): PlayerState[] {
  const roles = channel === "wolves" ? WOLF_CHAT_ROLES : CULT_CHAT_ROLES;
  const candidates = Object.values(state.players).filter(
    (player) =>
      player.id !== actor.id && player.status !== "lobby" && player.status !== "spectator",
  );

  if (actor.originalRole !== null && roles.has(actor.originalRole)) {
    return sortById(candidates.filter((player) => hasChatReadEntitlement(player, channel)));
  }

  const actorSince = actor.channelSince?.[channel];
  if (actorSince === undefined) return [];
  return sortById(
    candidates.filter((player) => {
      const targetSince = player.channelSince?.[channel];
      return (
        hasChatReadEntitlement(player, channel) &&
        (player.originalRole === null || !roles.has(player.originalRole)) &&
        targetSince !== undefined &&
        targetSince >= actorSince
      );
    }),
  );
}

export function knownMentionTargets(
  state: GameState,
  actorId: UserId,
  channel: ChatChannel,
): PlayerState[] {
  const actor = state.players[actorId];
  if (!actor || !hasChatReadEntitlement(actor, channel)) return [];

  if (channel === "public") {
    return sortById(
      Object.values(state.players).filter(
        (player) =>
          player.id !== actor.id && (player.status === "alive" || player.status === "dead"),
      ),
    );
  }
  if (channel === "grave") {
    return sortById(
      Object.values(state.players).filter(
        (player) => player.id !== actor.id && player.status === "dead",
      ),
    );
  }
  return secretMentionTargets(state, actor, channel);
}
