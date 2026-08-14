import type { RoleDefinition } from "./registry.ts";
export const villager: RoleDefinition = {
  id: "villager",
  startingFaction: "village",
  createState: () => ({}),
};
