import type { RoleDefinition } from "./registry.ts";
export const detective: RoleDefinition = {
  id: "detective",
  startingFaction: "village",
  createState: () => ({}),
  composition: { minimumPlayers: 7, drunkMayBelieve: true },
};
