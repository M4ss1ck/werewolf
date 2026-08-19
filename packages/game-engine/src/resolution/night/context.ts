import type { ConversionCause, NightDeathCause, UserId } from "@werewolf/protocol";
import type { SeededRng } from "../../rng/rng.ts";
import type { GameState, PlayerState } from "../../state.ts";
import type { FrozenIntents } from "./freeze.ts";

/** The evolving facts of one night, threaded through the ordered stages. A
 * mutable context is deliberate: the stages are an ordered pipeline over one
 * night's facts, and threading ten values through eight pure returns would
 * obscure the order `attacks.ts` exists to make readable.
 *
 * This lives apart from `attacks.ts` so the stages can share it without
 * importing the resolver that calls them. */
export interface NightContext {
  state: GameState;
  frozen: FrozenIntents;
  locations: Map<UserId, UserId>;
  rng: SeededRng;
  day: number;
  wolfTargetId: UserId | null;
  attacks: { attacker: "wolves" | "serial_killer"; houseId: UserId }[];
  repelled: Set<"wolves" | "serial_killer">;
  hits: Map<UserId, Set<"wolves" | "serial_killer">>;
  deaths: Map<UserId, NightDeathCause>;
  conversions: { playerId: UserId; cause: ConversionCause }[];
  ascension: { playerId: UserId } | null;
  loneWolfResult: { playerId: UserId; targetId: UserId; found: boolean } | null;
  protectedId: UserId | null;
}

export type NightOutcome = {
  deaths: Map<UserId, NightDeathCause>;
  conversions: { playerId: UserId; cause: ConversionCause }[];
  /** The Lone Wolf won the duel and ascended to Alpha this night. */
  ascension: { playerId: UserId } | null;
  /** The Lone Wolf's search result for this night. */
  loneWolfResult: { playerId: UserId; targetId: UserId; found: boolean } | null;
};

export function livingPlayers(state: GameState): PlayerState[] {
  return Object.values(state.players).filter((player) => player.status === "alive");
}

export function occupantsOf(
  state: GameState,
  locations: Map<UserId, UserId>,
  houseId: UserId,
): PlayerState[] {
  return livingPlayers(state).filter((player) => locations.get(player.id) === houseId);
}

/** A player the cult cannot convert. Wolves, the serial killer and the hunter
 * are immune; the Veteran is deliberately NOT — the cult wins by converting,
 * and denying it the Veteran would gut its core loop. */
export function isCultImmune(player: PlayerState): boolean {
  return player.faction === "wolves" || player.role === "serial_killer" || player.role === "hunter";
}
