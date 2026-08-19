import type { GamePhase, UserId } from "@werewolf/protocol";
import { DRUNK_FAKE_ROLES } from "../composer/balance-v1.ts";
import { composeBalancedGame } from "../composer/compose.ts";
import { SeededRng } from "../rng/rng.ts";
import { getPerceivedRole } from "../roles/perceived.ts";
import { getRoleDefinition, isPackMember } from "../roles/registry.ts";
import type { DomainResult, DomainTransition, GameSettings, GameState } from "../state.ts";
import { resolveNight } from "./night/index.ts";
import { resolveDayVote } from "./vote.ts";

export interface PhaseContext {
  now: number;
  seed: string | number;
  rng?: SeededRng;
}

export function phaseDurationMs(type: GamePhase, settings: GameSettings): number {
  if (type === "discussion") return settings.discussionDurationMs;
  if (type === "voting") return settings.votingDurationMs;
  return settings.nightDurationMs;
}

const MIN_PLAYERS = 5;

export function startGame(state: GameState, context: PhaseContext): DomainResult {
  if (state.status !== "lobby" && state.status !== "scheduled")
    return { ok: false, error: { code: "GAME_ALREADY_STARTED" } };
  const players = Object.values(state.players).filter((player) => player.status === "lobby");
  if (players.length < MIN_PLAYERS)
    return { ok: false, error: { code: "MIN_PLAYERS_NOT_REACHED" } };

  const roles = composeBalancedGame({
    playerCount: players.length,
    seed: context.seed,
    balanceVersion: state.balanceVersion,
    ...(state.settings.preset ? { preset: state.settings.preset } : {}),
  });
  const shuffledRoles = shuffle(roles, new SeededRng(context.seed).derive("assignment"));
  const drunkRng = new SeededRng(context.seed).derive("assignment:drunk:perceived");
  const playerPatches = players.map((player, index) => {
    const role = shuffledRoles[index]!;
    const definition = getRoleDefinition(role);
    const roleState =
      role === "drunk"
        ? { perceivedRole: DRUNK_FAKE_ROLES[drunkRng.int(DRUNK_FAKE_ROLES.length)]! }
        : definition.createState();
    return {
      playerId: player.id,
      changes: {
        status: "alive" as const,
        originalRole: role,
        role,
        faction: definition.startingFaction,
        roleState,
      },
    };
  });
  const phase = makePhase(1, "discussion", context.now, state.settings.discussionDurationMs);
  const events: DomainTransition["events"] = [
    { kind: "game.started", scope: "public", payload: {} },
    { kind: "phase.started", scope: "public", payload: phasePayload(phase) },
  ];
  for (const patch of playerPatches) {
    const perceivedRole = getPerceivedRole({
      ...state.players[patch.playerId]!,
      ...patch.changes,
    });
    events.push({
      kind: "role.assigned",
      scope: "player",
      scopeId: patch.playerId,
      payload: { role: perceivedRole!, faction: patch.changes.faction },
    });
  }
  addKnowledgeEvents(events, playerPatches);
  return {
    ok: true,
    transition: {
      gamePatch: { status: "running", day: 1, phase, scheduledAt: null },
      playerPatches,
      events,
      ephemeral: [],
    },
  };
}

export function resolveExpiredPhase(state: GameState, context: PhaseContext): DomainResult {
  if (state.status === "finished") return { ok: false, error: { code: "GAME_NOT_STARTED" } };
  if (!state.phase || state.status !== "running")
    return { ok: false, error: { code: "GAME_NOT_STARTED" } };
  if (state.phase.type === "discussion") return openVoting(state, context.now);
  if (state.phase.type === "voting") {
    const result = resolveDayVote(state);
    if (!result.ok || result.transition.gamePatch?.status === "finished") return result;
    const phase = makePhase(
      state.phase.id + 1,
      "night",
      context.now,
      state.settings.nightDurationMs,
    );
    return appendPhase(result, phase, { phase });
  }
  return resolveNight(state, { now: context.now, rng: context.rng ?? new SeededRng(context.seed) });
}

export function resolveScheduledGame(state: GameState, context: PhaseContext): DomainResult {
  if (state.status !== "scheduled") return { ok: false, error: { code: "GAME_NOT_STARTED" } };
  const joined = Object.values(state.players).filter((player) => player.status === "lobby").length;
  if (joined >= MIN_PLAYERS) return startGame(state, context);
  return {
    ok: true,
    transition: {
      gamePatch: { status: "lobby", scheduledAt: null },
      playerPatches: [],
      events: [
        {
          kind: "game.start_deferred",
          scope: "public",
          payload: { joinedPlayers: joined, minimumPlayers: MIN_PLAYERS },
        },
      ],
      ephemeral: [],
    },
  };
}

function openVoting(state: GameState, now: number): DomainResult {
  const phase = makePhase(state.phase!.id + 1, "voting", now, state.settings.votingDurationMs);
  return appendPhase(
    { ok: true, transition: { playerPatches: [], events: [], ephemeral: [] } },
    phase,
    {
      phase,
    },
  );
}

function appendPhase(
  result: DomainResult,
  phase: NonNullable<GameState["phase"]>,
  transition: { phase: NonNullable<GameState["phase"]> },
): DomainResult {
  if (!result.ok) return result;
  result.transition.gamePatch = { ...result.transition.gamePatch, phase: transition.phase };
  result.transition.events.push({
    kind: "phase.started",
    scope: "public",
    payload: phasePayload(phase),
  });
  return result;
}

function makePhase(id: number, type: GamePhase, now: number, duration: number) {
  return {
    id: id as GameState["phase"] extends infer P ? (P extends { id: infer I } ? I : never) : never,
    type,
    startedAt: now,
    endsAt: now + duration,
  };
}

function phasePayload(phase: NonNullable<GameState["phase"]>) {
  return { phaseId: phase.id, type: phase.type, startedAt: phase.startedAt, endsAt: phase.endsAt };
}

function shuffle(roles: ReturnType<typeof composeBalancedGame>, rng: SeededRng): typeof roles {
  const result = [...roles];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = rng.int(index + 1);
    [result[index], result[other]] = [result[other]!, result[index]!];
  }
  return result;
}

function addKnowledgeEvents(
  events: DomainTransition["events"],
  patches: DomainTransition["playerPatches"],
): void {
  // The pack is WOLF_CHAT_ROLES membership, not the wolves faction: a Sorcerer
  // must learn nothing about the pack and the pack nothing about them.
  const wolves = patches.filter((patch) => isPackMember({ role: patch.changes.role ?? null }));
  const masons = patches.filter((patch) => patch.changes.role === "mason");
  addPrivateGroupEvents(events, wolves, "wolves.member_joined");
  addPrivateGroupEvents(events, masons, "masons.member_joined");
}

function addPrivateGroupEvents(
  events: DomainTransition["events"],
  group: { playerId: UserId }[],
  kind: "wolves.member_joined" | "masons.member_joined",
): void {
  for (const recipient of group)
    for (const member of group)
      if (member.playerId !== recipient.playerId)
        events.push({
          kind,
          scope: "player",
          scopeId: recipient.playerId,
          payload: { playerId: member.playerId },
        });
}
