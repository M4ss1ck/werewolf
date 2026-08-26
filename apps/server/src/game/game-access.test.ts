import { expect, test } from "bun:test";
import { games } from "@werewolf/db";
import type { GameEntryMode, GameEntryReference, GameId, UserId } from "@werewolf/protocol";
import { eq } from "drizzle-orm";
import { as, createGame, setup, USERS } from "../test/harness.ts";
import { GameAccess } from "./game-access.ts";
import { GameLock } from "./locks.ts";

test("GameAccess admits a lobby player through an invitation", async () => {
  const { app, repo } = await setup();
  const game = await createGame(app, USERS[0]!);
  const code = (await repo.getJoinCode(game.id))!;
  const access = new GameAccess(repo);
  const reference: GameEntryReference = { kind: "invitation", code };

  expect(await access.preview(reference, { userId: USERS[1]! as UserId })).toMatchObject({
    status: "lobby",
    canJoin: true,
    membership: null,
  });
  await expect(
    access.admit(reference, { userId: USERS[1]! as UserId, username: USERS[1]! }, "player"),
  ).resolves.toMatchObject({ gameId: game.id, destination: "game" });
  expect((await repo.getMembership(game.id, USERS[1]! as UserId))?.membershipAccess).toBe("active");
});

test("GameAccess uses the current state when admission follows a stale preview", async () => {
  const { app, repo, db } = await setup();
  const game = await createGame(app, USERS[0]!);
  const code = (await repo.getJoinCode(game.id))!;
  const access = new GameAccess(repo);
  const reference: GameEntryReference = { kind: "invitation", code };
  await db.update(games).set({ status: "running", version: 1 }).where(eq(games.id, game.id));

  await expect(
    access.admit(reference, { userId: USERS[1]! as UserId, username: USERS[1]! }, "player"),
  ).rejects.toMatchObject({ code: "GAME_ALREADY_STARTED" });
});

test("status changes queued before admission are revalidated under the game lock", async () => {
  const { app, repo, db } = await setup();
  const game = await createGame(app, USERS[0]!);
  const code = (await repo.getJoinCode(game.id))!;
  const reference: GameEntryReference = { kind: "invitation", code };
  const lock = new GameLock();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const access = new GameAccess(repo, lock);
  const statusChange = lock.run(game.id, async () => {
    entered.resolve();
    await release.promise;
    await db.update(games).set({ status: "running" }).where(eq(games.id, game.id));
  });
  await entered.promise;
  const admission = access.admit(
    reference,
    { userId: USERS[1]! as UserId, username: USERS[1]! },
    "player",
  );
  release.resolve();
  await statusChange;
  await expect(admission).rejects.toMatchObject({ code: "GAME_ALREADY_STARTED" });
  expect(await repo.getMembership(game.id, USERS[1]! as UserId)).toBeNull();
});

test("a public-ID admission rechecks visibility after a public-to-private race", async () => {
  const { app, repo, db } = await setup();
  const game = await createGame(app, USERS[0]!);
  const lock = new GameLock();
  const access = new GameAccess(repo, lock);
  const originalGetGame = repo.getGame.bind(repo);
  const resolved = Promise.withResolvers<void>();
  const continueResolve = Promise.withResolvers<void>();
  let firstGet = true;
  repo.getGame = async (gameId) => {
    const row = await originalGetGame(gameId);
    if (firstGet) {
      firstGet = false;
      resolved.resolve();
      await continueResolve.promise;
    }
    return row;
  };

  const admission = access.admit(
    { kind: "public-game", gameId: game.id },
    { userId: USERS[1]! as UserId, username: USERS[1]! },
    "player",
  );
  await resolved.promise;
  const visibilityChange = lock.run(game.id, async () => {
    await db.update(games).set({ visibility: "private" }).where(eq(games.id, game.id));
  });
  continueResolve.resolve();
  await visibilityChange;
  await expect(admission).rejects.toMatchObject({ code: "GAME_NOT_FOUND" });
  expect(await repo.getMembership(game.id, USERS[1]! as UserId)).toBeNull();
});

test("a public-ID preview rechecks visibility after resolution", async () => {
  const { app, repo, db } = await setup();
  const game = await createGame(app, USERS[0]!);
  const originalGetGame = repo.getGame.bind(repo);
  let firstGet = true;
  repo.getGame = async (gameId) => {
    const row = await originalGetGame(gameId);
    if (firstGet) {
      firstGet = false;
      await db.update(games).set({ visibility: "private" }).where(eq(games.id, gameId));
    }
    return row;
  };

  await expect(
    new GameAccess(repo).preview(
      { kind: "public-game", gameId: game.id },
      { userId: USERS[1]! as UserId },
    ),
  ).rejects.toMatchObject({ code: "GAME_NOT_FOUND" });
});

test("GameAccess maps a real stale membership fence to CONFLICT without retrying", async () => {
  const { app, repo, db } = await setup();
  const game = await createGame(app, USERS[0]!);
  const code = (await repo.getJoinCode(game.id))!;
  const access = new GameAccess(repo);
  const reference: GameEntryReference = { kind: "invitation", code };
  const originalGetGame = repo.getGame.bind(repo);
  let raced = false;
  repo.getGame = async (gameId) => {
    const row = await originalGetGame(gameId);
    if (!raced && row) {
      raced = true;
      await db
        .update(games)
        .set({ version: row.version + 1 })
        .where(eq(games.id, gameId));
    }
    return row;
  };

  await expect(
    access.admit(reference, { userId: USERS[1]! as UserId, username: USERS[1]! }, "player"),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await repo.getMembership(game.id, USERS[1]! as UserId)).toBeNull();
});

test("the real membership fence reports stale and rolls back failed mutations", async () => {
  const { app, repo } = await setup();
  const game = await createGame(app, USERS[0]!);
  const stale = await repo.commitMembership(game.id, game.version - 1, {
    kind: "insert",
    player: {
      gameId: game.id,
      userId: USERS[1]! as UserId,
      displayName: USERS[1]!,
      joinedAt: 2,
    },
  });
  expect(stale).toEqual({ ok: false, stale: true });
  expect(await repo.getMembership(game.id, USERS[1]! as UserId)).toBeNull();

  await expect(
    repo.commitMembership(game.id, game.version, {
      kind: "insert",
      player: {
        gameId: game.id,
        userId: USERS[0]! as UserId,
        displayName: "duplicate-owner",
        joinedAt: 3,
      },
    }),
  ).rejects.toThrow();
  expect((await repo.getGame(game.id))?.version).toBe(game.version);
  expect((await repo.getMembership(game.id, USERS[0]! as UserId))?.displayName).toBe(USERS[0]!);
  expect(await repo.getMembership(game.id, USERS[1]! as UserId)).toBeNull();
});

test("membership notifications happen after visible active commits only", async () => {
  const { app, repo, db } = await setup();
  const game = await createGame(app, USERS[0]!);
  const code = (await repo.getJoinCode(game.id))!;
  const ref: GameEntryReference = { kind: "invitation", code };
  const notifications: { version: number; access: string | null }[] = [];
  const access = new GameAccess(repo, new GameLock(), Date.now, async (gameId) => {
    const committedGame = await repo.getGame(gameId);
    const membership = await repo.getMembership(gameId, USERS[1]! as UserId);
    notifications.push({
      version: committedGame?.version ?? -1,
      access: membership?.membershipAccess ?? null,
    });
  });

  await access.preview(ref, { userId: USERS[1]! as UserId });
  expect(notifications).toHaveLength(0);
  await access.admit(ref, { userId: USERS[1]! as UserId, username: USERS[1]! }, "player");
  expect(notifications).toEqual([{ version: game.version + 1, access: "active" }]);
  await access.admit(ref, { userId: USERS[1]! as UserId, username: USERS[1]! }, "spectator");
  expect(notifications).toHaveLength(1);
  await access.leave(game.id, { userId: USERS[1]! as UserId });
  expect(notifications).toEqual([
    { version: game.version + 1, access: "active" },
    { version: game.version + 2, access: null },
  ]);
  await access.admit(ref, { userId: USERS[1]! as UserId, username: USERS[1]! }, "player");
  await access.kick(game.id, USERS[0]! as UserId, USERS[1]! as UserId);
  expect(notifications).toEqual([
    { version: game.version + 1, access: "active" },
    { version: game.version + 2, access: null },
    { version: game.version + 3, access: "active" },
    { version: game.version + 4, access: "denied" },
  ]);
  await db.update(games).set({ status: "running" }).where(eq(games.id, game.id));
  await expect(
    access.admit(ref, { userId: USERS[4]! as UserId, username: USERS[4]! }, "player"),
  ).rejects.toMatchObject({ code: "GAME_ALREADY_STARTED" });
  expect(notifications).toHaveLength(4);

  const replayGame = await createGame(app, USERS[2]!);
  const replayCode = (await repo.getJoinCode(replayGame.id))!;
  const replayRef: GameEntryReference = { kind: "invitation", code: replayCode };
  await repo.commitTransition(replayGame.id, replayGame.version, {
    gamePatch: { status: "finished" },
    playerPatches: [],
    events: [],
    ephemeral: [],
  });
  await access.admit(replayRef, { userId: USERS[3]! as UserId, username: USERS[3]! }, "replay");
  expect(notifications).toHaveLength(4);
  await expect(
    access.admit(
      { kind: "invitation", code: "not-a-code" },
      { userId: USERS[4]! as UserId, username: USERS[4]! },
      "player",
    ),
  ).rejects.toMatchObject({ code: "INVITATION_NOT_FOUND" });
  expect(notifications).toHaveLength(4);
});

test("concurrent admissions for one game serialize on its per-game lock", async () => {
  const { app, repo } = await setup();
  const game = await createGame(app, USERS[0]!);
  const code = (await repo.getJoinCode(game.id))!;
  const ref: GameEntryReference = { kind: "invitation", code };
  const lock = new GameLock();
  const access = new GameAccess(repo, lock);
  const original = repo.commitMembership.bind(repo);
  let inFlight = 0;
  let maximum = 0;
  repo.commitMembership = (async (...args: Parameters<typeof original>) => {
    inFlight += 1;
    maximum = Math.max(maximum, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const result = await original(...args);
    inFlight -= 1;
    return result;
  }) as typeof repo.commitMembership;

  await Promise.all([
    access.admit(ref, { userId: USERS[1]! as UserId, username: USERS[1]! }, "player"),
    access.admit(ref, { userId: USERS[2]! as UserId, username: USERS[2]! }, "player"),
  ]);
  expect(maximum).toBe(1);
  expect((await repo.getMembership(game.id, USERS[1]! as UserId))?.membershipAccess).toBe("active");
  expect((await repo.getMembership(game.id, USERS[2]! as UserId))?.membershipAccess).toBe("active");
});

test("malformed and unknown invitation codes are not found", async () => {
  const { app, repo } = await setup();
  const game = await createGame(app, USERS[0]!);
  const access = new GameAccess(repo);
  await expect(
    access.preview({ kind: "invitation", code: "not-a-code" }, { userId: USERS[1]! as UserId }),
  ).rejects.toMatchObject({ code: "INVITATION_NOT_FOUND" });
  await expect(
    access.admit(
      { kind: "invitation", code: "ZZZZZZZZZZ" },
      { userId: USERS[1]! as UserId, username: USERS[1]! },
      "player",
    ),
  ).rejects.toMatchObject({ code: "INVITATION_NOT_FOUND" });
  expect(await repo.getMembership(game.id, USERS[1]! as UserId)).toBeNull();
});

test("GameAccess preview and admission cover the complete status/mode matrix", async () => {
  const cases: {
    status: "lobby" | "scheduled" | "running" | "finished" | "cancelled";
    spectatingEnabled: boolean;
    canJoin: boolean;
    canSpectate: boolean;
    canReplay: boolean;
    allowed: GameEntryMode[];
  }[] = [
    {
      status: "lobby",
      spectatingEnabled: true,
      canJoin: true,
      canSpectate: true,
      canReplay: false,
      allowed: ["player", "spectator"],
    },
    {
      status: "scheduled",
      spectatingEnabled: true,
      canJoin: true,
      canSpectate: true,
      canReplay: false,
      allowed: ["player", "spectator"],
    },
    {
      status: "lobby",
      spectatingEnabled: false,
      canJoin: true,
      canSpectate: false,
      canReplay: false,
      allowed: ["player"],
    },
    {
      status: "scheduled",
      spectatingEnabled: false,
      canJoin: true,
      canSpectate: false,
      canReplay: false,
      allowed: ["player"],
    },
    {
      status: "running",
      spectatingEnabled: true,
      canJoin: false,
      canSpectate: true,
      canReplay: false,
      allowed: ["spectator"],
    },
    {
      status: "running",
      spectatingEnabled: false,
      canJoin: false,
      canSpectate: false,
      canReplay: false,
      allowed: [],
    },
    {
      status: "finished",
      spectatingEnabled: true,
      canJoin: false,
      canSpectate: false,
      canReplay: true,
      allowed: ["replay"],
    },
    {
      status: "finished",
      spectatingEnabled: false,
      canJoin: false,
      canSpectate: false,
      canReplay: false,
      allowed: [],
    },
    {
      status: "cancelled",
      spectatingEnabled: true,
      canJoin: false,
      canSpectate: false,
      canReplay: false,
      allowed: [],
    },
  ];
  const modes: GameEntryMode[] = ["player", "spectator", "replay"];
  for (const [index, entry] of cases.entries()) {
    const { app, repo, db } = await setup();
    const game = await createGame(app, `${USERS[0]}-matrix-${index}`, {
      spectatingEnabled: entry.spectatingEnabled,
    });
    await db.update(games).set({ status: entry.status }).where(eq(games.id, game.id));
    const code = (await repo.getJoinCode(game.id))!;
    const access = new GameAccess(repo);
    const reference: GameEntryReference = { kind: "invitation", code };
    await expect(
      access.preview(reference, { userId: `${USERS[1]}-preview-${index}` as UserId }),
    ).resolves.toMatchObject({
      status: entry.status,
      canJoin: entry.canJoin,
      canSpectate: entry.canSpectate,
      canReplay: entry.canReplay,
      membership: null,
    });
    for (const mode of modes) {
      const userId = `${USERS[1]}-${index}-${mode}` as UserId;
      const attempt = access.admit(reference, { userId, username: userId }, mode);
      if (entry.allowed.includes(mode)) {
        await expect(attempt).resolves.toMatchObject({
          gameId: game.id,
          destination: mode === "replay" ? "replay" : "game",
        });
      } else {
        await expect(attempt).rejects.toBeInstanceOf(Error);
      }
    }
  }
});

test("spectating-disabled games refuse live and replay admission", async () => {
  const { app, repo, db } = await setup();
  const game = await createGame(app, USERS[0]!, { spectatingEnabled: false });
  await db.update(games).set({ status: "running" }).where(eq(games.id, game.id));
  const code = (await repo.getJoinCode(game.id))!;
  const access = new GameAccess(repo);
  await expect(
    access.preview({ kind: "invitation", code }, { userId: USERS[1]! as UserId }),
  ).resolves.toMatchObject({ canSpectate: false, unavailableReason: "spectating_disabled" });
  await expect(
    access.admit(
      { kind: "invitation", code },
      { userId: USERS[1]! as UserId, username: USERS[1]! },
      "spectator",
    ),
  ).rejects.toMatchObject({ code: "SPECTATING_DISABLED" });
});

test("HTTP entry preview is read-only and admission returns a destination", async () => {
  const { app, repo } = await setup();
  const game = await createGame(app, USERS[0]!);
  const invitation = await as(app, USERS[0]!, `/api/games/${game.id}/invitation`);
  const code = ((await invitation.json()) as { code: string }).code;

  const preview = await as(app, USERS[1]!, `/api/game-entry?code=${code}`);
  expect(preview.status).toBe(200);
  const body = (await preview.json()) as Record<string, unknown>;
  expect(body).not.toHaveProperty("code");
  expect(body).not.toHaveProperty("gameId");
  expect(await repo.getMembership(game.id, USERS[1]! as UserId)).toBeNull();
  expect((await as(app, USERS[1]!, "/api/game-entry")).status).toBe(400);
  expect((await as(app, USERS[1]!, `/api/game-entry?code=${code}&gameId=${game.id}`)).status).toBe(
    400,
  );

  const admission = await as(app, USERS[1]!, "/api/game-entry", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reference: { kind: "invitation", code }, mode: "player" }),
  });
  expect(admission.status).toBe(200);
  expect(await admission.json()).toEqual({ gameId: game.id, destination: "game" });

  const resumed = await as(app, USERS[1]!, `/api/game-entry?code=${code}`);
  expect(resumed.status).toBe(200);
  expect(await resumed.json()).toMatchObject({ membership: "player", gameId: game.id });
  const resumedById = await as(app, USERS[1]!, `/api/game-entry?gameId=${game.id}`);
  expect(resumedById.status).toBe(200);
  expect(await resumedById.json()).toMatchObject({ membership: "player", gameId: game.id });

  const extraField = await as(app, USERS[2]!, "/api/game-entry", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      reference: { kind: "invitation", code },
      mode: "player",
      spectator: true,
    }),
  });
  expect(extraField.status).toBe(400);
  const invalidReference = await as(app, USERS[2]!, "/api/game-entry", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      reference: { kind: "invitation", code, gameId: game.id },
      mode: "player",
    }),
  });
  expect(invalidReference.status).toBe(400);
  const invalidMode = await as(app, USERS[2]!, "/api/game-entry", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reference: { kind: "invitation", code }, mode: "join" }),
  });
  expect(invalidMode.status).toBe(400);
});

test("a private public-ID preview does not reveal the game's existence", async () => {
  const { app } = await setup();
  const response = await as(app, USERS[0]!, "/api/games", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Private", visibility: "private" }),
  });
  const game = (await response.json()) as { gameId: string };
  expect((await as(app, USERS[0]!, `/api/games/${game.gameId}/invitation`)).status).toBe(200);
  const privateNonOwner = await as(app, USERS[1]!, `/api/games/${game.gameId}/invitation`);
  expect(privateNonOwner.status).toBe(404);
  expect(await privateNonOwner.json()).toEqual({ error: { code: "GAME_NOT_FOUND" } });
  const missing = await as(app, USERS[1]!, "/api/games/missing/invitation");
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({ error: { code: "GAME_NOT_FOUND" } });
  const preview = await as(app, USERS[1]!, `/api/game-entry?gameId=${game.gameId}`);
  expect(preview.status).toBe(404);
  expect(await preview.json()).toEqual({ error: { code: "GAME_NOT_FOUND" } });
});

test("browse and mine scopes are explicit and carry only minimal membership mode", async () => {
  const { app, repo, db } = await setup();
  const viewer = USERS[5]!;
  const publicGame = await createGame(app, USERS[0]!);
  const privateGame = await (async () => {
    const response = await as(app, USERS[1]!, "/api/games", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Private", visibility: "private" }),
    });
    return (await response.json()) as { gameId: string };
  })();
  const privateCode = (await repo.getJoinCode(privateGame.gameId as GameId))!;
  await as(app, viewer, "/api/game-entry", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      reference: { kind: "invitation", code: privateCode },
      mode: "spectator",
    }),
  });

  const replayGame = await createGame(app, USERS[2]!);
  await db.update(games).set({ status: "finished" }).where(eq(games.id, replayGame.id));
  const replayCode = (await repo.getJoinCode(replayGame.id))!;
  await as(app, viewer, "/api/game-entry", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      reference: { kind: "invitation", code: replayCode },
      mode: "replay",
    }),
  });

  const deniedGame = await createGame(app, USERS[3]!);
  const deniedCode = (await repo.getJoinCode(deniedGame.id))!;
  await as(app, viewer, "/api/game-entry", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      reference: { kind: "invitation", code: deniedCode },
      mode: "player",
    }),
  });
  await as(app, USERS[3]!, `/api/games/${deniedGame.id}/players/${viewer}`, { method: "DELETE" });
  expect(
    (await repo.getMembership(deniedGame.id as GameId, viewer as UserId))?.membershipAccess,
  ).toBe("denied");

  const cancelledGame = await createGame(app, USERS[4]!);
  const cancelledCode = (await repo.getJoinCode(cancelledGame.id))!;
  await as(app, viewer, "/api/game-entry", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      reference: { kind: "invitation", code: cancelledCode },
      mode: "player",
    }),
  });
  await db.update(games).set({ status: "cancelled" }).where(eq(games.id, cancelledGame.id));
  expect((await repo.getMembership(cancelledGame.id, viewer as UserId))?.membershipAccess).toBe(
    "active",
  );
  expect((await repo.getGame(cancelledGame.id))?.status).toBe("cancelled");

  const browse = await as(app, viewer, "/api/games?scope=browse");
  expect(browse.status).toBe(200);
  const browseBody = (await browse.json()) as { id: string }[];
  expect(browseBody.map((game) => game.id)).toContain(publicGame.id);
  expect(browseBody.map((game) => game.id)).not.toContain(privateGame.gameId);
  expect(browseBody.map((game) => game.id)).not.toContain(cancelledGame.id);
  expect(JSON.stringify(browseBody)).not.toContain("joinCode");

  const mine = await as(app, viewer, "/api/games?scope=mine");
  expect(mine.status).toBe(200);
  const mineBody = (await mine.json()) as { id: string; membership?: string }[];
  expect(mineBody.find((game) => game.id === privateGame.gameId)?.membership).toBe("spectator");
  expect(mineBody.find((game) => game.id === replayGame.id)?.membership).toBe("replay");
  expect(mineBody.map((game) => game.id)).not.toContain(deniedGame.id);
  expect(mineBody.map((game) => game.id)).not.toContain(cancelledGame.id);
  expect(JSON.stringify(mineBody)).not.toContain("joinCode");
});

test("entry routes enforce authentication, username and owner-only invitation retrieval", async () => {
  const { app } = await setup();
  const game = await createGame(app, USERS[0]!);
  expect((await app.request("/api/game-entry?code=bad")).status).toBe(401);
  const noUsername = await as(app, USERS[1]!, "/api/game-entry", {
    method: "POST",
    headers: { "content-type": "application/json", "x-username": "" },
    body: JSON.stringify({ reference: { kind: "public-game", gameId: game.id }, mode: "player" }),
  });
  expect(noUsername.status).toBe(403);
  expect((await as(app, USERS[1]!, `/api/games/${game.id}/invitation`)).status).toBe(403);
  const ownerInvitation = await as(app, USERS[0]!, `/api/games/${game.id}/invitation`);
  expect(ownerInvitation.status).toBe(200);
  expect(((await ownerInvitation.json()) as { code: string }).code).toMatch(
    /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{10}$/,
  );
  expect((await app.request("/api/games?scope=mine")).status).toBe(401);
});

test("leave permits later invitation admission while a kick leaves denial", async () => {
  const { app, repo } = await setup();
  const game = await createGame(app, USERS[0]!);
  const code = (await repo.getJoinCode(game.id))!;
  const ref: GameEntryReference = { kind: "invitation", code };
  const access = new GameAccess(repo);

  await access.admit(ref, { userId: USERS[1]! as UserId, username: USERS[1]! }, "player");
  await access.leave(game.id, { userId: USERS[1]! as UserId });
  expect(await repo.getMembership(game.id, USERS[1]! as UserId)).toBeNull();
  await expect(
    access.admit(ref, { userId: USERS[1]! as UserId, username: USERS[1]! }, "player"),
  ).resolves.toMatchObject({ destination: "game" });
  await access.kick(game.id, USERS[0]! as UserId, USERS[1]! as UserId);
  await expect(access.preview(ref, { userId: USERS[1]! as UserId })).rejects.toMatchObject({
    code: "INVITATION_ACCESS_DENIED",
  });
  await expect(
    access.admit(ref, { userId: USERS[1]! as UserId, username: USERS[1]! }, "player"),
  ).rejects.toMatchObject({ code: "INVITATION_ACCESS_DENIED" });
  await expect(
    access.kick(game.id, USERS[0]! as UserId, USERS[0]! as UserId),
  ).rejects.toMatchObject({
    code: "ACTION_NOT_AVAILABLE",
  });
});

test("existing memberships resume their mode and all admissions are idempotent", async () => {
  const { app, repo, db } = await setup();
  const game = await createGame(app, USERS[0]!);
  const code = (await repo.getJoinCode(game.id))!;
  const ref: GameEntryReference = { kind: "invitation", code };
  const access = new GameAccess(repo);
  const player = USERS[1]! as UserId;
  const spectator = USERS[2]! as UserId;

  await access.admit(ref, { userId: player, username: player }, "player");
  await expect(access.preview(ref, { userId: player })).resolves.toMatchObject({
    membership: "player",
    gameId: game.id,
  });
  await expect(
    access.admit(ref, { userId: player, username: player }, "spectator"),
  ).resolves.toEqual({
    gameId: game.id,
    destination: "game",
  });
  expect((await repo.getMembership(game.id, player))?.status).toBe("lobby");

  await access.admit(ref, { userId: spectator, username: spectator }, "spectator");
  await expect(access.preview(ref, { userId: spectator })).resolves.toMatchObject({
    membership: "spectator",
    gameId: game.id,
  });
  await expect(
    access.admit(ref, { userId: spectator, username: spectator }, "player"),
  ).resolves.toEqual({
    gameId: game.id,
    destination: "game",
  });
  expect((await repo.getMembership(game.id, spectator))?.status).toBe("spectator");

  const replayGame = await createGame(app, USERS[3]!);
  await db.update(games).set({ status: "finished" }).where(eq(games.id, replayGame.id));
  const replayCode = (await repo.getJoinCode(replayGame.id))!;
  const replayRef: GameEntryReference = { kind: "invitation", code: replayCode };
  const replayViewer = USERS[4]! as UserId;
  await access.admit(replayRef, { userId: replayViewer, username: replayViewer }, "replay");
  await expect(access.preview(replayRef, { userId: replayViewer })).resolves.toMatchObject({
    membership: "replay",
    gameId: replayGame.id,
    canReplay: true,
  });
  for (const mode of ["player", "spectator", "replay"] as const) {
    await expect(
      access.admit(replayRef, { userId: replayViewer, username: replayViewer }, mode),
    ).resolves.toEqual({ gameId: replayGame.id, destination: "replay" });
  }
  const replayMembership = await repo.getMembership(replayGame.id, replayViewer);
  expect(replayMembership?.membershipAccess).toBe("replay");
  expect(replayMembership?.status).toBe("spectator");
});

test("replay admission is separate from engine state", async () => {
  const { app, repo, db } = await setup();
  const game = await createGame(app, USERS[0]!);
  await db.update(games).set({ status: "finished" }).where(eq(games.id, game.id));
  const code = (await repo.getJoinCode(game.id))!;
  const access = new GameAccess(repo);
  await expect(
    access.admit(
      { kind: "invitation", code },
      { userId: USERS[1]! as UserId, username: USERS[1]! },
      "replay",
    ),
  ).resolves.toEqual({ gameId: game.id, destination: "replay" });
  const replayMembership = await repo.getMembership(game.id, USERS[1]! as UserId);
  expect(replayMembership?.membershipAccess).toBe("replay");
  expect(replayMembership?.status).toBe("spectator");
  expect(replayMembership?.role).toBeNull();
  expect(replayMembership?.faction).toBeNull();
  expect((await repo.loadGameState(game.id))?.players[USERS[1]! as UserId]).toBeUndefined();
});

test("kicking a bot deletes its seat so the configured bot can be seated again", async () => {
  const { app, repo } = await setup();
  const game = await createGame(app, USERS[0]!);
  const bot = "bot:one" as UserId;
  const controller = {
    type: "bot" as const,
    config: {
      botId: "mira",
      provider: "none",
      model: null,
      temperature: 0,
      maxOutputTokens: 1,
      timeoutMs: 1,
    },
  };
  const first = await repo.commitMembership(game.id, game.version, {
    kind: "insert",
    player: {
      gameId: game.id,
      userId: bot,
      displayName: "Mira",
      joinedAt: 2,
      controller,
    },
  });
  expect(first.ok).toBe(true);
  const access = new GameAccess(repo);
  await access.kick(game.id, USERS[0]! as UserId, bot);
  expect(await repo.getMembership(game.id, bot)).toBeNull();
  const current = (await repo.getGame(game.id))!;
  const second = await repo.commitMembership(game.id, current.version, {
    kind: "insert",
    player: {
      gameId: game.id,
      userId: "bot:two" as UserId,
      displayName: "Mira",
      joinedAt: 3,
      controller,
    },
  });
  expect(second.ok).toBe(true);
});
