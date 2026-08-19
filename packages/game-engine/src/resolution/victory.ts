import type { FactionId } from "@werewolf/protocol";
import { STALEMATE_NIGHTS } from "../composer/balance-v1.ts";
import type { GameState, PlayerState, VictoryResult } from "../state.ts";
import { getLinkPair } from "./link.ts";

export function checkVictory(state: GameState): VictoryResult | null {
  const living = Object.values(state.players).filter((player) => player.status === "alive");

  let result: VictoryResult | null = null;

  // 1. Nobody is left alive.
  if (living.length === 0) {
    result = { winningFactions: [], winningPlayers: [], reason: "no_survivors" };
  }
  // 2. Every living player is a serial killer.
  else if (living.every((player) => player.faction === "serial_killer")) {
    const winners = Object.values(state.players).filter(
      (player) => player.faction === "serial_killer",
    );
    result = makeVictory("serial_killer", winners, "serial_killer_survives");
  }
  // 3. Every living player is a wolf.
  else if (living.every((player) => player.faction === "wolves")) {
    const winners = Object.values(state.players).filter((player) => player.faction === "wolves");
    result = makeVictory("wolves", winners, "village_eliminated");
  }
  // 4. Every living player is a cultist.
  else if (living.every((player) => player.faction === "cult")) {
    const winners = Object.values(state.players).filter((player) => player.faction === "cult");
    result = makeVictory("cult", winners, "cult_survives");
  }
  // 5. No wolves, no serial killers and no cultists remain, but at least one
  // villager does. The "no living cult" guard is essential: without it a
  // village with one survivor and three cultists alive would report a village
  // win.
  else if (
    !living.some((player) => player.faction === "wolves") &&
    !living.some((player) => player.faction === "serial_killer") &&
    !living.some((player) => player.faction === "cult") &&
    living.some((player) => player.faction === "village")
  ) {
    const winners = Object.values(state.players).filter((player) => player.faction === "village");
    result = makeVictory("village", winners, "wolves_eliminated");
  }
  // 6. Five consecutive nights with no elimination end the game in a draw.
  else if (state.nightsWithoutElimination >= STALEMATE_NIGHTS) {
    result = { winningFactions: [], winningPlayers: [], reason: "stalemate" };
  }

  // 7. The game continues.
  if (result === null) return null;

  // Lover rider: whichever of an established pair is on a winning side carries
  // the other into the winners. winningFactions stays a statement about
  // factions; winningPlayers becomes the union of faction members plus riders.
  if (result.winningFactions.length > 0) result = applyLoverRider(state, result);
  return result;
}

function applyLoverRider(state: GameState, result: VictoryResult): VictoryResult {
  const pair = getLinkPair(state);
  if (!pair) return result;
  const [a, b] = pair;
  const winners = new Set(result.winningPlayers);
  if (winners.has(a) && !winners.has(b)) winners.add(b);
  else if (winners.has(b) && !winners.has(a)) winners.add(a);
  return { ...result, winningPlayers: [...winners] };
}

export { applyLoverRider };

function makeVictory(
  faction: FactionId,
  players: PlayerState[],
  reason: VictoryResult["reason"],
): VictoryResult {
  return { winningFactions: [faction], winningPlayers: players.map((player) => player.id), reason };
}
