import type { RoleDefinition } from "./registry.ts";
export const cultist: RoleDefinition = {
  id: "cultist",
  startingFaction: "cult",
  createState: () => ({}),
};
