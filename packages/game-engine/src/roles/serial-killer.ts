import type { RoleDefinition } from "./registry.ts";
export const serialKiller: RoleDefinition = {
  id: "serial_killer",
  startingFaction: "serial_killer",
  createState: () => ({}),
};
