import type { ChatChannel, FactionId, RoleId, UserId } from "@werewolf/protocol";
import { ROLE_IDS } from "@werewolf/protocol";
import type { ActionSpec } from "./action-spec.ts";
import type { RoleComposition } from "./composition.ts";

/** The chat channels a role can be a member of. Derived from the protocol's
 * vocabulary so renaming a channel there breaks here rather than silently
 * leaving a role in a channel that no longer exists. */
type FactionChannel = Extract<ChatChannel, "wolves" | "cult">;

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
  /** How the composer may deal this role. Absent means never dealt: a fill
   * role, or one reached only by conversion. */
  composition?: RoleComposition;
  /** The actions this role may take, keyed by perceived role. The pack's
   * attack is declared on `werewolf` and located via pack membership, not
   * here. */
  actions?: readonly ActionSpec[];
  /** The chat channels this role may read and write. Membership is by ROLE,
   * not faction: a wolf-faction role may be denied the channel. Only the
   * faction channels are role-gated; `public` and `grave` are decided by
   * status, so declaring one here would mean nothing. */
  channels?: readonly FactionChannel[];
  /** True when the role is one of the pack: a seat in the wolf ballot, wolf
   * chat, the nightly hunt. Membership is by ROLE, not faction — the sorcerer
   * is wolf-faction but never one of the pack. */
  packMember?: boolean;
  onDaySelected?(ctx: DaySelectionContext<State>): RoleEffect[];
}

import { alphaWolf } from "./alpha-wolf.ts";
import { cub } from "./cub.ts";
import { cultLeader } from "./cult-leader.ts";
import { cultist } from "./cultist.ts";
import { cupid } from "./cupid.ts";
import { cursed } from "./cursed.ts";
import { detective } from "./detective.ts";
import { drunk } from "./drunk.ts";
import { guardian } from "./guardian.ts";
import { harlot } from "./harlot.ts";
import { hunter } from "./hunter.ts";
import { loneWolf } from "./lone-wolf.ts";
import { mason } from "./mason.ts";
import { mayor } from "./mayor.ts";
import { priest } from "./priest.ts";
import { princess } from "./princess.ts";
import { seer } from "./seer.ts";
import { serialKiller } from "./serial-killer.ts";
import { sorcerer } from "./sorcerer.ts";
import { veteran } from "./veteran.ts";
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
  veteran,
  serial_killer: serialKiller,
  alpha_wolf: alphaWolf,
  drunk,
  mayor,
  cupid,
  priest,
  guardian,
  cub,
  sorcerer,
  detective,
  cult_leader: cultLeader,
  cultist,
  lone_wolf: loneWolf,
};

export function getRoleDefinition(role: RoleId): RoleDefinition {
  return roleRegistry[role];
}

/** Roles that may read and write the wolves chat channel. Membership is by
 * ROLE, not faction: a wolf-faction role may be denied the channel. */
export const WOLF_CHAT_ROLES: ReadonlySet<RoleId> = new Set(
  ROLE_IDS.filter((role) => roleRegistry[role].channels?.includes("wolves")),
);

/** True when the player is one of the pack: a seat in the wolf ballot, wolf
 * chat, the nightly hunt. Membership is by ROLE, not faction — the sorcerer is
 * wolf-faction but never one of the pack. */
export function isPackMember(player: { role: RoleId | null }): boolean {
  return player.role !== null && roleRegistry[player.role].packMember === true;
}

/** Roles that may read and write the cult chat channel. Membership is by ROLE,
 * not faction: only the leader and converted cultists are in the cult. */
export const CULT_CHAT_ROLES: ReadonlySet<RoleId> = new Set(
  ROLE_IDS.filter((role) => roleRegistry[role].channels?.includes("cult")),
);

/** True when the player is a member of the cult: a seat in the cult chat. The
 * cult leader starts in it; everyone else got there by conversion. */
export function isCultMember(player: { role: RoleId | null }): boolean {
  return player.role !== null && CULT_CHAT_ROLES.has(player.role);
}
