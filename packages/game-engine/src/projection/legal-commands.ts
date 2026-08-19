// The set of commands a player may legally submit right now, enumerated.
//
// This is a projection, not a second rule book: every candidate is generated
// from the same available-actions model the client renders, then run through
// `validateCommand` — the very function the coordinator applies when the
// command actually arrives. A rule change therefore cannot make this list and
// the authoritative check disagree.
//
// Free-text chat is not enumerable, so `getSpeakableChannels` answers the
// adjacent question: which channels this player may send on at this moment.

import type { ChatChannel, GameplayCommand, UserId } from "@werewolf/protocol";
import { CHAT_CHANNELS } from "@werewolf/protocol";
import { validateCommand } from "../commands/validate.ts";
import type { GameState } from "../state.ts";
import { getAvailableActions } from "./available-actions.ts";

/** A gameplay command minus the `commandId` the submitter mints per attempt.
 * Distributes over the union so each member keeps its own payload shape. */
type WithoutCommandId<T> = T extends unknown ? Omit<T, "commandId"> : never;
export type LegalCommand = WithoutCommandId<GameplayCommand>;

function isLegal(
  state: GameState,
  playerId: UserId,
  candidate: LegalCommand,
  now: number,
): boolean {
  const probe = { ...candidate, commandId: "legality-probe" } as GameplayCommand;
  return validateCommand(state, playerId, probe, { now }) === null;
}

/** Stable ordering, so a seeded fallback pick is reproducible regardless of
 * the order the storage layer happened to return the roster in. */
function sortedPlayerIds(state: GameState): UserId[] {
  return Object.values(state.players)
    .map((player) => player.id)
    .sort();
}

export function getLegalCommands(state: GameState, playerId: UserId, now: number): LegalCommand[] {
  const phase = state.phase;
  if (!phase) return [];
  const candidates: LegalCommand[] = [];

  if (phase.type === "voting") {
    for (const targetId of sortedPlayerIds(state))
      candidates.push({ type: "vote.set", phaseId: phase.id, payload: { targetId } });
    candidates.push({ type: "vote.abstain", phaseId: phase.id, payload: {} });
  }

  if (phase.type === "night") {
    for (const action of getAvailableActions(state, playerId)) {
      // The one action that takes no target; handling it first leaves the rest
      // narrowed to the three that do.
      if (action.id === "harlot.stay") {
        candidates.push({
          type: "night.action.set",
          phaseId: phase.id,
          payload: { action: "harlot.stay" },
        });
        continue;
      }
      if (action.type === "targets") {
        // cupid.link: every unordered distinct pair of living players, in a
        // stable sorted order so a seeded fallback pick is reproducible.
        const living = sortedPlayerIds(state).filter((id) => state.players[id]?.status === "alive");
        for (let i = 0; i < living.length; i += 1) {
          for (let j = i + 1; j < living.length; j += 1) {
            candidates.push({
              type: "night.action.set",
              phaseId: phase.id,
              payload: { action: "cupid.link", targetIds: [living[i]!, living[j]!] },
            });
          }
        }
        continue;
      }
      if (action.type !== "target") continue;
      const targets = [...action.targets].sort((a, b) => (a.userId < b.userId ? -1 : 1));
      for (const target of targets) {
        const payload =
          action.id === "wolf.attack"
            ? ({ action: "wolf.attack", targetId: target.userId } as const)
            : action.id === "seer.inspect"
              ? ({ action: "seer.inspect", targetId: target.userId } as const)
              : ({ action: "harlot.visit", targetId: target.userId } as const);
        candidates.push({ type: "night.action.set", phaseId: phase.id, payload });
      }
    }
  }

  if (phase.type === "discussion" || phase.type === "voting") {
    for (const action of getAvailableActions(state, playerId)) {
      // The pardon takes no target; handling it first leaves the rest narrowed
      // to the ones that do.
      if (action.id === "mayor.pardon") {
        candidates.push({
          type: "day.action.set",
          phaseId: phase.id,
          payload: { action: "mayor.pardon" },
        });
        continue;
      }
      if (action.id !== "mayor.reveal" || action.type !== "target") continue;
      const targets = [...action.targets].sort((a, b) => (a.userId < b.userId ? -1 : 1));
      for (const target of targets)
        candidates.push({
          type: "day.action.set",
          phaseId: phase.id,
          payload: { action: "mayor.reveal", targetId: target.userId },
        });
    }
  }

  return candidates.filter((candidate) => isLegal(state, playerId, candidate, now));
}

/** Channels this player may send a message on right now. Empty means silence
 * is the only option — a dead player, or anyone during the night. */
export function getSpeakableChannels(
  state: GameState,
  playerId: UserId,
  now: number,
): ChatChannel[] {
  const phase = state.phase;
  if (!phase) return [];
  return CHAT_CHANNELS.filter((channel) =>
    isLegal(
      state,
      playerId,
      { type: "chat.send", phaseId: phase.id, payload: { channel, text: "probe" } },
      now,
    ),
  );
}
