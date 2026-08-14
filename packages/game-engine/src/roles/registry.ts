import type { AvailableAction, FactionId, RoleId, UserId } from "@werewolf/protocol";

export interface RoleActionContext<State = unknown> {
  playerId: UserId;
  state: State;
}
export interface DaySelectionContext<State = unknown> {
  playerId: UserId;
  state: State;
}
export type RoleEffect =
  | { type: "survive" }
  | { type: "reveal" }
  | { type: "setState"; value: unknown };

// Hooks use method syntax so a role keeping a precise state type stays
// assignable to the registry's state-erased form.
export interface RoleDefinition<State = unknown> {
  id: RoleId;
  startingFaction: FactionId;
  createState(): State;
  getAvailableActions?(ctx: RoleActionContext<State>): AvailableAction[];
  onDaySelected?(ctx: DaySelectionContext<State>): RoleEffect[];
}

import { cursed } from "./cursed.ts";
import { harlot } from "./harlot.ts";
import { hunter } from "./hunter.ts";
import { mason } from "./mason.ts";
import { princess } from "./princess.ts";
import { seer } from "./seer.ts";
import { villager } from "./villager.ts";
import { werewolf } from "./werewolf.ts";

// Role states differ per role, so the registry holds the state-erased form.
// Each role module keeps its own precise state type.
export const roleRegistry: Readonly<Record<RoleId, RoleDefinition>> = {
  villager,
  werewolf,
  mason,
  seer,
  cursed,
  harlot,
  hunter,
  princess,
};

export function getRoleDefinition(role: RoleId): RoleDefinition {
  return roleRegistry[role];
}
