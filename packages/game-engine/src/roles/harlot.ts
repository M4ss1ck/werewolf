import type { RoleDefinition } from "./registry.ts";
export const harlot: RoleDefinition = {
  id: "harlot",
  startingFaction: "village",
  createState: () => ({}),
};
