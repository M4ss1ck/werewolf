import type { ChatMessage, ChatMessageId, ChatServerFrame } from "@werewolf/protocol";
import { ChatServerFrameSchema, ChatSubscribeFrameSchema } from "@werewolf/protocol";

import { wsUrl } from "./origin.ts";

export interface ChatHandlers {
  onHistory?: (messages: ChatMessage[], cursor: ChatMessageId) => void;
  onMessage?: (message: ChatMessage) => void;
}

export class GlobalChatConnection {
  private socket: WebSocket | null = null;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  /** Advanced as frames arrive, so a reconnect asks only for what it missed. */
  private cursor: ChatMessageId;

  constructor(
    private readonly handlers: ChatHandlers = {},
    initialCursor: ChatMessageId = 0 as ChatMessageId,
  ) {
    this.cursor = initialCursor;
  }

  connect() {
    this.closed = false;
    this.socket = new WebSocket(wsUrl("/api/chat/live"));
    this.socket.onopen = () => {
      this.retry = 0;
      const frame = ChatSubscribeFrameSchema.parse({
        type: "subscribe",
        cursor: this.cursor,
      });
      this.socket?.send(JSON.stringify(frame));
    };
    this.socket.onmessage = (message) => this.receive(message.data);
    this.socket.onclose = () => {
      this.socket = null;
      if (!this.closed) this.reconnect();
    };
    this.socket.onerror = () => this.socket?.close();
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.socket?.close();
  }

  private reconnect() {
    const delay = Math.min(1000 * 2 ** this.retry, 10_000);
    this.retry += 1;
    this.timer = setTimeout(() => this.connect(), delay);
  }

  private receive(raw: unknown) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      return;
    }
    const result = ChatServerFrameSchema.safeParse(parsed);
    if (!result.success) return;
    // The schema validated the frame at runtime; the cast only reconciles the
    // schema's inferred types with the wire contract types.
    const frame = result.data as ChatServerFrame;
    if (frame.type === "history") {
      this.cursor = frame.cursor;
      this.handlers.onHistory?.(frame.messages, frame.cursor);
    } else {
      this.cursor = frame.message.id;
      this.handlers.onMessage?.(frame.message);
    }
  }
}
