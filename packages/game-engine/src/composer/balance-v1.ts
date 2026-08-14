import type { RoleId } from "@werewolf/protocol";

export const BALANCE_V1 = 1 as const;

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
  mason: 8,
};

export const forbiddenCombinations: readonly (readonly RoleId[])[] = [
  ["seer", "princess"],
];

export function getStartingWolfCount(players: number): number {
  if (players < 5) throw new Error("Minimum 5 players");
  return Math.max(1, Math.floor((players + 1) / 4));
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
];
