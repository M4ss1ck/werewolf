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

  const wolfEventFrame = wolfSocket.frames.find(
    (frame) => frame.type === "event" && frame.event.kind === "chat.message",
  );
  expect(wolfEventFrame).toBeDefined();
  if (wolfEventFrame?.type === "event") {
    expect(wolfEventFrame.event.payload).toMatchObject({
      channel: "wolves",
      text: "kill the seer",
    });
  }

  // The villager received nothing at all: no event frame exists to discard,
  // and the message text never crossed the wire for them.
  expect(villagerSocket.frames.filter((frame) => frame.type === "event")).toHaveLength(0);
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
  const pushed = socket.frames.filter((frame) => frame.type === "event");
  expect(pushed.length).toBeGreaterThan(0);
  for (const frame of pushed) expect(frame.type === "event" && frame.event.scope).toBe("public");
  expect(JSON.stringify(socket.frames)).not.toContain("secret plan");
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
