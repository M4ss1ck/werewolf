import type { NightContext } from "../context.ts";
import { realIntent } from "../freeze.ts";

// Stage 8: harlot exposure. A harlot who visits a wolf's own house while
// that wolf is home dies from exposure: the wolf is in, the encounter is
// fatal. When the pack has a target the wolf is out hunting and the house is
// empty, so she survives. This is the Harlot dying away from home, not a hit
// on a house, so neither the shield nor the substitution applies to it.
export function harlotExposure(context: NightContext): void {
  const { state, frozen, locations, deaths } = context;
  const harlotVisit = realIntent(frozen, "harlot.visit");
  if (harlotVisit) {
    const harlot = harlotVisit.actorId;
    const houseId = harlotVisit.targetId!;
    const owner = state.players[houseId];
    if (owner?.faction === "wolves" && locations.get(houseId) === houseId && !deaths.has(harlot))
      deaths.set(harlot, "harlot_exposure");
  }
}
