import type { RoleDefinition } from "./registry.ts";
export const detective: RoleDefinition = {
  id: "detective",
  startingFaction: "village",
  createState: () => ({}),
};
