import { canViewEvent, projectSnapshot } from "@werewolf/game-engine";
import {
  type ChatChannel,
  type GameEvent,
  type GameId,
  type ServerFrame,
  SubscribeFrameSchema,
  type UserId,
} from "@werewolf/protocol";
import type { GameCoordinator } from "../game/coordinator.ts";

type Socket = {
  send(data: string): void;
  close?: (code?: number, reason?: string) => void;
};
type Subscriber = {
  socket: Socket;
  userId: UserId;
  active: boolean;
  subscribing: boolean;
  subscribed: boolean;
  cursor: number;
  availableChannels: Set<ChatChannel>;
};

export class GameHub {
  private readonly subscribers = new Map<GameId, Set<Subscriber>>();
  private readonly unsubscribe: () => boolean;

  constructor(private readonly coordinator: GameCoordinator) {
    this.unsubscribe = coordinator.onCommitted((gameId, events) => this.broadcast(gameId, events));
  }

  stop() {
    this.unsubscribe();
    for (const subscribers of this.subscribers.values())
      for (const subscriber of subscribers) subscriber.active = false;
    this.subscribers.clear();
  }

  /** How many live subscribers a game has; used by tests to prove cleanup. */
  subscriberCount(gameId: GameId) {
    return this.subscribers.get(gameId)?.size ?? 0;
  }

  connect(gameId: GameId, userId: UserId, socket: Socket) {
    const subscriber: Subscriber = {
      socket,
      userId,
      active: true,
      subscribing: false,
      subscribed: false,
      cursor: 0,
      availableChannels: new Set(),
    };
    let gameSubscribers = this.subscribers.get(gameId);
    if (!gameSubscribers) {
      gameSubscribers = new Set();
      this.subscribers.set(gameId, gameSubscribers);
    }
    gameSubscribers.add(subscriber);
    return {
      // Resolves once the sync frame has been sent, so tests can await the
      // round trip; the HTTP layer fires this without awaiting.
      message: (raw: string) => this.subscribe(gameId, subscriber, raw),
      close: () => this.disconnect(gameId, subscriber),
    };
  }

  private disconnect(gameId: GameId, subscriber: Subscriber) {
    subscriber.active = false;
    const set = this.subscribers.get(gameId);
    set?.delete(subscriber);
    if (set?.size === 0) this.subscribers.delete(gameId);
  }

  private revoke(gameId: GameId, subscriber: Subscriber, code = "GAME_NOT_FOUND") {
    if (!subscriber.active) return;
    subscriber.active = false;
    subscriber.socket.close?.(1008, JSON.stringify({ error: { code } }));
    this.disconnect(gameId, subscriber);
  }

  private async subscribe(gameId: GameId, subscriber: Subscriber, raw: string) {
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    const parsed = SubscribeFrameSchema.safeParse(frame);
    if (!parsed.success) return;
    if (!subscriber.active || subscriber.subscribed || subscriber.subscribing) return;
    subscriber.subscribing = true;
    try {
      await this.coordinator.withGameLock(gameId, async () => {
        if (!subscriber.active) return;
        try {
          await this.coordinator.authorizeGameAccess(gameId, subscriber.userId, "live");
        } catch {
          this.revoke(gameId, subscriber);
          return;
        }
        const state = await this.coordinator.loadGameStateForViewer(
          gameId,
          subscriber.userId,
          "live",
        );
        if (!subscriber.active || !state || state.players[subscriber.userId] === undefined) {
          this.revoke(gameId, subscriber);
          return;
        }
        const allEvents = (await this.coordinator.getVisibleEventsForViewer(
          gameId,
          subscriber.userId,
          "live",
          0,
        )) as GameEvent[];
        if (!subscriber.active) return;
        try {
          await this.coordinator.authorizeGameAccess(gameId, subscriber.userId, "live");
        } catch {
          this.revoke(gameId, subscriber);
          return;
        }
        if (!subscriber.active || state.players[subscriber.userId] === undefined) {
          this.revoke(gameId, subscriber);
          return;
        }
        const latest = (allEvents.at(-1)?.id ?? 0) as GameEvent["id"];
        if (parsed.data.cursor > latest) return this.send(subscriber, { type: "resync_required" });
        const events = allEvents.filter(
          (event) => event.id > parsed.data.cursor && canViewEvent(event, subscriber.userId, state),
        );
        const snapshot = projectSnapshot(state, subscriber.userId, latest, Date.now());
        subscriber.subscribed = true;
        subscriber.cursor = latest;
        subscriber.availableChannels = new Set(snapshot.availableChannels);
        this.send(subscriber, {
          type: "sync",
          snapshot,
          events,
          cursor: latest,
        });
      });
    } finally {
      subscriber.subscribing = false;
    }
  }

  private async broadcast(gameId: GameId, events: unknown[]) {
    const subscribers = this.subscribers.get(gameId);
    if (!subscribers?.size) return;
    const state = await this.coordinator.loadGameStateForHub(gameId);
    if (!state) {
      for (const subscriber of subscribers) this.revoke(gameId, subscriber);
      return;
    }
    const committed = events as GameEvent[];
    const prepared: {
      subscriber: Subscriber;
      snapshot: ReturnType<typeof projectSnapshot>;
      visible: GameEvent[];
      cursor: GameEvent["id"];
      gainsChannel: boolean;
    }[] = [];
    let needsFullLog = false;
    for (const subscriber of subscribers) {
      if (!subscriber.active || !subscriber.subscribed) continue;
      if (state.players[subscriber.userId] === undefined) {
        this.revoke(gameId, subscriber);
        continue;
      }
      const cursor = committed.length
        ? Math.max(subscriber.cursor, ...committed.map((event) => event.id))
        : subscriber.cursor;
      const snapshot = projectSnapshot(state, subscriber.userId, cursor, Date.now());
      const availableChannels = new Set(snapshot.availableChannels);
      const gainsChannel = [...availableChannels].some(
        (channel) => !subscriber.availableChannels.has(channel),
      );
      if (gainsChannel) needsFullLog = true;
      prepared.push({
        subscriber,
        snapshot,
        visible: [],
        cursor: cursor as GameEvent["id"],
        gainsChannel,
      });
    }
    const fullLog = needsFullLog
      ? ((await this.coordinator.getVisibleEventsForHub(gameId, 0)) as GameEvent[])
      : undefined;
    for (const frame of prepared) {
      const { subscriber } = frame;
      if (!subscriber.active) continue;
      frame.visible = (frame.gainsChannel ? fullLog! : committed).filter(
        (event) =>
          (frame.gainsChannel || event.id > subscriber.cursor) &&
          canViewEvent(event, subscriber.userId, state),
      );
      // The cursor is a log position, not a delivery receipt: advance past ALL
      // committed event ids, including ones this viewer cannot see. Guard the
      // empty case explicitly, since Math.max(...[]) is -Infinity.
      subscriber.cursor = frame.cursor;
      subscriber.availableChannels = new Set(frame.snapshot.availableChannels);
      this.send(subscriber, {
        type: "sync",
        snapshot: frame.snapshot,
        events: frame.visible,
        cursor: subscriber.cursor as GameEvent["id"],
      });
    }
  }

  private send(subscriber: Subscriber, frame: ServerFrame) {
    if (!subscriber.active) return;
    try {
      subscriber.socket.send(JSON.stringify(frame));
    } catch {
      // The close callback normally removes this first; a race with close must
      // not make a committed transition fail.
    }
  }
}
