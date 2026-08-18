import type { GameEvent, UserId } from "@werewolf/protocol";
import { WOLF_CHAT_ROLES } from "../roles/registry.ts";
import type { GameState } from "../state.ts";

export function canViewEvent(event: GameEvent, viewer: UserId, state: GameState): boolean {
  if (event.scope === "public" || event.scope === "server") return event.scope === "public";
  if (event.scope === "player") return event.scopeId === viewer;
  if (event.scope !== "faction" || event.scopeId !== "wolves") return false;

  const player = state.players[viewer];
  if (!player || player.role === null || !WOLF_CHAT_ROLES.has(player.role)) return false;

  // A starting wolf sees the whole faction history.
  if (player.originalRole !== null && WOLF_CHAT_ROLES.has(player.originalRole)) return true;

  // Anyone else in the wolf faction got there by conversion and may only read
  // from that moment on. The marker is written when the conversion event is
  // persisted, so treat a missing one as "not yet entitled" and fail closed:
  // failing open would hand a freshly converted Cursed every earlier wolf
  // message.
  if (player.wolfSinceEventId === undefined) return false;
  return event.id >= player.wolfSinceEventId;
}
