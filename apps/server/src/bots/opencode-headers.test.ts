import { describe, expect, test } from "bun:test";
import {
  botSessionId,
  MODEL_CATALOG_SESSION_ID,
  OPENCODE_SESSION_HEADER,
  OPENCODE_USER_AGENT,
} from "./opencode-headers.ts";

describe("opencode headers", () => {
  test("identifies with its own user agent, not a generic SDK name", () => {
    expect(OPENCODE_USER_AGENT).toBe("werewolf-bots/1.0");
    expect(OPENCODE_SESSION_HEADER).toBe("x-opencode-session");
  });

  test("keeps one stable session per seat", () => {
    expect(botSessionId("game-1", "p0")).toBe("game-1:p0");
    expect(botSessionId("game-1", "p0")).toBe(botSessionId("game-1", "p0"));
    expect(botSessionId("game-1", "p1")).not.toBe(botSessionId("game-1", "p0"));
  });

  test("probes without a conversation on a static session", () => {
    expect(MODEL_CATALOG_SESSION_ID).toBe("werewolf-model-catalog");
  });
});
