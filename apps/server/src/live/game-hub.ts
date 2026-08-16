import { canViewEvent, projectSnapshot } from "@werewolf/game-engine";
import {
  type GameEvent,
  type GameId,
  type ServerFrame,
  SubscribeFrameSchema,
  type UserId,
} from "@werewolf/protocol";
import type { GameCoordinator } from "../game/coordinator.ts";

type Socket = { send(data: string): void };
type Subscriber = { socket: Socket; userId: UserId; subscribed: boolean; cursor: number };

export class GameHub {
  private readonly subscribers = new Map<GameId, Set<Subscriber>>();
  private readonly unsubscribe: () => boolean;

  constructor(private readonly coordinator: GameCoordinator) {
    this.unsubscribe = coordinator.onCommitted((gameId, events) => this.broadcast(gameId, events));
  }

  stop() {
    this.unsubscribe();
    this.subscribers.clear();
  }

  /** How many live subscribers a game has; used by tests to prove cleanup. */
  subscriberCount(gameId: GameId) {
    return this.subscribers.get(gameId)?.size ?? 0;
  }

  connect(gameId: GameId, userId: UserId, socket: Socket) {
    const subscriber: Subscriber = { socket, userId, subscribed: false, cursor: 0 };
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
    const set = this.subscribers.get(gameId);
    set?.delete(subscriber);
    if (set?.size === 0) this.subscribers.delete(gameId);
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
    const state = await this.coordinator.loadGameState(gameId);
    if (!state) return;
    const allEvents = (await this.coordinator.getVisibleEvents(gameId, 0)) as GameEvent[];
    const latest = (allEvents.at(-1)?.id ?? 0) as GameEvent["id"];
    if (parsed.data.cursor > latest) return this.send(subscriber, { type: "resync_required" });
    const events = allEvents.filter(
      (event) => event.id > parsed.data.cursor && canViewEvent(event, subscriber.userId, state),
    );
    subscriber.subscribed = true;
    subscriber.cursor = latest;
    this.send(subscriber, {
      type: "sync",
      snapshot: projectSnapshot(state, subscriber.userId, latest, Date.now()),
      events,
      cursor: latest,
    });
  }

  private async broadcast(gameId: GameId, events: unknown[]) {
    const subscribers = this.subscribers.get(gameId);
    if (!subscribers?.size) return;
    const state = await this.coordinator.loadGameState(gameId);
    if (!state) return;
    for (const subscriber of subscribers) {
      if (!subscriber.subscribed) continue;
      const committed = events as GameEvent[];
      const visible = committed.filter(
        (event) => event.id > subscriber.cursor && canViewEvent(event, subscriber.userId, state),
      );
      // The cursor is a log position, not a delivery receipt: advance past ALL
      // committed event ids, including ones this viewer cannot see. Guard the
      // empty case explicitly, since Math.max(...[]) is -Infinity.
      if (committed.length > 0)
        subscriber.cursor = Math.max(subscriber.cursor, ...committed.map((event) => event.id));
      // One sync frame per commit, even when nothing is visible: the fresh
      // snapshot is what keeps the client's phaseId from going stale.
      this.send(subscriber, {
        type: "sync",
        snapshot: projectSnapshot(state, subscriber.userId, subscriber.cursor, Date.now()),
        events: visible,
        cursor: subscriber.cursor as GameEvent["id"],
      });
    }
  }

  private send(subscriber: Subscriber, frame: ServerFrame) {
    try {
      subscriber.socket.send(JSON.stringify(frame));
    } catch {
      // The close callback normally removes this first; a race with close must
      // not make a committed transition fail.
    }
  }
}
