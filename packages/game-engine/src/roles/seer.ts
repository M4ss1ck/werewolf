import type { RoleDefinition } from "./registry.ts";

export const seer: RoleDefinition = {
  id: "seer",
  startingFaction: "village",
  createState: () => ({}),
  composition: { drunkMayBelieve: true },
  actions: [
    {
      id: "seer.inspect",
      phase: "night",
      target: { kind: "one", pool: "others", excludeSelf: true },
      emitsResult: "seer.result",
    },
  ],
};
