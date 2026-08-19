import type { RoleDefinition } from "./registry.ts";

export const harlot: RoleDefinition = {
  id: "harlot",
  startingFaction: "village",
  createState: () => ({}),
  composition: {},
  actions: [
    {
      id: "harlot.visit",
      phase: "night",
      target: { kind: "one", pool: "others", excludeSelf: true },
      travelsToTarget: true,
    },
    {
      id: "harlot.stay",
      phase: "night",
      target: null,
    },
  ],
};
