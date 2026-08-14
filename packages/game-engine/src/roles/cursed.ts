import type { RoleDefinition } from "./registry.ts";
export const cursed: RoleDefinition = {
  id: "cursed",
  startingFaction: "village",
  createState: () => ({}),
};
