import type { ChatContent, GameplayCommand, PhaseId, UserId } from "@werewolf/protocol";
import { afterEach, describe, expect, test, vi } from "vitest";

import { ApiError, api } from "./client.ts";

const mocks = vi.hoisted(() => ({ isTauri: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: mocks.isTauri }));

afterEach(() => {
  vi.unstubAllGlobals();
  mocks.isTauri.mockReset();
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

  test("sends the bearer token when one is stored and omits it entirely when none is", async () => {
    mocks.isTauri.mockReturnValue(true);
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response("[]", { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("localStorage", {
      getItem: () => "token-9",
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });

    await api.listGames();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/games",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer token-9" }),
      }),
    );

    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    fetchMock.mockClear();

    await api.listGames();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/games",
      expect.objectContaining({ headers: { "content-type": "application/json" } }),
    );
  });

  test("captures a set-auth-token header from an API response", async () => {
    mocks.isTauri.mockReturnValue(true);
    const storage = { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() };
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("[]", { status: 200, headers: { "set-auth-token": "token-7" } }),
        ),
    );

    await api.listGames();

    expect(storage.setItem).toHaveBeenCalledWith("werewolf.auth-token", "token-7");
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

  test("getStats hits the stats endpoint and returns the viewer's lifetime stats", async () => {
    const body = { games: 3, survived: 1, asWolf: 2 };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const stats = await api.getStats();

    expect(stats).toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith("/api/me/stats", expect.anything());
  });

  test("getReplay resolves the snapshot field the server now sends", async () => {
    const body = { snapshot: { game: { id: "g1" }, players: [] }, events: [] };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await api.getReplay("game-1");

    expect(result.snapshot).toEqual({ game: { id: "g1" }, players: [] });
    expect(result.events).toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith("/api/games/game-1/replay", expect.anything());
  });

  test("posts canonical structured chat content and parses returned mention metadata", async () => {
    const content: ChatContent = {
      text: "hello @Ada",
      mentions: [{ userId: "u2" as UserId, start: 6, length: 4 }],
    };
    const message = {
      id: 4,
      userId: "u1",
      displayName: "Wren",
      text: content.text,
      mentions: content.mentions,
      createdAt: 1,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(message), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.sendChatMessage(content)).resolves.toMatchObject({
      mentions: content.mentions,
    });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toEqual(content);
  });

  test("encodes candidate searches and accepts only candidate arrays", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify([{ userId: "u2", displayName: "Ada" }]), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.getMentionCandidates("Ada & co")).resolves.toEqual([
      { userId: "u2", displayName: "Ada" },
    ]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/chat/mention-candidates?q=Ada%20%26%20co");
  });

  test("history GET parses mention metadata and keeps its response shape", async () => {
    const body = {
      messages: [
        {
          id: 4,
          userId: "u1",
          displayName: "Wren",
          text: "hello",
          mentions: [],
          createdAt: 1,
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })),
    );

    await expect(api.getChatHistory(5)).resolves.toEqual(body);
  });
});
