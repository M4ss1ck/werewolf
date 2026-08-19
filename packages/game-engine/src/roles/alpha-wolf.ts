import type { RoleDefinition } from "./registry.ts";
export const alphaWolf: RoleDefinition = {
  id: "alpha_wolf",
  startingFaction: "wolves",
  createState: () => ({}),
  composition: { minimumPlayers: 10, replacesWolf: true },
  channels: ["wolves"],
  packMember: true,
};
