import type { RoleDefinition } from "./registry.ts";
export const alphaWolf: RoleDefinition = {
  id: "alpha_wolf",
  startingFaction: "wolves",
  createState: () => ({}),
};
