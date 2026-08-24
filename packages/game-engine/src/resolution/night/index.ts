import type { UserId } from "@werewolf/protocol";
import type { SeededRng } from "../../rng/rng.ts";
import type { DomainResult, GameState } from "../../state.ts";
import { checkVictory, finishOffLosers } from "../victory.ts";
import { resolveHouseAttacks } from "./attacks.ts";
import {
  applyLoverLinkDeaths,
  applyPatches,
  commitNight,
  formLink,
  makeNightEvents,
  roleStatePatches,
} from "./events.ts";
import { freezeNightIntents, type Intent, intentsFor } from "./freeze.ts";
import { resolveNightLocations } from "./locations.ts";
import { rollNight } from "./rolls.ts";

export interface NightResolutionContext {
  now: number;
  rng: SeededRng;
}

export function resolveNight(state: GameState, context: NightResolutionContext): DomainResult {
  if (!state.phase || state.phase.type !== "night")
    return { ok: false, error: { code: "ACTION_NOT_AVAILABLE" } };
  const frozen = freezeNightIntents(state);
  const rolls = rollNight(state, frozen, context.rng, state.day);
  const targetId = resolveWolfBallot(intentsFor(frozen, "wolf.attack"));
  const locations = resolveNightLocations(state, frozen, targetId);
  const outcome = resolveHouseAttacks({
    state,
    frozen,
    locations,
    rng: context.rng,
    day: state.day,
    wolfTargetId: targetId,
    attacks: [],
    repelled: new Set(),
    hits: new Map(),
    deaths: new Map(),
    conversions: [],
    ascension: null,
    loneWolfResult: null,
    protectedId: null,
  });
  applyLoverLinkDeaths(state, outcome.deaths);
  const link = formLink(state, frozen);
  const playerPatches = [
    ...commitNight(outcome),
    ...link.patches,
    ...roleStatePatches(state, frozen),
  ];
  const nextNightsWithoutElimination =
    outcome.deaths.size > 0 ? 0 : state.nightsWithoutElimination + 1;
  const projected = {
    ...applyPatches(state, playerPatches),
    nightsWithoutElimination: nextNightsWithoutElimination,
  };
  const events = [...makeNightEvents(state, frozen, targetId, outcome, rolls), ...link.events];
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
          nightsWithoutElimination: nextNightsWithoutElimination,
        },
        playerPatches,
        events,
        ephemeral: [],
      },
    };
  }
  const nextPhase = {
    id: (state.phase.id + 1) as typeof state.phase.id,
    type: "discussion" as const,
    startedAt: context.now,
    endsAt: context.now + state.settings.discussionDurationMs,
  };
  events.push({
    kind: "phase.started",
    scope: "public",
    payload: {
      phaseId: nextPhase.id,
      type: nextPhase.type,
      startedAt: nextPhase.startedAt,
      endsAt: nextPhase.endsAt,
    },
  });
  return {
    ok: true,
    transition: {
      gamePatch: {
        day: state.day + 1,
        phase: nextPhase,
        nightsWithoutElimination: nextNightsWithoutElimination,
      },
      playerPatches,
      events,
      ephemeral: [],
    },
  };
}

function resolveWolfBallot(votes: readonly Intent[]): UserId | null {
  const tally = new Map<UserId, number>();
  for (const vote of votes) tally.set(vote.targetId!, (tally.get(vote.targetId!) ?? 0) + 1);
  const highest = Math.max(0, ...tally.values());
  const winners = [...tally.entries()].filter(([, count]) => count === highest && count > 0);
  return winners.length === 1 ? winners[0]![0] : null;
}
