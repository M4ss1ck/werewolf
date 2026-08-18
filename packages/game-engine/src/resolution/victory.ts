import type { FactionId } from "@werewolf/protocol";
import type { GameState, PlayerState, VictoryResult } from "../state.ts";

export function checkVictory(state: GameState): VictoryResult | null {
  const living = Object.values(state.players).filter((player) => player.status === "alive");
  if (living.length === 1 && living[0]!.faction === "serial_killer") {
    const winners = Object.values(state.players).filter(
      (player) => player.faction === "serial_killer",
    );
    return makeVictory("serial_killer", winners, "serial_killer_survives");
  }
  const wolves = living.filter((player) => player.faction === "wolves");
  if (wolves.length > 0 && wolves.length === living.length) {
    const winners = Object.values(state.players).filter((player) => player.faction === "wolves");
    return makeVictory("wolves", winners, "village_eliminated");
  }
  const serialKillers = living.filter((player) => player.faction === "serial_killer");
  if (wolves.length === 0 && serialKillers.length === 0) {
    const winners = Object.values(state.players).filter((player) => player.faction === "village");
    return makeVictory("village", winners, "wolves_eliminated");
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
