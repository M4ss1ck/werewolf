import type { NightContext, NightOutcome } from "./context.ts";
import { loneWolfAscension } from "./stages/ascension.ts";
import { loneWolfDuel, serialKillerClash } from "./stages/clashes.ts";
import { applyConversions } from "./stages/conversions.ts";
import { harlotExposure } from "./stages/exposure.ts";
import { computeHits, planAttacks } from "./stages/hits.ts";
import { hunterRetaliation } from "./stages/retaliation.ts";
import { priestShield } from "./stages/shield.ts";
import { guardianSubstitution } from "./stages/substitution.ts";

/** Resolve the night's attacks house by house. There are at most two attacks —
 * the pack on the balloted target's house and the serial killer on its visit
 * target — resolved in this exact order:
 *
 *   1. Freeze intents            (freezeNightIntents, before this function)
 *   2. Place everyone in houses  (resolveNightLocations, before this function)
 *   3. Clashes: hunter retaliation, then serial-killer / wolf clash
 *   4. Compute raw hits
 *   5. Priest shield cancels a hit entirely
 *   6. Guardian substitution for any hit that survived the shield
 *   7. Conversions on the hits that remain: Cursed first, then Alpha
 *   8. Cult conversion (not a hit; its own sub-step)
 *   9. Harlot exposure
 *
 * Later roles slot into a named stage instead of being wedged in wherever they
 * fit. Stages 5 and 6 are the only new ones; everything else behaves exactly
 * as it always has. */
export function resolveHouseAttacks(context: NightContext): NightOutcome {
  planAttacks(context); // stage 1-2: who is attacking which house
  hunterRetaliation(context); // stage 3
  serialKillerClash(context); // stage 3
  loneWolfDuel(context); // stage 3
  computeHits(context); // stage 4
  priestShield(context); // stage 5
  guardianSubstitution(context); // stage 6
  applyConversions(context); // stage 7 — cursed, then alpha, then cult
  harlotExposure(context); // stage 8
  loneWolfAscension(context); // stage 9
  return {
    deaths: context.deaths,
    conversions: context.conversions,
    ascension: context.ascension,
    loneWolfResult: context.loneWolfResult,
  };
}
