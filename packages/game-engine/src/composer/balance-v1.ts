import type { PresetId, RoleId } from "@werewolf/protocol";
import { availableSpecialRoles, WOLF_REPLACING_ROLES } from "../roles/composition.ts";

export {
  availableSpecialRoles,
  DRUNK_FAKE_ROLES,
  requiredCombinations,
  roleAvailabilityMinimums,
  WOLF_REPLACING_ROLES,
} from "../roles/composition.ts";

export const BALANCE_V1 = 1 as const;

/** Per-night chance the pack's victim is turned instead of killed. */
export const ALPHA_CONVERSION_CHANCE = 0.1;

/** Chance the Detective's investigation identifies the target's role. A miss
 * is reported as inconclusive, never as a wrong role: a second lying
 * information role would steal the Drunk's whole identity. */
export const DETECTIVE_SUCCESS_CHANCE = 0.5;

/** Consecutive night resolutions with no elimination that end the game in a draw. */
export const STALEMATE_NIGHTS = 5;

/** Fraction of a phase's full duration that must elapse before every-player
 * readiness may end it early. Without a floor the wolves' deliberation window
 * collapses and "who readied last" becomes a timing tell. */
export const PHASE_MINIMUM_FRACTION = 0.4;

export const specialSlotWeights = [
  { maximumPlayers: 5, weights: { 0: 3, 1: 5, 2: 2 } },
  { maximumPlayers: 6, weights: { 0: 2, 1: 5, 2: 3 } },
  { maximumPlayers: 7, weights: { 0: 1, 1: 4, 2: 5 } },
  { maximumPlayers: 10, weights: { 0: 1, 1: 2, 2: 4, 3: 2, 4: 1 } },
  { maximumPlayers: 14, weights: { 1: 1, 2: 2, 3: 4, 4: 2, 5: 1 } },
  { maximumPlayers: Number.POSITIVE_INFINITY, weights: { 2: 1, 3: 2, 4: 3, 5: 3, 6: 2, 7: 1 } },
] as const;

export const forbiddenCombinations: readonly (readonly RoleId[])[] = [["seer", "princess"]];

export function getStartingWolfCount(players: number): number {
  if (players < 5) throw new Error("Minimum 5 players");
  return Math.max(1, Math.floor((players + 1) / 4));
}

export function wolfCountForComposition(playerCount: number, specials: readonly RoleId[]): number {
  if (playerCount === 5 && specials.includes("serial_killer")) return 0;
  const replaced = WOLF_REPLACING_ROLES.filter((role) => specials.includes(role)).length;
  return Math.max(0, getStartingWolfCount(playerCount) - replaced);
}

export function minimumVanillaVillagers(playerCount: number): number {
  return Math.max(2, Math.ceil(playerCount * 0.25));
}

export function getSpecialSlotWeights(playerCount: number): Readonly<Record<number, number>> {
  return specialSlotWeights.find((entry) => playerCount <= entry.maximumPlayers)!.weights;
}

export interface Preset {
  /** The pool this preset draws its special roles from. */
  readonly specialRoles: readonly RoleId[];
  /** Roles that MUST appear. A themed preset whose theme may not show up is
   * not a theme. */
  readonly guaranteed: readonly RoleId[];
}

export const presets: Readonly<Record<PresetId, Preset>> = {
  // The roster as it was before the roster expansion: a new player's first
  // game is the village they expect rather than a random draw from twenty.
  classic: {
    specialRoles: [
      "seer",
      "harlot",
      "princess",
      "hunter",
      "cursed",
      "mason",
      "veteran",
      "serial_killer",
      "alpha_wolf",
    ],
    guaranteed: [],
  },
  // Every role the composer may ever deal.
  chaos: {
    specialRoles: availableSpecialRoles,
    guaranteed: [],
  },
  // The cult leader plus a village able to fight back; the werewolf side
  // stays as the composer decides.
  cult: {
    specialRoles: [
      "cult_leader",
      "seer",
      "priest",
      "guardian",
      "detective",
      "hunter",
      "mason",
      "princess",
      "drunk",
      "mayor",
      "cupid",
    ],
    guaranteed: ["cult_leader"],
  },
};
