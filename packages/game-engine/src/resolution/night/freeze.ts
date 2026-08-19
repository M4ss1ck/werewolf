import type { ActionId, UserId } from "@werewolf/protocol";
import { type ActionSpec, getActionSpecsFor } from "../../roles/action-spec.ts";
import { getPerceivedRole } from "../../roles/perceived.ts";
import type { GameState, PlayerState } from "../../state.ts";

export interface Intent {
  actionId: ActionId;
  /** Who STORED the action. Not necessarily who really holds the role: a
   * Drunk who believes they are the Detective stores detective.investigate
   * and genuinely walks to that house. */
  actorId: UserId;
  targetId?: UserId;
  targetIds?: [UserId, UserId];
  /** True when the actor's real role differs from the one they acted as. */
  mimicked: boolean;
}

export type FrozenIntents = ReadonlyMap<ActionId, readonly Intent[]>;

/** Freeze every living player's stored night action into a generic intent map,
 * keyed by action id. Locations and effects read from here; the `mimicked`
 * flag is what lets locations treat a Drunk's fake action as real travel while
 * effects ignore it. */
export function freezeNightIntents(state: GameState): FrozenIntents {
  const phaseId = state.phase!.id;
  const frozen = new Map<ActionId, Intent[]>();
  for (const player of Object.values(state.players)) {
    if (player.status !== "alive") continue;
    for (const spec of getActionSpecsFor(state, player)) {
      if (spec.phase !== "night") continue;
      const stored = currentAction(player, phaseId, spec.id);
      if (!stored) continue;
      const intent = buildIntent(state, player, spec, stored);
      if (!intent) continue;
      frozen.set(spec.id, [...(frozen.get(spec.id) ?? []), intent]);
    }
  }
  return frozen;
}

export function intentsFor(frozen: FrozenIntents, id: ActionId): readonly Intent[] {
  return frozen.get(id) ?? [];
}

/** The single intent for an action only one player can hold. Throws never;
 * returns undefined when nobody acted. Use this for LOCATIONS, where a
 * mimicked action still moves a real body. */
export function soleIntent(frozen: FrozenIntents, id: ActionId): Intent | undefined {
  return intentsFor(frozen, id)[0];
}

/** The intent of someone who really holds the role, ignoring a Drunk acting
 * out a role they only believe they have. Use this for EFFECTS: a fake Priest
 * protects nobody and a fake Harlot is not really out visiting.
 *
 * Several roles cannot be mimicked today because they are absent from
 * DRUNK_FAKE_ROLES, so this reads the same as `soleIntent` for them. Stating
 * the rule anyway is the point: adding `drunkMayBelieve` to one of those roles
 * must not quietly hand its fake a real power. */
export function realIntent(frozen: FrozenIntents, id: ActionId): Intent | undefined {
  return intentsFor(frozen, id).find((intent) => !intent.mimicked);
}

/** The intent of someone acting out a role they do not hold. */
export function mimickedIntent(frozen: FrozenIntents, id: ActionId): Intent | undefined {
  return intentsFor(frozen, id).find((intent) => intent.mimicked);
}

/** Build the intent for one stored action, or undefined when a required target
 * is missing or not alive — the check every hand-written block used to do. */
function buildIntent(
  state: GameState,
  player: PlayerState,
  spec: ActionSpec,
  stored: { targetId?: UserId; targetIds?: UserId[] },
): Intent | undefined {
  const mimicked = getPerceivedRole(player) !== player.role;
  if (spec.target === null) {
    return { actionId: spec.id, actorId: player.id, mimicked };
  }
  if (spec.target.kind === "pair") {
    const targetIds = stored.targetIds;
    if (!targetIds || targetIds.length !== 2) return undefined;
    if (!isLivingTarget(state, targetIds[0]!) || !isLivingTarget(state, targetIds[1]!))
      return undefined;
    return {
      actionId: spec.id,
      actorId: player.id,
      targetIds: [targetIds[0]!, targetIds[1]!],
      mimicked,
    };
  }
  const targetId = stored.targetId;
  if (!targetId || !isLivingTarget(state, targetId)) return undefined;
  return { actionId: spec.id, actorId: player.id, targetId, mimicked };
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
