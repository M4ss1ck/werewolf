// GameHub tests. The hub is driven directly through its connect seam with a
// fake socket that records frames; no real TCP connection is involved. The
// point is that per-viewer filtering and cursor handling are exercised.

import { expect, test } from "bun:test";
import { games } from "@werewolf/db";
import { canViewEvent } from "@werewolf/game-engine";
import type { EventId, GameEvent, GameId, ServerFrame, UserId } from "@werewolf/protocol";
import { eq } from "drizzle-orm";
import type { GameCoordinator } from "../game/coordinator.ts";
import {
  as,
  createGame,
  entry,
  jsonRequest,
  setup,
  startGameWithPlayers,
  startGameWithSeed,
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

function publicEvent(id: number): GameEvent {
  return {
    id: id as EventId,
    kind: "phase.started",
    scope: "public",
    createdAt: id,
    payload: { phaseId: id, type: "discussion", startedAt: id, endsAt: id + 1 },
  } as GameEvent;
}

function chatEvent(
  id: number,
  channel: "grave" | "wolves",
  actorUserId: UserId,
  text: string,
): GameEvent {
  return {
    id: id as EventId,
    kind: "chat.message",
    scope: "faction",
    scopeId: channel,
    actorUserId,
    createdAt: id,
    payload: { channel, text, mentions: [] },
  } as GameEvent;
}

function fakeCoordinator(
  gameId: GameId,
  state: Awaited<ReturnType<GameCoordinator["loadGameState"]>>,
  events: GameEvent[],
) {
  let committed: ((id: GameId, events: unknown[]) => void | Promise<void>) | undefined;
  const tracker = { fullLogCalls: 0 };
  const coordinator = {
    onCommitted(callback: (id: GameId, events: unknown[]) => void | Promise<void>) {
      committed = callback;
      return () => {
        committed = undefined;
        return true;
      };
    },
    loadGameState: async () => state,
    getVisibleEvents: async (_id: GameId, afterId = 0) => {
      if (afterId === 0) tracker.fullLogCalls += 1;
      return events.filter((event) => event.id > afterId);
    },
  } as unknown as GameCoordinator;
  return {
    coordinator,
    tracker,
    async commit(nextEvents: GameEvent[]) {
      events.push(...nextEvents);
      await committed?.(gameId, nextEvents);
    },
  };
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

test("cursor zero sync contains every event visible under the current projection", async () => {
  const { app, db, repo } = await setup();
  const gameId = await startGameWithSeed(
    app,
    db,
    USERS[0]!,
    [USERS[1]!, USERS[2]!, USERS[3]!, USERS[4]!],
    "find-1",
  );
  const state = (await repo.loadGameState(gameId))!;
  const events = (await repo.getVisibleEvents(gameId, 0)) as GameEvent[];
  const fake = fakeCoordinator(gameId, state, events);
  const hub = new GameHub(fake.coordinator);
  const socket = fakeSocket();
  await subscribe(hub.connect(gameId, USERS[0]! as UserId, socket), 0);

  const sync = socket.frames.find((frame) => frame.type === "sync");
  expect(sync?.type).toBe("sync");
  if (sync?.type !== "sync") return;
  expect(sync.events.map((event) => event.id)).toEqual(
    events
      .filter((event) => canViewEvent(event, USERS[0]! as UserId, state))
      .map((event) => event.id),
  );
  hub.stop();
});

test("first grave entitlement sync backfills prior grave history", async () => {
  const { app, db, repo } = await setup();
  const gameId = await startGameWithSeed(
    app,
    db,
    USERS[0]!,
    [USERS[1]!, USERS[2]!, USERS[3]!, USERS[4]!],
    "find-1",
  );
  const viewer = USERS[0]! as UserId;
  const state = (await repo.loadGameState(gameId))!;
  const events = [publicEvent(1), chatEvent(5, "grave", USERS[1]! as UserId, "before death")];
  const fake = fakeCoordinator(gameId, state, events);
  const hub = new GameHub(fake.coordinator);
  const socket = fakeSocket();
  await subscribe(hub.connect(gameId, viewer, socket), 0);
  fake.tracker.fullLogCalls = 0;

  state.players[viewer]!.status = "dead";
  await fake.commit([publicEvent(6)]);

  const sync = socket.frames.at(-1);
  expect(sync?.type).toBe("sync");
  if (sync?.type !== "sync") return;
  expect(sync.snapshot.availableChannels).toContain("grave");
  expect(sync.events.map((event) => Number(event.id))).toEqual([1, 5, 6]);
  expect(sync.events.find((event) => event.id === 5)?.payload).toMatchObject({
    channel: "grave",
    text: "before death",
  });
  expect(fake.tracker.fullLogCalls).toBe(1);
  hub.stop();
});

test("new wolf entitlement backfills only events at and after the conversion marker", async () => {
  const { app, db, repo } = await setup();
  const gameId = await startGameWithSeed(
    app,
    db,
    USERS[0]!,
    [USERS[1]!, USERS[2]!, USERS[3]!, USERS[4]!],
    "find-1",
  );
  const viewer = USERS[0]! as UserId;
  const state = (await repo.loadGameState(gameId))!;
  const events = [
    publicEvent(1),
    chatEvent(5, "wolves", USERS[1]! as UserId, "before conversion"),
    chatEvent(10, "wolves", USERS[1]! as UserId, "conversion boundary"),
    chatEvent(11, "wolves", USERS[1]! as UserId, "after conversion"),
  ];
  const fake = fakeCoordinator(gameId, state, events);
  const hub = new GameHub(fake.coordinator);
  const socket = fakeSocket();
  await subscribe(hub.connect(gameId, viewer, socket), 0);
  fake.tracker.fullLogCalls = 0;

  const player = state.players[viewer]!;
  player.role = "werewolf";
  player.faction = "wolves";
  player.originalRole = "cursed";
  player.channelSince = { wolves: 10 as EventId };
  await fake.commit([publicEvent(12)]);

  const sync = socket.frames.at(-1);
  expect(sync?.type).toBe("sync");
  if (sync?.type !== "sync") return;
  expect(sync.snapshot.availableChannels).toContain("wolves");
  expect(
    sync.events.filter((event) => event.scopeId === "wolves").map((event) => Number(event.id)),
  ).toEqual([10, 11]);
  expect(sync.events.some((event) => event.id === 5)).toBe(false);
  expect(fake.tracker.fullLogCalls).toBe(1);
  hub.stop();
});

test("losing an entitlement removes the channel without backfilling its history", async () => {
  const { app, db, repo } = await setup();
  const gameId = await startGameWithSeed(
    app,
    db,
    USERS[0]!,
    [USERS[1]!, USERS[2]!, USERS[3]!, USERS[4]!],
    "find-1",
  );
  const viewer = USERS[0]! as UserId;
  const state = (await repo.loadGameState(gameId))!;
  const player = state.players[viewer]!;
  player.role = "werewolf";
  player.faction = "wolves";
  player.originalRole = "werewolf";
  delete player.channelSince;
  const events = [
    publicEvent(1),
    chatEvent(2, "wolves", USERS[1]! as UserId, "secret history"),
    publicEvent(3),
  ];
  const fake = fakeCoordinator(gameId, state, events);
  const hub = new GameHub(fake.coordinator);
  const socket = fakeSocket();
  await subscribe(hub.connect(gameId, viewer, socket), 0);
  fake.tracker.fullLogCalls = 0;

  player.role = "villager";
  player.faction = "village";
  player.originalRole = "villager";
  await fake.commit([publicEvent(4)]);

  const sync = socket.frames.at(-1);
  expect(sync?.type).toBe("sync");
  if (sync?.type !== "sync") return;
  expect(sync.snapshot.availableChannels).not.toContain("wolves");
  expect(sync.events.map((event) => Number(event.id))).toEqual([4]);
  expect(fake.tracker.fullLogCalls).toBe(0);
  hub.stop();
});

test("ordinary commits and reconnects deliver only missed visible events", async () => {
  const { app, db, repo } = await setup();
  const gameId = await startGameWithSeed(
    app,
    db,
    USERS[0]!,
    [USERS[1]!, USERS[2]!, USERS[3]!, USERS[4]!],
    "find-1",
  );
  const viewer = USERS[0]! as UserId;
  const state = (await repo.loadGameState(gameId))!;
  const events = [publicEvent(1), publicEvent(2)];
  const fake = fakeCoordinator(gameId, state, events);
  const hub = new GameHub(fake.coordinator);
  const firstSocket = fakeSocket();
  const first = hub.connect(gameId, viewer, firstSocket);
  await subscribe(first, 0);
  fake.tracker.fullLogCalls = 0;

  await fake.commit([publicEvent(3)]);
  const ordinary = firstSocket.frames.at(-1);
  expect(ordinary?.type).toBe("sync");
  if (ordinary?.type !== "sync") return;
  expect(ordinary.events.map((event) => Number(event.id))).toEqual([3]);
  expect(fake.tracker.fullLogCalls).toBe(0);

  first.close();
  const reconnectSocket = fakeSocket();
  await subscribe(hub.connect(gameId, viewer, reconnectSocket), 1);
  const reconnect = reconnectSocket.frames.at(-1);
  expect(reconnect?.type).toBe("sync");
  if (reconnect?.type !== "sync") return;
  expect(reconnect.events.map((event) => Number(event.id))).toEqual([2, 3]);
  expect(reconnect.events.map((event) => Number(event.id))).not.toContain(1);
  hub.stop();
});

test("one full-log query is reused when multiple subscribers gain a channel", async () => {
  const { app, db, repo } = await setup();
  const gameId = await startGameWithSeed(
    app,
    db,
    USERS[0]!,
    [USERS[1]!, USERS[2]!, USERS[3]!, USERS[4]!],
    "find-1",
  );
  const firstViewer = USERS[0]! as UserId;
  const secondViewer = USERS[1]! as UserId;
  const state = (await repo.loadGameState(gameId))!;
  const events = [
    publicEvent(1),
    publicEvent(2),
    chatEvent(5, "grave", USERS[2]! as UserId, "old grave"),
  ];
  const fake = fakeCoordinator(gameId, state, events);
  const hub = new GameHub(fake.coordinator);
  const firstSocket = fakeSocket();
  const secondSocket = fakeSocket();
  await subscribe(hub.connect(gameId, firstViewer, firstSocket), 0);
  await subscribe(hub.connect(gameId, secondViewer, secondSocket), 0);
  fake.tracker.fullLogCalls = 0;

  state.players[firstViewer]!.status = "dead";
  state.players[secondViewer]!.status = "dead";
  await fake.commit([publicEvent(6)]);

  expect(fake.tracker.fullLogCalls).toBe(1);
  for (const socket of [firstSocket, secondSocket]) {
    const sync = socket.frames.at(-1);
    expect(sync?.type).toBe("sync");
    if (sync?.type !== "sync") continue;
    expect(sync.events.map((event) => Number(event.id))).toEqual([1, 2, 5, 6]);
    expect(sync.events.find((event) => event.id === 5)?.payload).toMatchObject({
      channel: "grave",
    });
  }
  hub.stop();
});

test("a villager subscriber never receives a wolf chat event, while a wolf does", async () => {
  const { app, coordinator, repo, db } = await setup();
  const gameId = await startGameWithSeed(
    app,
    db,
    USERS[0]!,
    [USERS[1]!, USERS[2]!, USERS[3]!, USERS[4]!],
    "find-1",
  );
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
    payload: { channel: "wolves", text: "kill the seer", mentions: [] },
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
  const { app, coordinator, repo, db } = await setup();
  const game = await createGame(app, USERS[0]!);
  for (const userId of [USERS[1]!, USERS[2]!, USERS[3]!, USERS[4]!]) {
    const response = await entry(app, userId, game.id);
    expect(response.status).toBe(200);
  }
  const spectator = USERS[5]!;
  const spectated = await entry(app, spectator, game.id, "spectator");
  expect(spectated.status).toBe(200);
  // Pin the seed before start so the composition is deterministic.
  await db.update(games).set({ rngSeed: "find-1" }).where(eq(games.id, game.id));
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
    payload: { channel: "public", text: "hello all", mentions: [] },
  });
  await coordinator.executeCommand(game.id as GameId, wolf.id, {
    commandId: "spectator-wolf-1",
    phaseId: state.phase!.id,
    type: "chat.send",
    payload: { channel: "wolves", text: "secret plan", mentions: [] },
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

test("a lobby subscriber receives a fresh snapshot when the roster changes", async () => {
  const { app, coordinator } = await setup();
  const game = await createGame(app, USERS[0]!);
  const hub = new GameHub(coordinator);
  const socket = fakeSocket();
  await subscribe(hub.connect(game.id, USERS[0]! as UserId, socket), 0);

  const initial = socket.frames.filter((frame) => frame.type === "sync");
  expect(initial).toHaveLength(1);
  if (initial[0]?.type !== "sync") return;

  await coordinator.joinGame(game.id, USERS[1]! as UserId, USERS[1]!);
  const afterJoin = socket.frames.filter((frame) => frame.type === "sync");
  const joinSync = afterJoin.at(-1);
  expect(joinSync?.type).toBe("sync");
  if (joinSync?.type !== "sync") return;
  const joinedIds = joinSync.snapshot.players.map((player) => player.userId);
  expect(joinedIds).toContain(USERS[0]! as UserId);
  expect(joinedIds).toContain(USERS[1]! as UserId);

  await coordinator.kickLobbyPlayer(game.id, USERS[0]! as UserId, USERS[1]! as UserId);
  const afterKick = socket.frames.filter((frame) => frame.type === "sync");
  const kickSync = afterKick.at(-1);
  expect(kickSync?.type).toBe("sync");
  if (kickSync?.type !== "sync") return;
  const kickedIds = kickSync.snapshot.players.map((player) => player.userId);
  expect(kickedIds).toContain(USERS[0]! as UserId);
  expect(kickedIds).not.toContain(USERS[1]! as UserId);
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
    payload: { channel: "public", text: "after close", mentions: [] },
  });
  expect(socket.frames.length).toBe(framesAfterClose);
  expect(JSON.stringify(socket.frames)).not.toContain("after close");
  hub.stop();
});
