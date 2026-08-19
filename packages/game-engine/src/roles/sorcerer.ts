import type { RoleDefinition } from "./registry.ts";
export const sorcerer: RoleDefinition = {
  id: "sorcerer",
  startingFaction: "wolves",
  createState: () => ({}),
  composition: { minimumPlayers: 8 },
};
