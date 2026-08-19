import type { RoleDefinition } from "./registry.ts";
export const seer: RoleDefinition = {
  id: "seer",
  startingFaction: "village",
  createState: () => ({}),
  composition: { drunkMayBelieve: true },
};
