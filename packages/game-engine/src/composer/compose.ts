import type { PresetId, RoleId } from "@werewolf/protocol";
import { SeededRng } from "../rng/rng.ts";
import {
  BALANCE_V1,
  getSpecialSlotWeights,
  getStartingWolfCount,
  minimumVanillaVillagers,
  type Preset,
  presets,
  wolfCountForComposition,
} from "./balance-v1.ts";
import { isValidComposition } from "./constraints.ts";

export interface ComposeBalancedGameInput {
  playerCount: number;
  seed: string | number;
  balanceVersion?: number;
  /** Which preset to draw special roles from. Omitted means "classic". */
  preset?: PresetId;
}

function chooseSpecialRoles(
  count: number,
  playerCount: number,
  rng: SeededRng,
  preset: Preset,
): RoleId[] {
  const candidates: RoleId[][] = [];
  // The guaranteed roles are already selected when the recursion starts, so
  // every candidate contains them without a filter pass at the end. They are
  // removed from the pool so they cannot be picked twice.
  const pool = preset.specialRoles.filter((role) => !preset.guaranteed.includes(role));
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
    for (let index = start; index < pool.length; index += 1) {
      const role = pool[index]!;
      if (role === "mason" && selected.includes("mason")) continue;
      choose(index + 1, [...selected, role]);
    }
  };
  choose(0, [...preset.guaranteed]);
  if (candidates.length === 0) throw new Error("No valid balanced composition");
  return candidates[rng.int(candidates.length)]!;
}

export function composeBalancedGame(input: ComposeBalancedGameInput): RoleId[] {
  const { playerCount, seed, balanceVersion = BALANCE_V1, preset: presetId = "classic" } = input;
  if (balanceVersion !== BALANCE_V1)
    throw new Error(`Unsupported balance version: ${balanceVersion}`);
  if (!Number.isInteger(playerCount) || playerCount < 5) throw new Error("Minimum 5 players");

  const preset = presets[presetId];
  const wolves = getStartingWolfCount(playerCount);
  const vanilla = minimumVanillaVillagers(playerCount);
  const maxSpecialSlots = playerCount - wolves - vanilla;
  const weights = getSpecialSlotWeights(playerCount);
  const counts = Object.entries(weights)
    .map(([count, weight]) => ({ value: Number(count), weight }))
    .filter(({ value, weight }) => value <= maxSpecialSlots && weight > 0);
  const rng = new SeededRng(seed).derive(`balance-v${balanceVersion}:composition`);
  const drawnCount = rng.weightedPick(counts);
  // A preset must never fail to include its own theme: if the draw is smaller
  // than the guaranteed set, deal the guaranteed set instead. If that exceeds
  // the available slots, no candidate passes and the composition is invalid.
  const specialCount = Math.max(drawnCount, preset.guaranteed.length);
  const specials = chooseSpecialRoles(specialCount, playerCount, rng.derive("roles"), preset);
  const compositionWolves = wolfCountForComposition(playerCount, specials);
  const roles: RoleId[] = [
    ...Array(compositionWolves).fill("werewolf" as RoleId),
    ...specials,
    ...Array(playerCount - compositionWolves - specials.length).fill("villager" as RoleId),
  ];
  if (!isValidComposition(roles, playerCount)) throw new Error("No valid balanced composition");
  return roles;
}
