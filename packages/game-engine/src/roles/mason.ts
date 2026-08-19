import type { RoleDefinition } from "./registry.ts";
export const mason: RoleDefinition = {
  id: "mason",
  startingFaction: "village",
  createState: () => ({}),
  composition: { minimumPlayers: 8, copies: 2 },
};
