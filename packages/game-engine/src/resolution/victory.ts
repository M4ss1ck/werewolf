import type { FactionId } from "@werewolf/protocol";
import type { GameState, PlayerState, VictoryResult } from "../state.ts";

export function checkVictory(state: GameState): VictoryResult | null {
  const living = Object.values(state.players).filter((player) => player.status === "alive");
  const wolves = living.filter((player) => player.faction === "wolves");
  const villagers = living.filter((player) => player.faction === "village");
  if (wolves.length === 0) {
    const winners = Object.values(state.players).filter((player) => player.faction === "village");
    return makeVictory("village", winners, "wolves_eliminated");
  }
  if (wolves.length >= villagers.length) {
    const winners = Object.values(state.players).filter((player) => player.faction === "wolves");
    return makeVictory("wolves", winners, "wolves_outnumber");
  }
  return null;
}

function makeVictory(
  faction: FactionId,
  players: PlayerState[],
  reason: VictoryResult["reason"],
): VictoryResult {
  return { winningFactions: [faction], winningPlayers: players.map((player) => player.id), reason };
}
