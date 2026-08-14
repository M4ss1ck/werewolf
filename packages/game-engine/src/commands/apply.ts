import type { GameplayCommand, UserId } from "@werewolf/protocol";
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
            ...(command.payload.channel === "wolves" ? { scopeId: "wolves" } : {}),
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
    const stored =
      player.phaseState.phaseId === command.phaseId ? (player.phaseState.actions ?? {}) : {};
    const actions = { ...stored };
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
            changes: { phaseState: { phaseId: command.phaseId, actions } },
          },
        ],
        events: [],
        ephemeral: [],
      },
    };
  }
  if (command.type !== "vote.set" && command.type !== "vote.abstain")
    return { ok: false, error: { code: "ACTION_NOT_AVAILABLE" } };
  return {
    ok: true,
    transition: {
      playerPatches: [
        {
          playerId: actorId,
          changes: {
            phaseState: {
              phaseId: command.phaseId,
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
