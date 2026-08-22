import type { GameEvent, UserId } from "@werewolf/protocol";
import { hasChatReadEntitlement } from "../chat.ts";
import { CULT_CHAT_ROLES, WOLF_CHAT_ROLES } from "../roles/registry.ts";
import type { GameState } from "../state.ts";

export function canViewEvent(event: GameEvent, viewer: UserId, state: GameState): boolean {
  if (event.scope === "public" || event.scope === "server") return event.scope === "public";
  if (event.scope === "player") return event.scopeId === viewer;
  if (event.scope !== "faction") return false;

  const player = state.players[viewer];
  if (!player) return false;

  if (event.scopeId === "grave") {
    // The graveyard is a room: the dead see the whole history, including
    // messages from before they died. A spectator who never played is not dead.
    return player.status === "dead";
  }

  if (event.scopeId === "wolves") {
    if (!hasChatReadEntitlement(player, "wolves")) return false;

    // A starting wolf sees the whole faction history.
    if (player.originalRole !== null && WOLF_CHAT_ROLES.has(player.originalRole)) return true;

    // Anyone else in the wolf faction got there by conversion and may only read
    // from that moment on. The marker is written when the conversion event is
    // persisted, so treat a missing one as "not yet entitled" and fail closed:
    // failing open would hand a freshly converted Cursed every earlier wolf
    // message.
    const since = player.channelSince?.wolves;
    if (since === undefined) return false;
    return event.id >= since;
  }

  if (event.scopeId === "cult") {
    if (!hasChatReadEntitlement(player, "cult")) return false;

    // A starting cult member (the leader) sees the whole faction history.
    if (player.originalRole !== null && CULT_CHAT_ROLES.has(player.originalRole)) return true;

    // Anyone else got there by conversion and may only read from that moment
    // on. A missing marker fails closed: a freshly converted cultist must not
    // read the cult's earlier messages.
    const since = player.channelSince?.cult;
    if (since === undefined) return false;
    return event.id >= since;
  }

  return false;
}
