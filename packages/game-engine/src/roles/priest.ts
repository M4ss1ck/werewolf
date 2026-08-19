import type { UserId } from "@werewolf/protocol";
import type { RoleDefinition } from "./registry.ts";

export const priest: RoleDefinition<{ lastProtectedId: UserId | null }> = {
  id: "priest",
  startingFaction: "village",
  createState: () => ({ lastProtectedId: null }),
  composition: { minimumPlayers: 7, drunkMayBelieve: true },
};
