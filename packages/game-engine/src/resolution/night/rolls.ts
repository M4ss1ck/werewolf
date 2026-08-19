import type { RoleId, UserId } from "@werewolf/protocol";
import { ROLE_IDS } from "@werewolf/protocol";
import { DETECTIVE_SUCCESS_CHANCE } from "../../composer/balance-v1.ts";
import type { SeededRng } from "../../rng/rng.ts";
import type { GameState } from "../../state.ts";
import { type FrozenIntents, intentsFor } from "./freeze.ts";

export interface NightRolls {
  /** Real Detective and Drunk-Detective results, by actor id. `null` role
   * means inconclusive. */
  investigations: ReadonlyMap<UserId, RoleId | null>;
  /** Drunk-as-Seer fake results, by actor id. */
  fakeInspections: ReadonlyMap<UserId, RoleId>;
}

/** Roll the night's dice. The derive scopes and the number and order of calls
 * are load-bearing: `resolution/drunk.test.ts` and `detective.test.ts` pin
 * determinism for a seed, so a reused or reordered derive would shift a drawn
 * value. Each scope is independent, but the order below matches the original
 * freeze: fake-result, then detective:investigation, then drunk:fake-detective. */
export function rollNight(
  state: GameState,
  frozen: FrozenIntents,
  rng: SeededRng,
  day: number,
): NightRolls {
  const investigations = new Map<UserId, RoleId | null>();
  const fakeInspections = new Map<UserId, RoleId>();

  // A Drunk who believes they are the Seer is told a uniformly random role.
  for (const intent of intentsFor(frozen, "seer.inspect")) {
    if (!intent.mimicked) continue;
    fakeInspections.set(
      intent.actorId,
      ROLE_IDS[rng.derive(`night:${day}:drunk:fake-result`).int(ROLE_IDS.length)]!,
    );
  }

  // The real Detective investigates by walking to the target's house; a miss
  // reports inconclusive (null), never a wrong role.
  for (const intent of intentsFor(frozen, "detective.investigate")) {
    if (intent.mimicked) continue;
    investigations.set(
      intent.actorId,
      rng.derive(`night:${day}:detective:investigation`).float() < DETECTIVE_SUCCESS_CHANCE
        ? state.players[intent.targetId!]!.role!
        : null,
    );
  }

  // A Drunk who believes they are the Detective is told the same shape of
  // result as a real one would see. ONE derived rng, then float() THEN
  // int(ROLE_IDS.length) on that SAME rng, in that order.
  for (const intent of intentsFor(frozen, "detective.investigate")) {
    if (!intent.mimicked) continue;
    const drunkRng = rng.derive(`night:${day}:drunk:fake-detective`);
    investigations.set(
      intent.actorId,
      drunkRng.float() < DETECTIVE_SUCCESS_CHANCE ? ROLE_IDS[drunkRng.int(ROLE_IDS.length)]! : null,
    );
  }

  return { investigations, fakeInspections };
}
