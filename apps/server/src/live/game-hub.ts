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
    this.sendProgress(subscriber, state);
  }

  private async broadcast(gameId: GameId, events: unknown[]) {
    const subscribers = this.subscribers.get(gameId);
    if (!subscribers?.size) return;
    const state = await this.coordinator.loadGameState(gameId);
    if (!state) return;
    for (const subscriber of subscribers) {
      if (!subscriber.subscribed) continue;
      for (const event of events as GameEvent[]) {
        if (event.id > subscriber.cursor && canViewEvent(event, subscriber.userId, state))
          this.send(subscriber, { type: "event", event });
      }
      subscriber.cursor = Math.max(
        subscriber.cursor,
        ...(events as GameEvent[]).map((event) => event.id),
      );
      this.sendProgress(subscriber, state);
    }
  }

  private sendProgress(subscriber: Subscriber, state: Parameters<typeof projectSnapshot>[0]) {
    const snapshot = projectSnapshot(state, subscriber.userId, subscriber.cursor, Date.now());
    this.send(subscriber, {
      type: "ephemeral",
      kind: "phase.progress",
      payload: snapshot.progress ?? { acted: 0, eligible: 0 },
    });
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
