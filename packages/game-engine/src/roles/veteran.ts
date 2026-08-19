import type { RoleDefinition } from "./registry.ts";
export const veteran: RoleDefinition = {
  id: "veteran",
  startingFaction: "veteran",
  createState: () => ({}),
  composition: {},
};
