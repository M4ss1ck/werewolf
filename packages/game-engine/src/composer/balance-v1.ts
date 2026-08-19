import type { RoleId } from "@werewolf/protocol";

export const BALANCE_V1 = 1 as const;

/** Per-night chance the pack's victim is turned instead of killed. */
export const ALPHA_CONVERSION_CHANCE = 0.1;

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

export const roleAvailabilityMinimums: Partial<Record<RoleId, number>> = {
  cursed: 6,
  hunter: 7,
  drunk: 7,
  mason: 8,
  alpha_wolf: 10,
  mayor: 8,
  cupid: 8,
};

/** Roles a Drunk may believe they are. Restricted to roles whose output is
 * PRIVATE information only: a publicly observable power (revealing, linking)
 * would out the Drunk the first time they used it. More are added as those
 * roles land. */
export const DRUNK_FAKE_ROLES: readonly RoleId[] = ["seer", "cupid"];

export const forbiddenCombinations: readonly (readonly RoleId[])[] = [["seer", "princess"]];

export function getStartingWolfCount(players: number): number {
  if (players < 5) throw new Error("Minimum 5 players");
  return Math.max(1, Math.floor((players + 1) / 4));
}

export function wolfCountForComposition(playerCount: number, specials: readonly RoleId[]): number {
  if (playerCount === 5 && specials.includes("serial_killer")) return 0;
  if (specials.includes("alpha_wolf")) return getStartingWolfCount(playerCount) - 1;
  return getStartingWolfCount(playerCount);
}

export function minimumVanillaVillagers(playerCount: number): number {
  return Math.max(2, Math.ceil(playerCount * 0.25));
}

export function getSpecialSlotWeights(playerCount: number): Readonly<Record<number, number>> {
  return specialSlotWeights.find((entry) => playerCount <= entry.maximumPlayers)!.weights;
}

export const availableSpecialRoles: readonly RoleId[] = [
  "seer",
  "harlot",
  "princess",
  "hunter",
  "cursed",
  "mason",
  "veteran",
  "serial_killer",
  "alpha_wolf",
  "drunk",
  "mayor",
  "cupid",
];
