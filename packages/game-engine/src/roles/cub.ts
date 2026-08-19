import type { RoleDefinition } from "./registry.ts";
export const cub: RoleDefinition = {
  id: "cub",
  startingFaction: "wolves",
  createState: () => ({}),
  composition: { minimumPlayers: 7, replacesWolf: true },
};
