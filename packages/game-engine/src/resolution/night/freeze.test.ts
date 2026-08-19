import { describe, expect, test } from "bun:test";
import type { PlayerState } from "../../state.ts";
import { makeState } from "../night.test.ts";
import { freezeNightIntents, intentsFor, soleIntent } from "./freeze.ts";

const id = (value: string) => value as PlayerState["id"];

/** `makeState` builds players with empty roleState; a Drunk's perceived role
 * lives there, so set it after the fact. The faction/role consistency the
 * helper guarantees is preserved. */
function withRoleState(
  state: ReturnType<typeof makeState>,
  playerId: string,
  roleState: unknown,
): ReturnType<typeof makeState> {
  return {
    ...state,
    players: {
      ...state.players,
      [id(playerId)]: { ...state.players[id(playerId)]!, roleState },
    },
  };
}

describe("freezeNightIntents", () => {
  test("an intent records who stored the action, not who holds the role", () => {
    // A Drunk who believes they are the Detective. The intent is theirs.
    const state = withRoleState(
      makeState(["drunk", "villager"], {
        p0: { "detective.investigate": { targetId: "p1" } },
      }),
      "p0",
      { perceivedRole: "detective" },
    );
    const intent = soleIntent(freezeNightIntents(state), "detective.investigate");
    expect(intent?.actorId).toBe(id("p0"));
    expect(intent?.mimicked).toBe(true);
  });

  test("an intent against a dead target is dropped", () => {
    const state = makeState(["detective", "villager"], {
      p0: { "detective.investigate": { targetId: "p1" } },
    });
    state.players[id("p1")]!.status = "dead";
    const intent = soleIntent(freezeNightIntents(state), "detective.investigate");
    expect(intent).toBeUndefined();
  });

  test("an intent stored for an earlier phase is dropped", () => {
    // The stored action is for phase 1, but the current phase is 2.
    const state = makeState(["detective", "villager"], {
      p0: { "detective.investigate": { targetId: "p1" } },
    });
    state.phase = { id: 2 as never, type: "night", startedAt: 0, endsAt: 100 };
    const intent = soleIntent(freezeNightIntents(state), "detective.investigate");
    expect(intent).toBeUndefined();
  });

  test("every pack member's ballot is frozen", () => {
    const state = makeState(["werewolf", "werewolf", "villager"], {
      p0: { "wolf.attack": { targetId: "p2" } },
      p1: { "wolf.attack": { targetId: "p2" } },
    });
    const votes = intentsFor(freezeNightIntents(state), "wolf.attack");
    expect(votes).toHaveLength(2);
  });
});
