import type { UserId, VoteChoice } from "@werewolf/protocol";
import { getRoleDefinition } from "../roles/registry.ts";
import type { DomainResult, DomainTransition, GameState, PlayerState } from "../state.ts";
import { checkVictory } from "./victory.ts";

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
  const eliminatedId: UserId | null = winners.length === 1 ? winners[0]![0] : null;
  const tallyPayload = [...tally.entries()].map(([targetId, count]) => ({ targetId, count }));
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
      }
    }
  }
  const projected = applyPatches(state, playerPatches);
  const winner = checkVictory(projected);
  if (winner) {
    events.push({ kind: "game.finished", scope: "public", payload: winner });
    return {
      ok: true,
      transition: {
        gamePatch: { status: "finished", winner },
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
function applyPatches(state: GameState, patches: DomainTransition["playerPatches"]): GameState {
  const players = { ...state.players };
  for (const patch of patches)
    players[patch.playerId] = { ...players[patch.playerId]!, ...patch.changes };
  return { ...state, players };
}
