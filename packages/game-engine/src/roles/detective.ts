import type { RoleDefinition } from "./registry.ts";

export const detective: RoleDefinition = {
  id: "detective",
  startingFaction: "village",
  createState: () => ({}),
  composition: { minimumPlayers: 7, drunkMayBelieve: true },
  actions: [
    {
      id: "detective.investigate",
      phase: "night",
      target: { kind: "one", pool: "others", excludeSelf: true },
      travelsToTarget: true,
      emitsResult: "detective.result",
    },
  ],
};
