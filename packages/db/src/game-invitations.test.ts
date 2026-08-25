import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GameCode, GameId, UserId } from "@werewolf/protocol";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createDb } from "./client.ts";
import { GameRepository } from "./repository.ts";

const MIGRATIONS_DIR = new URL("./migrations/", import.meta.url).pathname;
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

async function setup(makeGameCode?: () => string) {
  const dir = mkdtempSync(join(tmpdir(), "werewolf-db-invitation-test-"));
  const { client, db } = createDb(`file:${join(dir, "test.db")}`);
  cleanups.push(() => {
    client.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return { client, db, repo: new GameRepository(db, makeGameCode) };
}

function gameInput(id: string, ownerDisplayName: string) {
  return {
    id: id as GameId,
    ownerUserId: "owner" as UserId,
    name: "Invitation test",
    visibility: "private",
    status: "lobby",
    settings: { discussionDurationMs: 1, votingDurationMs: 1, nightDurationMs: 1 },
    balanceVersion: 1,
    createdAt: 1,
    ownerDisplayName,
  };
}

describe("durable game invitations", () => {
  test("game-code generation consumes 0..239 and rejects 240..255 without modulo bias", async () => {
    const { generateGameCode, GAME_CODE_ALPHABET } = await import("./game-code.ts");
    let nextByte = 0;
    let calls = 0;
    const counts = new Map<string, number>();
    for (let i = 0; i < 24; i += 1) {
      const code = generateGameCode(() => {
        calls += 1;
        return Uint8Array.of(nextByte++ % 256);
      });
      for (const character of code) counts.set(character, (counts.get(character) ?? 0) + 1);
    }
    expect(calls).toBe(240);
    expect([...counts.values()]).toEqual(new Array(GAME_CODE_ALPHABET.length).fill(8));
    let rejectionCalls = 0;
    const rejected = generateGameCode(() => {
      rejectionCalls += 1;
      return Uint8Array.of(rejectionCalls <= 16 ? 240 + rejectionCalls - 1 : rejectionCalls - 17);
    });
    expect(rejected).toHaveLength(10);
    expect(rejectionCalls).toBe(26);
  });

  test("atomic creation stores a code and owner in one transaction", async () => {
    const { repo } = await setup(() => "K7M3P9T2WQ");
    await repo.createGame(gameInput("atomic", "Owner"));
    expect(await repo.getJoinCode("atomic" as GameId)).toBe("K7M3P9T2WQ" as GameCode);
    expect(await repo.getGameIdByJoinCode("K7M3P9T2WQ" as GameCode)).toBe("atomic" as GameId);
    expect(await repo.getGame("atomic" as GameId)).not.toHaveProperty("joinCode");
    expect((await repo.getMembership("atomic" as GameId, "owner" as UserId))?.displayName).toBe(
      "Owner",
    );
  });

  test("creation ignores an invalid external join-code property", async () => {
    const { repo } = await setup(() => "K7M3P9T2WQ");
    const input = { ...gameInput("canonical", "Owner"), joinCode: "ABCD" } as never;
    await repo.createGame(input);
    expect(await repo.getJoinCode("canonical" as GameId)).toBe("K7M3P9T2WQ" as GameCode);
    expect(await repo.getJoinCode("canonical" as GameId)).not.toBe("ABCD" as GameCode);
  });

  test("a join-code collision retries the complete game and owner transaction", async () => {
    const codes = ["K7M3P9T2WQ", "K7M3P9T2WQ", "Q2W3E4R5T6"];
    const { repo } = await setup(() => codes.shift()!);
    await repo.createGame(gameInput("first", "First"));
    await repo.createGame(gameInput("second", "Second"));
    expect(await repo.getJoinCode("second" as GameId)).toBe("Q2W3E4R5T6" as GameCode);
    expect((await repo.getMembership("second" as GameId, "owner" as UserId))?.displayName).toBe(
      "Second",
    );
  });

  test("owner insertion failure rolls back the game and owner rows together", async () => {
    const { client, repo } = await setup(() => "K7M3P9T2WQ");
    await client.execute(
      "create trigger reject_owner before insert on game_players begin select raise(abort, 'owner insert failed'); end",
    );

    await expect(repo.createGame(gameInput("rollback", "Owner"))).rejects.toThrow();
    expect(await repo.getGame("rollback" as GameId)).toBeNull();
    expect(await repo.getMembership("rollback" as GameId, "owner" as UserId)).toBeNull();
  });

  test("non-code uniqueness failures are propagated without retrying", async () => {
    let calls = 0;
    const { repo } = await setup(() => {
      calls += 1;
      return `K7M3P9T2W${calls === 1 ? "Q" : "R"}`;
    });
    await repo.createGame(gameInput("duplicate", "First"));
    await expect(repo.createGame(gameInput("duplicate", "Second"))).rejects.toThrow();
    expect(calls).toBe(2);
    expect((await repo.getMembership("duplicate" as GameId, "owner" as UserId))?.displayName).toBe(
      "First",
    );
  });

  test("state loading excludes replay and denied memberships while lookup sees each access state", async () => {
    const { repo } = await setup(() => "K7M3P9T2WQ");
    await repo.createGame(gameInput("membership", "Owner"));
    await repo.addPlayer({
      gameId: "membership" as GameId,
      userId: "active" as UserId,
      displayName: "Active",
      joinedAt: 1,
    });
    for (const [userId, membershipAccess] of [
      ["replay", "replay"],
      ["denied", "denied"],
    ] as const)
      await repo.addPlayer({
        gameId: "membership" as GameId,
        userId: userId as UserId,
        displayName: userId,
        status: "spectator",
        membershipAccess,
        joinedAt: 1,
      });

    expect(Object.keys((await repo.loadGameState("membership" as GameId))!.players).sort()).toEqual(
      ["active", "owner"],
    );
    expect(
      (await repo.getMembership("membership" as GameId, "replay" as UserId))?.membershipAccess,
    ).toBe("replay");
    expect(
      (await repo.getMembership("membership" as GameId, "denied" as UserId))?.membershipAccess,
    ).toBe("denied");
  });

  test("summary players and counts include active playing seats only", async () => {
    const { repo } = await setup(() => "K7M3P9T2WQ");
    await repo.createGame(gameInput("summary", "Owner"));
    await repo.addPlayer({
      gameId: "summary" as GameId,
      userId: "spectator" as UserId,
      displayName: "Spectator",
      status: "spectator",
      joinedAt: 1,
    });
    await repo.addPlayer({
      gameId: "summary" as GameId,
      userId: "replay" as UserId,
      displayName: "Replay",
      status: "spectator",
      membershipAccess: "replay",
      joinedAt: 1,
    });
    const [summary] = await repo.listGameSummaries("owner" as UserId);
    expect(summary?.players).toEqual([{ userId: "owner" as UserId, displayName: "Owner" }]);
  });

  test("authoritative private visibility is mapped into settings", async () => {
    const { repo } = await setup(() => "K7M3P9T2WQ");
    await repo.createGame(gameInput("visibility", "Owner"));
    const state = await repo.loadGameState("visibility" as GameId);
    expect(state?.settings.visibility).toBe("private");
  });
});
