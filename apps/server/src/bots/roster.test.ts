// The roster is deployment configuration, so a bad file must fail loudly at
// startup rather than quietly seating a bot that can never think.

import { describe, expect, test } from "bun:test";
import { isAbsolute } from "node:path";
import { ModelCatalog } from "./model-catalog.ts";
import {
  describeRoster,
  loadBotRoster,
  parseBotRoster,
  RANDOM_BOT,
  resolveRosterPath,
  toSeatConfig,
} from "./roster.ts";

const entry = (overrides: Record<string, unknown> = {}) => ({
  id: "mira",
  displayName: "Mira",
  model: "deepseek-v4-flash",
  ...overrides,
});

describe("roster parsing", () => {
  test("applies per-bot defaults and always includes the random bot", () => {
    const roster = parseBotRoster([entry()]);
    expect(roster[0]).toEqual(RANDOM_BOT);
    expect(roster[1]).toMatchObject({
      id: "mira",
      model: "deepseek-v4-flash",
      temperature: 0.8,
      maxOutputTokens: 180,
      timeoutMs: 15_000,
    });
  });

  test("keeps each bot's own settings rather than a global default", () => {
    const roster = parseBotRoster([
      entry({ temperature: 0.2, maxOutputTokens: 60, timeoutMs: 4_000 }),
      entry({ id: "bram", displayName: "Bram", temperature: 1.4, maxOutputTokens: 400 }),
    ]);
    expect(roster[1]!.temperature).toBe(0.2);
    expect(roster[1]!.maxOutputTokens).toBe(60);
    expect(roster[2]!.temperature).toBe(1.4);
    expect(roster[2]!.maxOutputTokens).toBe(400);
  });

  test("rejects a duplicate id", () => {
    expect(() => parseBotRoster([entry(), entry()])).toThrow(/Duplicate bot id/);
  });

  test("rejects an id colliding with the built-in random bot", () => {
    expect(() => parseBotRoster([entry({ id: "random" })])).toThrow(/Duplicate bot id/);
  });

  test("rejects a malformed entry with the offending field named", () => {
    expect(() => parseBotRoster([entry({ temperature: 9 })])).toThrow(/temperature/);
    expect(() => parseBotRoster([{ displayName: "No id" }])).toThrow(/Invalid bot roster/);
  });

  test("freezes the entry's settings onto the seat", () => {
    const [, mira] = parseBotRoster([entry({ temperature: 0.3, personality: "terse" })]);
    expect(toSeatConfig(mira!, "opencode-go")).toEqual({
      botId: "mira",
      provider: "opencode-go",
      model: "deepseek-v4-flash",
      temperature: 0.3,
      maxOutputTokens: 180,
      timeoutMs: 15_000,
      personality: "terse",
    });
  });
});

describe("roster path resolution", () => {
  // The dev server runs with cwd apps/server and the production image with cwd
  // /app, so a cwd-relative roster silently missed in one of them and the
  // lobby showed only the built-in bot.
  test("anchors a relative path to the repository root, not the working directory", () => {
    const resolved = resolveRosterPath("./bots.json");
    expect(isAbsolute(resolved)).toBe(true);
    expect(resolved.endsWith("/bots.json")).toBe(true);
    expect(resolved).not.toContain("/apps/server/");
  });

  test("leaves an absolute path alone", () => {
    expect(resolveRosterPath("/etc/werewolf/bots.json")).toBe("/etc/werewolf/bots.json");
  });

  test("the shipped roster loads and offers more than the built-in bot", () => {
    const roster = loadBotRoster("./bots.json");
    expect(roster.length).toBeGreaterThan(1);
    expect(roster.map((entry) => entry.id)).toContain("random");
  });

  test("a missing roster is reported rather than passed off as a roster of one", () => {
    const events: string[] = [];
    const roster = loadBotRoster("./no-such-roster.json", (event) => events.push(event));
    expect(roster).toEqual([RANDOM_BOT]);
    expect(events).toContain("roster_missing");
  });
});

describe("roster availability", () => {
  const roster = parseBotRoster([
    entry(),
    entry({ id: "bram", displayName: "Bram", model: "glm-5" }),
  ]);
  const by = (entries: ReturnType<typeof describeRoster>, id: string) =>
    entries.find((candidate) => candidate.id === id)!;

  test("marks a model the provider does not list", () => {
    const view = describeRoster(
      roster,
      { configured: true, has: (model) => model === "deepseek-v4-flash" },
      new Set(),
    );
    expect(by(view, "mira").available).toBe(true);
    expect(by(view, "bram")).toMatchObject({ available: false, reason: "MODEL_NOT_AVAILABLE" });
  });

  test("with no provider only the random bot is selectable", () => {
    const view = describeRoster(roster, { configured: false, has: () => true }, new Set());
    expect(by(view, "random").available).toBe(true);
    expect(by(view, "mira")).toMatchObject({
      available: false,
      reason: "PROVIDER_NOT_CONFIGURED",
    });
  });

  test("a bot already at the table cannot be seated twice", () => {
    const view = describeRoster(roster, { configured: true, has: () => true }, new Set(["mira"]));
    expect(by(view, "mira")).toMatchObject({ available: false, reason: "ALREADY_SEATED" });
    expect(by(view, "bram").available).toBe(true);
  });

  test("never exposes the endpoint or the key", () => {
    const view = describeRoster(roster, { configured: true, has: () => true }, new Set());
    const keys = new Set(view.flatMap((candidate) => Object.keys(candidate)));
    expect([...keys].sort()).toEqual(["available", "displayName", "id", "model"]);
  });
});

describe("model catalog", () => {
  test("reports a listed model as available and an unlisted one as not", async () => {
    const catalog = new ModelCatalog({
      baseUrl: "https://example.test/v1",
      apiKey: "secret",
      fetch: async (url, init) => {
        expect(url).toBe("https://example.test/v1/models");
        expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret");
        return new Response(JSON.stringify({ data: [{ id: "glm-5" }, { id: "kimi-k3" }] }));
      },
    });
    await catalog.probe();
    expect(catalog.has("glm-5")).toBe(true);
    expect(catalog.has("nope")).toBe(false);
  });

  test("fails open when the probe fails, rather than disabling every bot", async () => {
    const catalog = new ModelCatalog({
      baseUrl: "https://example.test/v1",
      apiKey: "secret",
      fetch: async () => new Response("nope", { status: 500 }),
    });
    await catalog.probe();
    expect(catalog.has("anything")).toBe(true);
  });

  test("is not configured without a key, and never calls out", async () => {
    let called = false;
    const catalog = new ModelCatalog({
      baseUrl: "https://example.test/v1",
      fetch: async () => {
        called = true;
        return new Response("{}");
      },
    });
    await catalog.probe();
    expect(catalog.configured).toBe(false);
    expect(called).toBe(false);
  });
});
