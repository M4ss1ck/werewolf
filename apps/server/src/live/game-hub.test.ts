// GameHub tests. The hub is driven directly through its connect seam with a
// fake socket that records frames; no real TCP connection is involved. The
// point is that per-viewer filtering and cursor handling are exercised.

import { expect, test } from "bun:test";
import type { GameId, ServerFrame, UserId } from "@werewolf/protocol";
import {
  as,
  createGame,
  jsonRequest,
  setup,
  startGameWithPlayers,
  USERS,
} from "../test/harness.ts";
import { GameHub } from "./game-hub.ts";

function fakeSocket() {
  const frames: ServerFrame[] = [];
  return {
    frames,
    send(data: string) {
      frames.push(JSON.parse(data) as ServerFrame);
    },
  };
}

async function subscribe(conn: { message(raw: string): Promise<void> }, cursor: number) {
  await conn.message(JSON.stringify({ type: "subscribe", cursor }));
}

test("a subscriber receives a sync frame with a snapshot and their visible events", async () => {
  const { app, coordinator, repo } = await setup();
  const gameId = await startGameWithPlayers(app, USERS[0]!, [
    USERS[1]!,
    USERS[2]!,
    USERS[3]!,
    USERS[4]!,
  ]);
  const hub = new GameHub(coordinator);
  const socket = fakeSocket();
  const connection = hub.connect(gameId, USERS[0]! as UserId, socket);
  await subscribe(connection, 0);

  const latest = (await repo.getVisibleEvents(gameId)).at(-1)!.id;
  const sync = socket.frames.find((frame) => frame.type === "sync");
  expect(sync).toBeDefined();
  if (sync?.type !== "sync") return;
  expect(sync.snapshot.game.id).toBe(gameId);
  expect(sync.snapshot.game.status).toBe("running");
  expect(sync.snapshot.me?.userId as string).toBe(USERS[0]!);
  expect(sync.cursor).toBe(latest);
  expect(sync.snapshot.cursor).toBe(latest);
  for (const event of sync.events) expect(event.id).toBeGreaterThan(0);
  const kinds = sync.events.map((event) => event.kind);
  expect(kinds).toContain("game.started");
  expect(kinds).toContain("phase.started");
  expect(kinds).toContain("role.assigned");
  hub.stop();
});

test("a villager subscriber never receives a wolf chat event, while a wolf does", async () => {
  const { app, coordinator, repo } = await setup();
  const gameId = await startGameWithPlayers(app, USERS[0]!, [
    USERS[1]!,
    USERS[2]!,
    USERS[3]!,
    USERS[4]!,
  ]);
  const state = (await repo.loadGameState(gameId))!;
  const wolf = Object.values(state.players).find((player) => player.faction === "wolves")!;
  const villager = Object.values(state.players).find((player) => player.faction === "village")!;

  const hub = new GameHub(coordinator);
  const wolfSocket = fakeSocket();
  const villagerSocket = fakeSocket();
  await subscribe(hub.connect(gameId, wolf.id, wolfSocket), 0);
  await subscribe(hub.connect(gameId, villager.id, villagerSocket), 0);

  await coordinator.executeCommand(gameId, wolf.id, {
    commandId: "wolf-chat-1",
    phaseId: state.phase!.id,
    type: "chat.send",
    payload: { channel: "wolves", text: "kill the seer" },
  });

  // The wolf learns of the message in a pushed sync frame — the hub's only
  // frame kind after a commit — not a dedicated event frame.
  const wolfChat = wolfSocket.frames
    .filter((frame) => frame.type === "sync")
    .flatMap((frame) => frame.events)
    .find((event) => event.kind === "chat.message");
  expect(wolfChat).toBeDefined();
  if (!wolfChat) return;
  expect(wolfChat.payload).toMatchObject({ channel: "wolves", text: "kill the seer" });

  // The villager may receive sync frames (every commit pushes one), but none
  // of their events may carry the wolves-channel message, and the text never
  // crosses the wire for them.
  const villagerChat = villagerSocket.frames
    .filter((frame) => frame.type === "sync")
    .flatMap((frame) => frame.events)
    .find((event) => event.kind === "chat.message");
  expect(villagerChat).toBeUndefined();
  expect(JSON.stringify(villagerSocket.frames)).not.toContain("kill the seer");
  hub.stop();
});

test("a spectator receives public events only", async () => {
  const { app, coordinator, repo } = await setup();
  const game = await createGame(app, USERS[0]!);
  for (const userId of [USERS[1]!, USERS[2]!, USERS[3]!, USERS[4]!]) {
    const response = await as(app, userId, `/api/games/${game.id}/join`, jsonRequest("POST", {}));
    expect(response.status).toBe(200);
  }
  const spectator = USERS[5]!;
  const spectated = await as(
    app,
    spectator,
    `/api/games/${game.id}/spectate`,
    jsonRequest("POST", {}),
  );
  expect(spectated.status).toBe(200);
  const start = await as(app, USERS[0]!, `/api/games/${game.id}/start`, jsonRequest("POST", {}));
  expect(start.status).toBe(200);

  const hub = new GameHub(coordinator);
  const socket = fakeSocket();
  await subscribe(hub.connect(game.id as GameId, spectator as UserId, socket), 0);

  const sync = socket.frames.find((frame) => frame.type === "sync");
  expect(sync?.type).toBe("sync");
  if (sync?.type !== "sync") return;
  expect(sync.events.length).toBeGreaterThan(0);
  for (const event of sync.events) expect(event.scope).toBe("public");

  // A public chat is pushed; a wolf chat is not.
  const state = (await repo.loadGameState(game.id as GameId))!;
  const wolf = Object.values(state.players).find((player) => player.faction === "wolves")!;
  await coordinator.executeCommand(game.id as GameId, USERS[0]! as UserId, {
    commandId: "spectator-pub-1",
    phaseId: state.phase!.id,
    type: "chat.send",
    payload: { channel: "public", text: "hello all" },
  });
  await coordinator.executeCommand(game.id as GameId, wolf.id, {
    commandId: "spectator-wolf-1",
    phaseId: state.phase!.id,
    type: "chat.send",
    payload: { channel: "wolves", text: "secret plan" },
  });
  // Every pushed frame is a sync frame, and every event in them is public.
  const pushed = socket.frames.filter((frame) => frame.type === "sync");
  expect(pushed.length).toBeGreaterThan(1);
  for (const frame of pushed) {
    for (const event of frame.events) expect(event.scope).toBe("public");
  }
  expect(JSON.stringify(socket.frames)).not.toContain("secret plan");
  hub.stop();
});

test("a subscriber receives a fresh sync frame when the phase changes", async () => {
  const { app, coordinator, repo, clock } = await setup();
  const gameId = await startGameWithPlayers(app, USERS[0]!, [
    USERS[1]!,
    USERS[2]!,
    USERS[3]!,
    USERS[4]!,
  ]);
  const before = (await repo.loadGameState(gameId))!;

  const hub = new GameHub(coordinator);
  const socket = fakeSocket();
  await subscribe(hub.connect(gameId, USERS[0]! as UserId, socket), 0);

  // Drive the phase change the way the scheduler does (see scheduler.test.ts):
  // let the discussion deadline pass, then resolve the expired phase.
  clock.now += 3_600_000;
  await coordinator.resolvePhase(gameId);

  const after = (await repo.loadGameState(gameId))!;
  expect(after.phase!.id as number).toBeGreaterThan(before.phase!.id as number);

  const syncs = socket.frames.filter((frame) => frame.type === "sync");
  const latest = syncs.at(-1);
  expect(latest?.type).toBe("sync");
  if (latest?.type !== "sync") return;
  expect(latest.snapshot.game.phase?.id).toBe(after.phase!.id);
  const kinds = latest.events.map((event) => event.kind);
  expect(kinds).toContain("phase.started");
  hub.stop();
});

test("an unusable cursor produces resync_required", async () => {
  const { app, coordinator, repo } = await setup();
  const gameId = await startGameWithPlayers(app, USERS[0]!, [
    USERS[1]!,
    USERS[2]!,
    USERS[3]!,
    USERS[4]!,
  ]);
  const latest = (await repo.getVisibleEvents(gameId)).at(-1)!.id;

  const hub = new GameHub(coordinator);
  const socket = fakeSocket();
  await subscribe(hub.connect(gameId, USERS[0]! as UserId, socket), latest + 1_000);

  expect(socket.frames.find((frame) => frame.type === "resync_required")).toBeDefined();
  expect(socket.frames.some((frame) => frame.type === "sync")).toBe(false);
  hub.stop();
});

test("disconnecting removes the subscription and no further sends are attempted", async () => {
  const { app, coordinator, repo } = await setup();
  const gameId = await startGameWithPlayers(app, USERS[0]!, [
    USERS[1]!,
    USERS[2]!,
    USERS[3]!,
    USERS[4]!,
  ]);
  const state = (await repo.loadGameState(gameId))!;

  const hub = new GameHub(coordinator);
  const socket = fakeSocket();
  const connection = hub.connect(gameId, USERS[0]! as UserId, socket);
  await subscribe(connection, 0);
  expect(hub.subscriberCount(gameId)).toBe(1);

  connection.close();
  expect(hub.subscriberCount(gameId)).toBe(0);

  const framesAfterClose = socket.frames.length;
  await coordinator.executeCommand(gameId, USERS[0]! as UserId, {
    commandId: "post-close-1",
    phaseId: state.phase!.id,
    type: "chat.send",
    payload: { channel: "public", text: "after close" },
  });
  expect(socket.frames.length).toBe(framesAfterClose);
  expect(JSON.stringify(socket.frames)).not.toContain("after close");
  hub.stop();
});
