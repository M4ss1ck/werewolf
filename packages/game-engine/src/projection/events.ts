import type { GameEvent, UserId } from "@werewolf/protocol";
import type { GameState } from "../state.ts";
import { canViewEvent } from "./permissions.ts";

export function filterVisibleEvents(
  events: readonly GameEvent[],
  viewer: UserId,
  state: GameState,
): GameEvent[] {
  return events.filter((event) => canViewEvent(event, viewer, state));
}
