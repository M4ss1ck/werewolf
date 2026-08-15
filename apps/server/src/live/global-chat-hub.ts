import type { GlobalChatRepository } from "@werewolf/db";
import {
  type ChatMessage,
  type ChatMessageId,
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
  subscribed: boolean;
};

export class GlobalChatHub {
  private readonly subscribers = new Set<Subscriber>();

  constructor(private readonly repository: GlobalChatRepository) {}

  stop() {
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
      subscribed: false,
    };
    this.subscribers.add(subscriber);
    return {
      // Resolves once the history frame has been sent, so tests can await the
      // round trip; the HTTP layer fires this without awaiting.
      message: (raw: string) => this.subscribe(subscriber, raw),
      close: () => {
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
    const messages = await this.repository.listRecent(parsed.data.cursor);
    subscriber.subscribed = true;
    this.send(subscriber, {
      type: "history",
      messages,
      cursor: messages.at(-1)?.id ?? (parsed.data.cursor as ChatMessageId),
    });
  }

  publish(message: ChatMessage) {
    for (const subscriber of this.subscribers)
      if (subscriber.subscribed) this.send(subscriber, { type: "message", message });
  }

  private send(subscriber: Subscriber, frame: ChatServerFrame) {
    try {
      subscriber.socket.send(JSON.stringify(frame));
    } catch {
      // The close callback normally removes this first; a race with close must
      // not make a committed message fail.
    }
  }
}
