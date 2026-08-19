import type { ActionId, EventKind } from "@werewolf/protocol";
import type { GameState, PlayerState } from "../state.ts";
import { getPerceivedRole } from "./perceived.ts";
import { isPackMember, roleRegistry } from "./registry.ts";

export type TargetSpec =
  | null
  | { kind: "one"; pool: "all" | "others"; excludeSelf: boolean }
  | { kind: "pair"; pool: "all" | "others"; excludeSelf: boolean };

export interface ActionSpec {
  id: ActionId;
  phase: "night" | "day";
  target: TargetSpec;
  available?: (ctx: { player: PlayerState; state: GameState }) => boolean;
  eligible?: (ctx: { player: PlayerState; target: PlayerState; state: GameState }) => boolean;
  travelsToTarget?: boolean;
  emitsResult?: EventKind;
}

/** The spec for an action id, or undefined if no role declares it. */
export function getActionSpec(id: ActionId): ActionSpec | undefined {
  for (const role of Object.values(roleRegistry)) {
    const found = role.actions?.find((action) => action.id === id);
    if (found) return found;
  }
  return undefined;
}

/** Every action the player may take right now, by perceived role plus pack
 * membership, filtered by phase and by each spec's `available`. */
export function getActionSpecsFor(state: GameState, player: PlayerState): ActionSpec[] {
  if (player.status !== "alive" || !state.phase) return [];
  const phase = state.phase.type === "night" ? "night" : "day";
  const perceived = getPerceivedRole(player);
  const specs: ActionSpec[] = [];
  // The pack's attack is owned by MEMBERSHIP, not by a role id: a converted
  // werewolf and a cub both get it, and the sorcerer never does.
  if (isPackMember(player)) specs.push(...(roleRegistry.werewolf.actions ?? []));
  if (perceived !== null) specs.push(...(roleRegistry[perceived].actions ?? []));
  // A plain werewolf reaches wolf.attack by both routes; dedupe by id so it
  // is offered once.
  const seen = new Set<ActionId>();
  return specs.filter((spec) => {
    if (seen.has(spec.id)) return false;
    seen.add(spec.id);
    return spec.phase === phase && (spec.available?.({ player, state }) ?? true);
  });
}
