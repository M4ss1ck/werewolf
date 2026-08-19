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
import { getActionSpecsFor } from "../roles/action-spec.ts";
import { resolveTargets } from "../roles/targets.ts";
import type { GameState } from "../state.ts";

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
  const player = state.players[playerId];
  if (!player) return [];
  const candidates: LegalCommand[] = [];

  if (phase.type === "voting") {
    for (const targetId of sortedPlayerIds(state))
      candidates.push({ type: "vote.set", phaseId: phase.id, payload: { targetId } });
    candidates.push({ type: "vote.abstain", phaseId: phase.id, payload: {} });
  }

  for (const spec of getActionSpecsFor(state, player)) {
    const type = spec.phase === "night" ? "night.action.set" : "day.action.set";

    if (spec.target === null) {
      candidates.push({ type, phaseId: phase.id, payload: { action: spec.id } } as LegalCommand);
      continue;
    }

    // Sorted so a seeded fallback pick is reproducible regardless of the order
    // the storage layer returned the roster in.
    const eligible = resolveTargets(spec, player, state)
      .filter((target) => target.enabled)
      .map((target) => target.userId)
      .sort();

    if (spec.target.kind === "pair") {
      for (let i = 0; i < eligible.length; i += 1)
        for (let j = i + 1; j < eligible.length; j += 1)
          candidates.push({
            type,
            phaseId: phase.id,
            payload: { action: spec.id, targetIds: [eligible[i]!, eligible[j]!] },
          } as LegalCommand);
      continue;
    }

    // Every remaining action has the same { action, targetId } shape, so the
    // id carries straight through from the spec. A ternary chain here used to
    // end in a default, which silently mapped serial_killer.visit onto a
    // harlot.visit payload that validation then rejected — leaving the Serial
    // Killer with no legal visit at all. Deriving from the spec is what makes
    // that class of bug impossible.
    for (const targetId of eligible)
      candidates.push({
        type,
        phaseId: phase.id,
        payload: { action: spec.id, targetId },
      } as LegalCommand);
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
