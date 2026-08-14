import type { GameplayCommand, PhaseId, UserId } from "@werewolf/protocol";
import { afterEach, describe, expect, test, vi } from "vitest";

import { ApiError, api } from "./client.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api client", () => {
  test("throws a typed error carrying the code from the error body, never the raw HTTP status", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { code: "PHASE_CLOSED" } }), { status: 409 }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.join("game-1")).rejects.toMatchObject({ code: "PHASE_CLOSED" });

    const error = await api.join("game-1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("PHASE_CLOSED");
    expect((error as ApiError).message).toBe("PHASE_CLOSED");
    expect((error as { status?: unknown }).status).toBeUndefined();
  });

  test("sends credentials so the session cookie travels", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await api.listGames();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/games",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  test("a command carries a generated commandId, different on every post", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response("{}", { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);

    const command: Omit<GameplayCommand, "commandId"> = {
      phaseId: 1 as PhaseId,
      type: "vote.set",
      payload: { targetId: "user-1" as UserId },
    };
    await api.postCommand("game-1", command);
    await api.postCommand("game-1", command);

    const bodies = fetchMock.mock.calls.map(
      ([, init]) => JSON.parse((init as RequestInit).body as string) as Record<string, unknown>,
    );
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.commandId).toBeTruthy();
    expect(bodies[1]?.commandId).toBeTruthy();
    expect(bodies[0]?.commandId).not.toBe(bodies[1]?.commandId);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/games/game-1/commands",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
