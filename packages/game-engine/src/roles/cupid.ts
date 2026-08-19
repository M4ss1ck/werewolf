import type { UserId } from "@werewolf/protocol";
import type { PlayerState } from "../state.ts";
import { getPerceivedRole } from "./perceived.ts";
import type { RoleDefinition } from "./registry.ts";

export const cupid: RoleDefinition<{ linked: [UserId, UserId] | null }> = {
  id: "cupid",
  startingFaction: "village",
  createState: () => ({ linked: null }),
  composition: { minimumPlayers: 8, drunkMayBelieve: true },
  actions: [
    {
      id: "cupid.link",
      phase: "night",
      // The cupid may link any two living players, including themselves.
      target: { kind: "pair", pool: "all", excludeSelf: false },
      available: ({ player, state }) => state.day === 1 && isUnlinkedCupid(player),
    },
  ],
};

function isCupidUnlinked(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "linked" in value &&
    (value as { linked: unknown }).linked === null
  );
}

/** Whether a player may act as an unlinked Cupid. A real Cupid is unlinked
 * until their roleState records a pair; a Drunk who believes they are Cupid is
 * always unlinked, because their perceived fresh state reads as null. */
export function isUnlinkedCupid(player: PlayerState): boolean {
  if (getPerceivedRole(player) !== "cupid") return false;
  if (player.role === "drunk") return true;
  return isCupidUnlinked(player.roleState);
}
