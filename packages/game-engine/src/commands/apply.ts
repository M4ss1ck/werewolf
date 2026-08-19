import type { GameplayCommand, UserId } from "@werewolf/protocol";
import { PHASE_MINIMUM_FRACTION } from "../composer/balance-v1.ts";
import { phaseDurationMs } from "../resolution/phase.ts";
import type { DomainResult, GameState } from "../state.ts";
import { type CommandContext, validateCommand } from "./validate.ts";

export function applyCommand(
  state: GameState,
  actorId: UserId,
  command: GameplayCommand,
  context: CommandContext,
): DomainResult {
  const error = validateCommand(state, actorId, command, context);
  if (error) return { ok: false, error };
  if (command.type === "chat.send") {
    return {
      ok: true,
      transition: {
        playerPatches: [],
        events: [
          {
            kind: "chat.message",
            scope: command.payload.channel === "public" ? "public" : "faction",
            ...(command.payload.channel !== "public" ? { scopeId: command.payload.channel } : {}),
            actorUserId: actorId,
            payload: command.payload,
          },
        ],
        ephemeral: [],
      },
    };
  }
  if (command.type === "night.action.set" || command.type === "night.action.clear") {
    const player = state.players[actorId]!;
    // Merge into the existing phase state so a vote or ready stored for this
    // phase survives; start from a fresh object when the phase changed.
    const base =
      player.phaseState.phaseId === command.phaseId
        ? player.phaseState
        : { phaseId: command.phaseId };
    const actions = { ...(base.actions ?? {}) };
    if (command.type === "night.action.clear") {
      delete actions[command.payload.action];
    } else {
      const action = command.payload.action;
      // harlot.visit and harlot.stay are mutually exclusive, so setting one
      // drops the other: the Harlot never holds both at once.
      if (action === "harlot.visit") delete actions["harlot.stay"];
      if (action === "harlot.stay") delete actions["harlot.visit"];
      actions[action] = "targetId" in command.payload ? { targetId: command.payload.targetId } : {};
    }
    return {
      ok: true,
      transition: {
        playerPatches: [
          {
            playerId: actorId,
            changes: { phaseState: { ...base, actions } },
          },
        ],
        events: [],
        ephemeral: [],
      },
    };
  }
  if (command.type === "phase.ready") {
    const player = state.players[actorId]!;
    const base =
      player.phaseState.phaseId === command.phaseId
        ? player.phaseState
        : { phaseId: command.phaseId };
    const phaseState = { ...base, ready: command.payload.ready };
    const phase = state.phase!;
    const duration = phaseDurationMs(phase.type, state.settings);
    const fullEndsAt = phase.startedAt + duration;
    const floorEndsAt = phase.startedAt + Math.round(duration * PHASE_MINIMUM_FRACTION);
    // Project the state with this command applied: the actor's new ready value
    // must count, or the last player to ready could never end the phase.
    const everyoneReady = Object.values(state.players)
      .filter((player) => player.status === "alive")
      .every((player) => {
        const projected = player.id === actorId ? phaseState : player.phaseState;
        return projected.phaseId === phase.id && projected.ready === true;
      });
    const endsAt = everyoneReady
      ? Math.min(fullEndsAt, Math.max(context.now, floorEndsAt))
      : fullEndsAt;
    return {
      ok: true,
      transition: {
        gamePatch: { phase: { ...phase, endsAt } },
        playerPatches: [{ playerId: actorId, changes: { phaseState } }],
        events: [],
        ephemeral: [],
      },
    };
  }
  if (command.type !== "vote.set" && command.type !== "vote.abstain")
    return { ok: false, error: { code: "ACTION_NOT_AVAILABLE" } };
  const player = state.players[actorId]!;
  const base =
    player.phaseState.phaseId === command.phaseId
      ? player.phaseState
      : { phaseId: command.phaseId };
  return {
    ok: true,
    transition: {
      playerPatches: [
        {
          playerId: actorId,
          changes: {
            phaseState: {
              ...base,
              vote:
                command.type === "vote.set"
                  ? { type: "player", targetId: command.payload.targetId }
                  : { type: "abstain" },
            },
          },
        },
      ],
      events: [],
      ephemeral: [],
    },
  };
}

export function resolveCommand(
  state: GameState,
  actorId: UserId,
  command: GameplayCommand,
  context: CommandContext,
): DomainResult {
  return applyCommand(state, actorId, command, context);
}
