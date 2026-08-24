import type { RoleDefinition } from "./registry.ts";

export const serialKiller: RoleDefinition = {
  id: "serial_killer",
  startingFaction: "serial_killer",
  createState: () => ({}),
  composition: {},
  contests: () => true,
  actions: [
    {
      id: "serial_killer.visit",
      phase: "night",
      target: { kind: "one", pool: "others", excludeSelf: true },
      travelsToTarget: true,
    },
    {
      id: "serial_killer.stay",
      phase: "night",
      target: null,
    },
  ],
};
