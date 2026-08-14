import type { RoleId } from "@werewolf/protocol";
import { forbiddenCombinations, minimumVanillaVillagers, roleAvailabilityMinimums } from "./balance-v1.ts";

export function hasRole(roles: readonly RoleId[], role: RoleId): boolean {
  return roles.includes(role);
}

export function hasValidSpecialCardinality(roles: readonly RoleId[]): boolean {
  const masons = roles.filter((role) => role === "mason").length;
  if (masons !== 0 && masons !== 2) return false;
  return (["seer", "harlot", "princess", "hunter", "cursed"] as const).every(
    (role) => roles.filter((candidate) => candidate === role).length <= 1,
  );
}

export function hasAvailableRoles(roles: readonly RoleId[], playerCount: number): boolean {
  return roles.every((role) => {
    const minimum = roleAvailabilityMinimums[role];
    return minimum === undefined || playerCount >= minimum;
  });
}

export function hasAllowedCombinations(roles: readonly RoleId[], playerCount: number): boolean {
  if (playerCount === 5 || playerCount === 6) {
    for (const forbidden of forbiddenCombinations) {
      if (forbidden.every((role) => hasRole(roles, role))) return false;
    }
  }
  if (playerCount === 5 || playerCount === 7) {
    return !hasRole(roles, "cursed");
  }
  return true;
}

export function hasMinimumVanillaVillagers(roles: readonly RoleId[], playerCount: number): boolean {
  return roles.filter((role) => role === "villager").length >= minimumVanillaVillagers(playerCount);
}

export function isValidComposition(roles: readonly RoleId[], playerCount: number): boolean {
  return roles.length === playerCount && hasValidSpecialCardinality(roles) && hasAvailableRoles(roles, playerCount)
    && hasAllowedCombinations(roles, playerCount) && hasMinimumVanillaVillagers(roles, playerCount);
}
