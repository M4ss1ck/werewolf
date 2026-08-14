import type { RoleDefinition } from "./registry.ts";
export const hunter: RoleDefinition = {
  id: "hunter",
  startingFaction: "village",
  createState: () => ({}),
};
