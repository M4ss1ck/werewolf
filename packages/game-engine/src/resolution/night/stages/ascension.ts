import { livingPlayers, type NightContext } from "../context.ts";

// Stage 9: the Alpha's death ends the Lone Wolf's hunt. Ascension is the
// Lone Wolf's only path to the Alpha's seat, so if the last living Alpha
// Wolf died this resolution and a Lone Wolf is still alive, the Lone Wolf
// converts to a plain werewolf and wins with the pack from then on. An
// ascended Lone Wolf is now the Alpha, so this does not fire for them.
export function loneWolfAscension(context: NightContext): void {
  const { state, deaths, conversions, ascension } = context;
  const livingAlpha = livingPlayers(state).find(
    (player) => player.role === "alpha_wolf" && !deaths.has(player.id),
  );
  const livingLoneWolf = livingPlayers(state).find(
    (player) => player.role === "lone_wolf" && !deaths.has(player.id),
  );
  if (!livingAlpha && !ascension && livingLoneWolf) {
    conversions.push({ playerId: livingLoneWolf.id, cause: "alpha_dead" });
  }
}
