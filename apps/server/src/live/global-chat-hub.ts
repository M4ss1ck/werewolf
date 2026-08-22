import type { GlobalChatRepository } from "@werewolf/db";
import {
  type ChatMessage,
  type ChatServerFrame,
  ChatSubscribeFrameSchema,
  type UserId,
} from "@werewolf/protocol";

type Socket = { send(data: string): void };
/** The viewer is kept on the subscriber because a connection has an identity,
 * and because presence will read it. Global chat itself does no filtering:
 * every subscriber sees every message. */
type Subscriber = {
  socket: Socket;
  userId: UserId;
  displayName: string;
  active: boolean;
  subscribing: boolean;
  subscribed: boolean;
  // Messages published while the history query is in flight: buffered here
  // and flushed right after the history frame so none are silently dropped.
  pending: ChatMessage[];
};

export class GlobalChatHub {
  private readonly subscribers = new Set<Subscriber>();

  constructor(private readonly repository: GlobalChatRepository) {}

  stop() {
    for (const subscriber of this.subscribers) subscriber.active = false;
    this.subscribers.clear();
  }

  /** How many live subscribers there are; used by tests to prove cleanup. */
  subscriberCount() {
    return this.subscribers.size;
  }

  connect(viewer: { userId: UserId; displayName: string }, socket: Socket) {
    const subscriber: Subscriber = {
      socket,
      userId: viewer.userId,
      displayName: viewer.displayName,
      active: true,
      subscribing: false,
      subscribed: false,
      pending: [],
    };
    this.subscribers.add(subscriber);
    return {
      // Resolves once the history frame has been sent, so tests can await the
      // round trip; the HTTP layer fires this without awaiting.
      message: (raw: string) => this.subscribe(subscriber, raw),
      close: () => {
        subscriber.active = false;
        this.subscribers.delete(subscriber);
      },
    };
  }

  private async subscribe(subscriber: Subscriber, raw: string) {
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    const parsed = ChatSubscribeFrameSchema.safeParse(frame);
    if (!parsed.success) return;
    if (!subscriber.active || subscriber.subscribing || subscriber.subscribed) return;
    subscriber.subscribing = true;
    try {
      const window = await this.repository.listSubscriptionWindow(
        parsed.data.cursor,
        parsed.data.readCursor,
      );
      if (!subscriber.active) return;
      subscriber.subscribed = true;
      this.send(subscriber, { type: "history", ...window });
      // Anything published while the SELECT above was in flight was buffered
      // rather than dropped; flush it now, skipping what the history page
      // already covered so nothing is delivered twice.
      const pending = new Map<number, ChatMessage>();
      for (const message of subscriber.pending) pending.set(message.id, message);
      subscriber.pending = [];
      for (const message of pending.values()) {
        if (!subscriber.active) return;
        if (message.id > window.cursor) this.send(subscriber, { type: "message", message });
      }
    } finally {
      subscriber.subscribing = false;
    }
  }

  publish(message: ChatMessage) {
    for (const subscriber of this.subscribers) {
      if (subscriber.subscribed) this.send(subscriber, { type: "message", message });
      else subscriber.pending.push(message);
    }
  }

  private send(subscriber: Subscriber, frame: ChatServerFrame) {
    if (!subscriber.active) return;
    try {
      subscriber.socket.send(JSON.stringify(frame));
    } catch {
      // The close callback normally removes this first; a race with close must
      // not make a committed message fail.
    }
  }
}
