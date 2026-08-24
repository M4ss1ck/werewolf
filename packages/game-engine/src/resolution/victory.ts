import type { FactionId, UserId } from "@werewolf/protocol";
import { STALEMATE_NIGHTS } from "../composer/balance-v1.ts";
import { getRoleDefinition } from "../roles/registry.ts";
import type { EventDraft, GameState, PlayerPatch, PlayerState, VictoryResult } from "../state.ts";
import { getLinkPair } from "./link.ts";

type Bloc = PlayerState[];

const HISTORICAL_FACTION_PRECEDENCE = ["serial_killer", "wolves", "cult", "village"] as const;

export function checkVictory(state: GameState): VictoryResult | null {
  const living = Object.values(state.players).filter((player) => player.status === "alive");
  if (living.length === 0) {
    return { winningFactions: [], winningPlayers: [], reason: "no_survivors" };
  }

  const blocs = getBlocs(state, living);
  const undoomed = blocs.filter((bloc) => !isDoomed(bloc, blocs, living.length));
  if (undoomed.length === 1) {
    const bloc = undoomed[0]!;
    const faction = winningFaction(bloc);
    if (faction && faction !== "veteran") {
      return applyLoverRider(state, makeVictory(faction, state.players, reasonFor(faction)));
    }
  }

  if (undoomed.length === 0) {
    return { winningFactions: [], winningPlayers: [], reason: "stalemate" };
  }
  if (state.nightsWithoutElimination >= STALEMATE_NIGHTS) {
    return { winningFactions: [], winningPlayers: [], reason: "stalemate" };
  }
  return null;
}

export function finishOffLosers(
  state: GameState,
  winner: VictoryResult,
): { playerPatches: PlayerPatch[]; event: EventDraft<"players.finished_off"> | null } {
  const winningFaction = winner.winningFactions[0];
  if (!winningFaction) return { playerPatches: [], event: null };
  const winningPlayers = new Set(winner.winningPlayers);
  const playerIds = Object.values(state.players)
    .filter((player) => player.status === "alive" && !winningPlayers.has(player.id))
    .map((player) => player.id)
    .sort((a, b) => a.localeCompare(b));
  if (playerIds.length === 0) return { playerPatches: [], event: null };
  return {
    playerPatches: playerIds.map((playerId) => ({ playerId, changes: { status: "dead" } })),
    event: {
      kind: "players.finished_off",
      scope: "public",
      payload: { playerIds, winningFaction },
    },
  };
}

function contests(player: PlayerState): boolean {
  return (
    player.role !== null &&
    getRoleDefinition(player.role).contests?.({ roleState: player.roleState }) === true
  );
}

function getBlocs(state: GameState, living: PlayerState[]): Bloc[] {
  const pair = getLinkPair(state);
  const ordered = [...living].sort((a, b) => a.id.localeCompare(b.id));
  const remaining = new Set(ordered);
  const blocs: Bloc[] = [];
  while (remaining.size > 0) {
    const seed = remaining.values().next().value!;
    remaining.delete(seed);
    const bloc = [seed];
    let changed = true;
    while (changed) {
      changed = false;
      for (const player of remaining) {
        if (bloc.some((member) => sameBloc(pair, member, player))) {
          bloc.push(player);
          remaining.delete(player);
          changed = true;
        }
      }
    }
    blocs.push(bloc);
  }
  return blocs;
}

function isDoomed(bloc: Bloc, blocs: Bloc[], livingCount: number): boolean {
  if (bloc.some(contests)) return false;
  let hasOpponent = false;
  for (const opponent of blocs) {
    if (opponent === bloc) continue;
    hasOpponent = true;
    if (opponent.length * 2 >= livingCount) return true;
  }
  return !hasOpponent && !bloc.some((player) => player.faction === "village");
}

function winningFaction(bloc: Bloc): FactionId | null {
  for (const faction of HISTORICAL_FACTION_PRECEDENCE) {
    if (bloc.some((player) => player.faction === faction)) return faction;
  }
  return null;
}

function reasonFor(faction: FactionId): VictoryResult["reason"] {
  if (faction === "wolves") return "village_eliminated";
  if (faction === "serial_killer") return "serial_killer_survives";
  if (faction === "cult") return "cult_survives";
  return "wolves_eliminated";
}

function applyLoverRider(state: GameState, result: VictoryResult): VictoryResult {
  const pair = getLinkPair(state);
  const winners = new Set(result.winningPlayers);
  for (const winner of result.winningPlayers) {
    const partner = loverPartner(pair, winner);
    if (partner) winners.add(partner);
  }
  return { ...result, winningPlayers: [...winners] };
}

export { applyLoverRider };

function makeVictory(
  faction: FactionId,
  players: Record<string, PlayerState>,
  reason: VictoryResult["reason"],
): VictoryResult {
  return {
    winningFactions: [faction],
    winningPlayers: Object.values(players)
      .filter((player) => player.faction === faction)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((player) => player.id),
    reason,
  };
}

function loverPartner(pair: readonly [UserId, UserId] | null, playerId: UserId): UserId | null {
  if (!pair?.includes(playerId)) return null;
  return pair[0] === playerId ? pair[1] : pair[0];
}

function sameBloc(pair: readonly [UserId, UserId] | null, a: PlayerState, b: PlayerState): boolean {
  return a.faction === b.faction || loverPartner(pair, a.id) === b.id;
}
