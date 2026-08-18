import type { RoleId } from "@werewolf/protocol";
import { SeededRng } from "../rng/rng.ts";
import {
  availableSpecialRoles,
  BALANCE_V1,
  getSpecialSlotWeights,
  getStartingWolfCount,
  minimumVanillaVillagers,
  wolfCountForComposition,
} from "./balance-v1.ts";
import { isValidComposition } from "./constraints.ts";

export interface ComposeBalancedGameInput {
  playerCount: number;
  seed: string | number;
  balanceVersion?: number;
}

function chooseSpecialRoles(count: number, playerCount: number, rng: SeededRng): RoleId[] {
  const candidates: RoleId[][] = [];
  const choose = (start: number, selected: RoleId[]): void => {
    const slots = selected.length + (selected.includes("mason") ? 1 : 0);
    if (slots === count) {
      const roles = [...selected];
      if (roles.includes("mason")) roles.push("mason");
      const wolves = wolfCountForComposition(playerCount, roles);
      const composition = [
        ...Array(wolves).fill("werewolf" as RoleId),
        ...roles,
        ...Array(playerCount - wolves - roles.length).fill("villager" as RoleId),
      ];
      if (isValidComposition(composition, playerCount)) {
        candidates.push(roles);
      }
      return;
    }
    if (slots > count) return;
    for (let index = start; index < availableSpecialRoles.length; index += 1) {
      const role = availableSpecialRoles[index]!;
      if (role === "mason" && selected.includes("mason")) continue;
      choose(index + 1, [...selected, role]);
    }
  };
  choose(0, []);
  if (candidates.length === 0) throw new Error("No valid balanced composition");
  return candidates[rng.int(candidates.length)]!;
}

export function composeBalancedGame(input: ComposeBalancedGameInput): RoleId[] {
  const { playerCount, seed, balanceVersion = BALANCE_V1 } = input;
  if (balanceVersion !== BALANCE_V1)
    throw new Error(`Unsupported balance version: ${balanceVersion}`);
  if (!Number.isInteger(playerCount) || playerCount < 5) throw new Error("Minimum 5 players");

  const wolves = getStartingWolfCount(playerCount);
  const vanilla = minimumVanillaVillagers(playerCount);
  const maxSpecialSlots = playerCount - wolves - vanilla;
  const weights = getSpecialSlotWeights(playerCount);
  const counts = Object.entries(weights)
    .map(([count, weight]) => ({ value: Number(count), weight }))
    .filter(({ value, weight }) => value <= maxSpecialSlots && weight > 0);
  const rng = new SeededRng(seed).derive(`balance-v${balanceVersion}:composition`);
  const specialCount = rng.weightedPick(counts);
  const specials = chooseSpecialRoles(specialCount, playerCount, rng.derive("roles"));
  const compositionWolves = wolfCountForComposition(playerCount, specials);
  const roles: RoleId[] = [
    ...Array(compositionWolves).fill("werewolf" as RoleId),
    ...specials,
    ...Array(playerCount - compositionWolves - specials.length).fill("villager" as RoleId),
  ];
  if (!isValidComposition(roles, playerCount)) throw new Error("No valid balanced composition");
  return roles;
}
