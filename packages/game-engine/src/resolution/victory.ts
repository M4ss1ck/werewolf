import type { FactionId } from "@werewolf/protocol";
import { STALEMATE_NIGHTS } from "../composer/balance-v1.ts";
import type { GameState, PlayerState, VictoryResult } from "../state.ts";

export function checkVictory(state: GameState): VictoryResult | null {
  const living = Object.values(state.players).filter((player) => player.status === "alive");

  // 1. Nobody is left alive.
  if (living.length === 0) {
    return { winningFactions: [], winningPlayers: [], reason: "no_survivors" };
  }

  // 2. Every living player is a serial killer.
  if (living.every((player) => player.faction === "serial_killer")) {
    const winners = Object.values(state.players).filter(
      (player) => player.faction === "serial_killer",
    );
    return makeVictory("serial_killer", winners, "serial_killer_survives");
  }

  // 3. Every living player is a wolf.
  if (living.every((player) => player.faction === "wolves")) {
    const winners = Object.values(state.players).filter((player) => player.faction === "wolves");
    return makeVictory("wolves", winners, "village_eliminated");
  }

  // 4. No wolves and no serial killers remain, but at least one villager does.
  if (
    !living.some((player) => player.faction === "wolves") &&
    !living.some((player) => player.faction === "serial_killer") &&
    living.some((player) => player.faction === "village")
  ) {
    const winners = Object.values(state.players).filter((player) => player.faction === "village");
    return makeVictory("village", winners, "wolves_eliminated");
  }

  // 5. Five consecutive nights with no elimination end the game in a draw.
  if (state.nightsWithoutElimination >= STALEMATE_NIGHTS) {
    return { winningFactions: [], winningPlayers: [], reason: "stalemate" };
  }

  // 6. The game continues.
  return null;
}

function makeVictory(
  faction: FactionId,
  players: PlayerState[],
  reason: VictoryResult["reason"],
): VictoryResult {
  return { winningFactions: [faction], winningPlayers: players.map((player) => player.id), reason };
}
