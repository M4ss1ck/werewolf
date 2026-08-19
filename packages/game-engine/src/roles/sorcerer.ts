import type { RoleDefinition } from "./registry.ts";

export const sorcerer: RoleDefinition = {
  id: "sorcerer",
  startingFaction: "wolves",
  createState: () => ({}),
  composition: { minimumPlayers: 8 },
  actions: [
    {
      id: "sorcerer.divine",
      phase: "night",
      target: { kind: "one", pool: "others", excludeSelf: true },
    },
  ],
};
