import type { RoleId } from "@werewolf/protocol";
import { ROLE_IDS } from "@werewolf/protocol";
import { maximumCopies, NEVER_DEALT } from "../roles/composition.ts";
import {
  forbiddenCombinations,
  minimumVanillaVillagers,
  requiredCombinations,
  roleAvailabilityMinimums,
} from "./balance-v1.ts";

export function hasRole(roles: readonly RoleId[], role: RoleId): boolean {
  return roles.includes(role);
}

export function hasValidSpecialCardinality(roles: readonly RoleId[]): boolean {
  return ROLE_IDS.every((role) => {
    const dealt = roles.filter((candidate) => candidate === role).length;
    if (NEVER_DEALT.has(role)) return true;
    const allowed = maximumCopies(role);
    // A role dealt in pairs is dealt as a full pair or not at all.
    return dealt === 0 || dealt === allowed;
  });
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

/** A role that requires a prerequisite is only valid when that prerequisite is
 * also dealt. The Lone Wolf is meaningless without an Alpha to hunt. */
export function hasRequiredCombinations(roles: readonly RoleId[]): boolean {
  return requiredCombinations.every(
    ([role, prerequisite]) => !hasRole(roles, role) || hasRole(roles, prerequisite),
  );
}

export function isValidComposition(roles: readonly RoleId[], playerCount: number): boolean {
  return (
    roles.length === playerCount &&
    hasValidSpecialCardinality(roles) &&
    hasAvailableRoles(roles, playerCount) &&
    hasAllowedCombinations(roles, playerCount) &&
    hasRequiredCombinations(roles) &&
    hasMinimumVanillaVillagers(roles, playerCount)
  );
}
