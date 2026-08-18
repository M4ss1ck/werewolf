// An entire match played by bots, end to end, against a deterministic fake
// provider. This is the cheapest way to exercise the engine's resolution order
// over a real sequence of phases, and it makes no paid model request.

import { describe, expect, test } from "bun:test";
import { LlmBotAgent } from "./agent.ts";
import { FakeModelProvider, setupBots, testBotConfig } from "./fixtures.ts";

/** A provider that always names the first legal action and says something. It
 * is not a strategy: it just guarantees every bot acts every phase. */
function scriptedProvider(count: number) {
  return new FakeModelProvider(
    Array.from({ length: count }, () =>
      JSON.stringify({ actionId: 0, say: "Someone here is lying.", channel: "public" }),
    ),
  );
}

describe("a full bot match", () => {
  test("runs to a win condition without a human ever acting", async () => {
    const config = testBotConfig({ BOT_CHAT_TURNS: "1" });
    const harness = await setupBots({
      agent: new LlmBotAgent(scriptedProvider(400), config),
      config,
    });
    const gameId = await harness.startBotGame(6);

    for (let phase = 0; phase < 40; phase += 1) {
      const state = await harness.state(gameId);
      if (state.status !== "running") break;
      await harness.advancePhase(gameId);
    }

    const final = await harness.state(gameId);
    expect(final.status).toBe("finished");
    expect(final.winner).not.toBeNull();
    expect([
      "wolves_eliminated",
      "village_eliminated",
      "veteran_lynched",
      "serial_killer_survives",
    ]).toContain(final.winner!.reason);
    expect(final.winner!.winningFactions.length).toBeGreaterThan(0);

    // The match was played, not merely timed out: bots voted and talked.
    const events = await harness.coordinator.getVisibleEvents(gameId, 0);
    expect(events.some((event) => event.kind === "chat.message")).toBe(true);
    expect(events.some((event) => event.kind === "player.eliminated")).toBe(true);
    expect(events.some((event) => event.kind === "game.finished")).toBe(true);
  });

  test("runs with no provider at all, on the fallback alone", async () => {
    // This is the zero-configuration path: no BOT_AI_API_KEY, no cost.
    const harness = await setupBots();
    const gameId = await harness.startBotGame(6);

    for (let phase = 0; phase < 40; phase += 1) {
      const state = await harness.state(gameId);
      if (state.status !== "running") break;
      await harness.advancePhase(gameId);
    }

    const final = await harness.state(gameId);
    expect(final.status).toBe("finished");
    expect(final.winner).not.toBeNull();
  });
});
