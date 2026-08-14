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
