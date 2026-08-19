import type { RoleDefinition } from "./registry.ts";
export const cultLeader: RoleDefinition = {
  id: "cult_leader",
  startingFaction: "cult",
  createState: () => ({}),
  composition: { minimumPlayers: 9 },
};
