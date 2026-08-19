import type { RoleDefinition } from "./registry.ts";
import { isPackMember } from "./registry.ts";

export const werewolf: RoleDefinition = {
  id: "werewolf",
  startingFaction: "wolves",
  createState: () => ({}),
  channels: ["wolves"],
  packMember: true,
  actions: [
    {
      id: "wolf.attack",
      phase: "night",
      // The pack's attack is owned by membership, not by this role id: a
      // converted werewolf and a cub both get it, and the sorcerer never does.
      target: { kind: "one", pool: "others", excludeSelf: true },
      eligible: ({ target }) => !isPackMember(target),
    },
  ],
};
