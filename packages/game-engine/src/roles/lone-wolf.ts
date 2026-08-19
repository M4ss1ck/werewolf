import type { RoleDefinition } from "./registry.ts";
export const loneWolf: RoleDefinition = {
  id: "lone_wolf",
  startingFaction: "lone_wolf",
  createState: () => ({}),
};
