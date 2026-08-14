import type { NightDeathCause, RoleId, UserId } from "@werewolf/protocol";
import type { SeededRng } from "../rng/rng.ts";
import type {
  DomainResult,
  DomainTransition,
  GameState,
  PlayerPatch,
  PlayerState,
} from "../state.ts";
import { checkVictory } from "./victory.ts";

export interface NightResolutionContext {
  now: number;
  rng: SeededRng;
}

type FrozenNight = {
  wolfVotes: { playerId: UserId; targetId: UserId | null }[];
  seerInspection: { playerId: UserId; targetId: UserId; role: RoleId } | null;
  harlotAction:
    | { playerId: UserId; type: "stay" }
    | { playerId: UserId; type: "visit"; targetId: UserId }
    | null;
};

type NightOutcome = {
  targetId: UserId | null;
  deaths: Map<UserId, NightDeathCause>;
  conversions: UserId[];
};

export function resolveNight(state: GameState, context: NightResolutionContext): DomainResult {
  if (!state.phase || state.phase.type !== "night")
    return { ok: false, error: { code: "ACTION_NOT_AVAILABLE" } };
  const frozen = freezeNightIntents(state);
  const seer = frozen.seerInspection;
  const targetId = resolveWolfBallot(frozen.wolfVotes);
  const outcome = resolveNightConsequences(state, frozen, targetId, context.rng, state.day);
  const playerPatches = commitNight(outcome);
  const projected = applyPatches(state, playerPatches);
  const events = makeNightEvents(state, frozen, outcome, seer);
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
      gamePatch: { day: state.day + 1, phase: nextPhase },
      playerPatches,
      events,
      ephemeral: [],
    },
  };
}

function freezeNightIntents(state: GameState): FrozenNight {
  const phaseId = state.phase!.id;
  const living = Object.values(state.players).filter((player) => player.status === "alive");
  const wolfVotes = living
    .filter((player) => player.faction === "wolves")
    .map((player) => ({ player, action: currentAction(player, phaseId, "wolf.attack") }))
    .filter(({ action }) => action?.targetId && isLivingTarget(state, action.targetId))
    .map(({ player, action }) => ({ playerId: player.id, targetId: action!.targetId! }));
  const seer = living.find((player) => player.role === "seer");
  const seerAction = seer ? currentAction(seer, phaseId, "seer.inspect") : undefined;
  const seerInspection =
    seerAction?.targetId && isLivingTarget(state, seerAction.targetId)
      ? {
          playerId: seer!.id,
          targetId: seerAction.targetId,
          role: state.players[seerAction.targetId]!.role!,
        }
      : null;
  const harlot = living.find((player) => player.role === "harlot");
  const visit = harlot ? currentAction(harlot, phaseId, "harlot.visit") : undefined;
  const stay = harlot ? currentAction(harlot, phaseId, "harlot.stay") : undefined;
  const harlotAction =
    visit?.targetId && isLivingTarget(state, visit.targetId)
      ? { playerId: harlot!.id, type: "visit" as const, targetId: visit.targetId }
      : stay
        ? { playerId: harlot!.id, type: "stay" as const }
        : null;
  return { wolfVotes, seerInspection, harlotAction };
}

function currentAction(
  player: PlayerState,
  phaseId: NonNullable<GameState["phase"]>["id"],
  actionId: string,
) {
  return player.phaseState.phaseId === phaseId ? player.phaseState.actions?.[actionId] : undefined;
}

function isLivingTarget(state: GameState, targetId: UserId): boolean {
  return state.players[targetId]?.status === "alive";
}

function resolveWolfBallot(votes: FrozenNight["wolfVotes"]): UserId | null {
  const tally = new Map<UserId, number>();
  for (const vote of votes) tally.set(vote.targetId!, (tally.get(vote.targetId!) ?? 0) + 1);
  const highest = Math.max(0, ...tally.values());
  const winners = [...tally.entries()].filter(([, count]) => count === highest && count > 0);
  return winners.length === 1 ? winners[0]![0] : null;
}

function resolveNightConsequences(
  state: GameState,
  frozen: FrozenNight,
  targetId: UserId | null,
  rng: SeededRng,
  day: number,
): NightOutcome {
  const deaths = new Map<UserId, NightDeathCause>();
  const conversions: UserId[] = [];
  const target = targetId ? state.players[targetId] : undefined;
  const harlotVisit = frozen.harlotAction?.type === "visit" ? frozen.harlotAction : null;
  const harlotAway = Boolean(harlotVisit && target?.role === "harlot");
  let hunterRepelled = false;
  if (target && !harlotAway) {
    if (target.role === "cursed") {
      conversions.push(target.id);
    } else if (target.role === "hunter") {
      const survives = rng.derive(`night:${day}:hunter:retaliation`).float() < 0.5;
      if (survives) {
        hunterRepelled = true;
        const wolves = livingPlayers(state).filter((player) => player.faction === "wolves");
        if (wolves.length > 0) {
          const wolf = wolves[rng.derive(`night:${day}:hunter:wolf-victim`).int(wolves.length)]!;
          deaths.set(wolf.id, "hunter_retaliation");
        }
      } else deaths.set(target.id, "wolf_attack");
    } else deaths.set(target.id, "wolf_attack");
  }
  if (harlotVisit) {
    const visited = state.players[harlotVisit.targetId];
    const harlot = state.players[harlotVisit.playerId]!;
    if (visited?.faction === "wolves") deaths.set(harlot.id, "harlot_exposure");
    if (targetId === harlotVisit.targetId) {
      if (hunterRepelled) {
        deaths.delete(harlot.id);
      } else if (target?.role === "hunter" && deaths.has(target.id)) {
        deaths.set(harlot.id, "harlot_exposure");
      } else if (target?.role === "cursed") {
        deaths.set(harlot.id, "harlot_exposure");
      } else if (target && !harlotAway) {
        deaths.set(harlot.id, "harlot_exposure");
      }
    }
  }
  return { targetId, deaths, conversions };
}

function livingPlayers(state: GameState): PlayerState[] {
  return Object.values(state.players).filter((player) => player.status === "alive");
}

function commitNight(outcome: NightOutcome): PlayerPatch[] {
  const patches: PlayerPatch[] = [];
  for (const [playerId] of outcome.deaths) patches.push({ playerId, changes: { status: "dead" } });
  for (const playerId of outcome.conversions)
    patches.push({ playerId, changes: { role: "werewolf", faction: "wolves" } });
  return patches;
}

function makeNightEvents(
  state: GameState,
  frozen: FrozenNight,
  outcome: NightOutcome,
  seer: FrozenNight["seerInspection"],
): DomainTransition["events"] {
  const events: DomainTransition["events"] = [
    { kind: "night.resolved", scope: "public", payload: { deaths: [...outcome.deaths.keys()] } },
  ];
  for (const [playerId] of outcome.deaths) {
    const player = state.players[playerId]!;
    events.push({
      kind: "player.eliminated",
      scope: "public",
      // Every night death reports the same cause; the precise mechanism is
      // recorded only in the server-scope audit.night event below.
      payload: { playerId, role: player.role!, cause: "night" },
    });
  }
  if (seer)
    events.push({
      kind: "seer.result",
      scope: "player",
      scopeId: seer.playerId,
      payload: { targetId: seer.targetId, role: seer.role },
    });
  if (frozen.harlotAction) {
    const killed = [...outcome.deaths.keys()].includes(frozen.harlotAction.playerId);
    events.push({
      kind: "harlot.result",
      scope: "player",
      scopeId: frozen.harlotAction.playerId,
      payload: { outcome: killed ? "killed" : "safe" },
    });
  }
  for (const playerId of outcome.conversions) {
    events.push({
      kind: "cursed.converted",
      scope: "player",
      scopeId: playerId,
      payload: { role: "werewolf", faction: "wolves" },
    });
    events.push({
      kind: "wolves.member_joined",
      scope: "faction",
      scopeId: "wolves",
      payload: { playerId },
    });
  }
  events.push({
    kind: "audit.night",
    scope: "server",
    payload: {
      phaseId: state.phase!.id,
      wolfVotes: frozen.wolfVotes,
      wolfTarget: outcome.targetId,
      seerInspection: seer ? { targetId: seer.targetId, role: seer.role } : null,
      harlotAction: frozen.harlotAction
        ? frozen.harlotAction.type === "visit"
          ? { type: "visit", targetId: frozen.harlotAction.targetId }
          : { type: "stay" }
        : null,
      deaths: [...outcome.deaths.entries()].map(([playerId, cause]) => ({ playerId, cause })),
      conversions: outcome.conversions,
    },
  });
  return events;
}

function applyPatches(state: GameState, patches: PlayerPatch[]): GameState {
  const players = { ...state.players };
  for (const patch of patches)
    players[patch.playerId] = { ...players[patch.playerId]!, ...patch.changes };
  return { ...state, players };
}
