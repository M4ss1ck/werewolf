import type { RoleId } from "@werewolf/protocol";
import { ROLE_IDS } from "@werewolf/protocol";
import { roleRegistry } from "./registry.ts";

export interface RoleComposition {
  /** Smallest game this role may appear in. Absent means any size. */
  minimumPlayers?: number;
  /** How many are dealt when it is drawn. Absent means one. */
  copies?: number;
  /** Takes a plain wolf's seat rather than adding a body to the pack. */
  replacesWolf?: boolean;
  /** Cannot be dealt unless this role is dealt too. */
  requires?: RoleId;
  /** A Drunk may be told they are this role. Restricted to roles whose
   * output is PRIVATE: a publicly observable power would out the Drunk the
   * first time they used it. */
  drunkMayBelieve?: boolean;
}

/** Roles the composer never deals: `villager` and `werewolf` fill the seats
 * left over, and `cultist` exists only as the result of a conversion. */
export const NEVER_DEALT: ReadonlySet<RoleId> = new Set<RoleId>([
  "villager",
  "werewolf",
  "cultist",
]);

export function getComposition(role: RoleId): RoleComposition | undefined {
  return roleRegistry[role].composition;
}

function dealtRoles(): RoleId[] {
  return ROLE_IDS.filter((role) => getComposition(role) !== undefined);
}

export const availableSpecialRoles: readonly RoleId[] = dealtRoles();

export const roleAvailabilityMinimums: Partial<Record<RoleId, number>> = Object.fromEntries(
  dealtRoles()
    .map((role) => [role, getComposition(role)!.minimumPlayers] as const)
    .filter(([, minimum]) => minimum !== undefined),
);

export const WOLF_REPLACING_ROLES: readonly RoleId[] = dealtRoles().filter(
  (role) => getComposition(role)!.replacesWolf === true,
);

export const requiredCombinations: readonly (readonly [RoleId, RoleId])[] = dealtRoles()
  .map((role) => [role, getComposition(role)!.requires] as const)
  .filter((entry): entry is readonly [RoleId, RoleId] => entry[1] !== undefined);

export const DRUNK_FAKE_ROLES: readonly RoleId[] = dealtRoles().filter(
  (role) => getComposition(role)!.drunkMayBelieve === true,
);

export function maximumCopies(role: RoleId): number {
  return getComposition(role)?.copies ?? 1;
}
