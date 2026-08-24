import type { UserId, VoteChoice } from "@werewolf/protocol";
import { getRoleDefinition } from "../roles/registry.ts";
import type {
  DomainResult,
  DomainTransition,
  GameState,
  PlayerState,
  VictoryResult,
} from "../state.ts";
import { loverPartner } from "./link.ts";
import { applyLoverRider, checkVictory, finishOffLosers } from "./victory.ts";

export function resolveDayVote(state: GameState): DomainResult {
  if (!state.phase || state.phase.type !== "voting")
    return { ok: false, error: { code: "ACTION_NOT_AVAILABLE" } };
  const living = Object.values(state.players).filter((player) => player.status === "alive");
  const tally = new Map<UserId, number>();
  let abstain = 0;
  const choices: { playerId: PlayerState["id"]; choice: VoteChoice }[] = [];
  for (const player of living) {
    const vote = player.phaseState.phaseId === state.phase.id ? player.phaseState.vote : undefined;
    if (!vote) choices.push({ playerId: player.id, choice: { type: "none" } });
    else if (vote.type === "abstain") {
      abstain += 1;
      choices.push({ playerId: player.id, choice: vote });
    } else {
      tally.set(vote.targetId, (tally.get(vote.targetId) ?? 0) + 1);
      choices.push({ playerId: player.id, choice: vote });
    }
  }
  const highest = Math.max(0, ...tally.values());
  const winners = [...tally.entries()].filter(([, count]) => count === highest && count > 0);
  const tallyWinner: UserId | null = winners.length === 1 ? winners[0]![0] : null;
  const tallyPayload = [...tally.entries()].map(([targetId, count]) => ({ targetId, count }));
  // The Mayor may override the day's elimination outright. Find a LIVING mayor
  // whose once-per-game action was used today; the override replaces the tally
  // winner. A pardon (null target) or a target dead at resolution eliminates
  // nobody. The tallies above are still published as they really were.
  const mayorOverride = Object.values(state.players).find(
    (player) =>
      player.status === "alive" &&
      player.role === "mayor" &&
      isMayorState(player.roleState) &&
      player.roleState.used &&
      player.roleState.overrideDay === state.day,
  );
  let eliminatedId: UserId | null = tallyWinner;
  if (mayorOverride && isMayorState(mayorOverride.roleState)) {
    const target = mayorOverride.roleState.overrideTarget;
    if (target === null) {
      eliminatedId = null;
    } else {
      const targetPlayer = state.players[target];
      eliminatedId = targetPlayer && targetPlayer.status === "alive" ? target : null;
    }
  }
  const events: DomainTransition["events"] = [
    {
      kind: "vote.resolved",
      scope: "public",
      payload: {
        phaseId: state.phase.id,
        eliminated: eliminatedId,
        tallies: tallyPayload,
        abstain,
        noVote: living.length - abstain - [...tally.values()].reduce((a, b) => a + b, 0),
      },
    },
    { kind: "audit.vote", scope: "server", payload: { phaseId: state.phase.id, votes: choices } },
  ];
  const playerPatches: DomainTransition["playerPatches"] = [];
  let selected: PlayerState | undefined;
  if (eliminatedId) {
    selected = state.players[eliminatedId];
    if (selected && selected.status === "alive") {
      if (selected.role === "veteran") {
        playerPatches.push({ playerId: selected.id, changes: { status: "dead" } });
        events.push({
          kind: "player.eliminated",
          scope: "public",
          payload: { playerId: selected.id, role: selected.role, cause: "day_vote" },
        });
        const partner = loverPartner(state, selected.id, new Set([selected.id]));
        if (partner) {
          playerPatches.push({ playerId: partner, changes: { status: "dead" } });
          events.push({
            kind: "player.eliminated",
            scope: "public",
            payload: { playerId: partner, role: state.players[partner]!.role!, cause: "day_vote" },
          });
        }
        const winner: VictoryResult = applyLoverRider(state, {
          winningFactions: ["veteran"],
          winningPlayers: [selected.id],
          reason: "veteran_lynched",
        });
        events.push({ kind: "game.finished", scope: "public", payload: winner });
        return {
          ok: true,
          transition: {
            gamePatch: { status: "finished", winner, nightsWithoutElimination: 0 },
            playerPatches,
            events,
            ephemeral: [],
          },
        };
      }
      const princessState =
        selected.role === "princess" && isPrincessState(selected.roleState)
          ? selected.roleState
          : null;
      const effects =
        selected.role === "princess"
          ? (getRoleDefinition("princess").onDaySelected?.({
              playerId: selected.id,
              state: princessState ?? { lynchProtectionUsed: false },
            }) ?? [])
          : [];
      const protectedByPrincess = effects.some((effect) => effect.type === "survive");
      if (protectedByPrincess) {
        const nextState = effects.find((effect) => effect.type === "setState")?.value;
        playerPatches.push({ playerId: selected.id, changes: { roleState: nextState } });
        events.push({
          kind: "princess.revealed",
          scope: "public",
          payload: { playerId: selected.id },
        });
      } else {
        playerPatches.push({ playerId: selected.id, changes: { status: "dead" } });
        events.push({
          kind: "player.eliminated",
          scope: "public",
          payload: { playerId: selected.id, role: selected.role!, cause: "day_vote" },
        });
        const partner = loverPartner(state, selected.id, new Set([selected.id]));
        if (partner) {
          playerPatches.push({ playerId: partner, changes: { status: "dead" } });
          events.push({
            kind: "player.eliminated",
            scope: "public",
            payload: { playerId: partner, role: state.players[partner]!.role!, cause: "day_vote" },
          });
        }
      }
    }
  }
  const eliminated = playerPatches.some((patch) => patch.changes.status === "dead");
  // The Alpha's death ends the Lone Wolf's hunt. Ascension is the Lone Wolf's
  // only path to the Alpha's seat, so if the last living Alpha Wolf was
  // eliminated this vote and a Lone Wolf is still alive, the Lone Wolf
  // converts to a plain werewolf and wins with the pack from then on.
  const deadIds = new Set(
    playerPatches.filter((patch) => patch.changes.status === "dead").map((patch) => patch.playerId),
  );
  const livingAlpha = Object.values(state.players).find(
    (player) =>
      player.role === "alpha_wolf" && player.status === "alive" && !deadIds.has(player.id),
  );
  const livingLoneWolf = Object.values(state.players).find(
    (player) => player.role === "lone_wolf" && player.status === "alive" && !deadIds.has(player.id),
  );
  if (!livingAlpha && livingLoneWolf) {
    playerPatches.push({
      playerId: livingLoneWolf.id,
      changes: { role: "werewolf", faction: "wolves" },
    });
    events.push({
      kind: "player.converted",
      scope: "player",
      scopeId: livingLoneWolf.id,
      payload: { role: "werewolf", faction: "wolves", cause: "alpha_dead" },
    });
    events.push({
      kind: "wolves.member_joined",
      scope: "faction",
      scopeId: "wolves",
      payload: { playerId: livingLoneWolf.id },
    });
  }
  const projected = {
    ...applyPatches(state, playerPatches),
    nightsWithoutElimination: eliminated ? 0 : state.nightsWithoutElimination,
  };
  const winner = checkVictory(projected);
  if (winner) {
    const terminal = finishOffLosers(projected, winner);
    playerPatches.push(...terminal.playerPatches);
    if (terminal.event) events.push(terminal.event);
    events.push({ kind: "game.finished", scope: "public", payload: winner });
    return {
      ok: true,
      transition: {
        gamePatch: {
          status: "finished",
          winner,
          nightsWithoutElimination: eliminated ? 0 : state.nightsWithoutElimination,
        },
        playerPatches,
        events,
        ephemeral: [],
      },
    };
  }
  if (eliminated) {
    return {
      ok: true,
      transition: {
        gamePatch: { nightsWithoutElimination: 0 },
        playerPatches,
        events,
        ephemeral: [],
      },
    };
  }
  return { ok: true, transition: { playerPatches, events, ephemeral: [] } };
}

function isPrincessState(value: unknown): value is { lynchProtectionUsed: boolean } {
  return (
    typeof value === "object" &&
    value !== null &&
    "lynchProtectionUsed" in value &&
    typeof (value as { lynchProtectionUsed: unknown }).lynchProtectionUsed === "boolean"
  );
}
function isMayorState(
  value: unknown,
): value is { used: boolean; overrideDay: number | null; overrideTarget: UserId | null } {
  return (
    typeof value === "object" &&
    value !== null &&
    "used" in value &&
    typeof (value as { used: unknown }).used === "boolean"
  );
}
function applyPatches(state: GameState, patches: DomainTransition["playerPatches"]): GameState {
  const players = { ...state.players };
  for (const patch of patches)
    players[patch.playerId] = { ...players[patch.playerId]!, ...patch.changes };
  return { ...state, players };
}
