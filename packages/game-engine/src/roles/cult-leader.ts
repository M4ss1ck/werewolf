import type { RoleDefinition } from "./registry.ts";

export const cultLeader: RoleDefinition = {
  id: "cult_leader",
  startingFaction: "cult",
  createState: () => ({}),
  composition: { minimumPlayers: 9 },
  channels: ["cult"],
  contests: () => true,
  actions: [
    {
      id: "cult.convert",
      phase: "night",
      target: { kind: "one", pool: "others", excludeSelf: true },
      travelsToTarget: true,
    },
  ],
};
