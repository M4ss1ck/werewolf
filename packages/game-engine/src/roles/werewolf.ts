import type { RoleDefinition } from "./registry.ts";
export const werewolf: RoleDefinition = {
  id: "werewolf",
  startingFaction: "wolves",
  createState: () => ({}),
};
