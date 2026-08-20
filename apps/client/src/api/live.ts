import type {
  EventId,
  GameEvent,
  GameId,
  ServerFrame,
  ViewerGameSnapshot,
} from "@werewolf/protocol";
import { ServerFrameSchema, SubscribeFrameSchema } from "@werewolf/protocol";

import { getAuthToken, webSocketBearerProtocols } from "../auth/token.ts";
import { api } from "./client.ts";
import { wsUrl } from "./origin.ts";

export type LiveStatus = "connecting" | "connected" | "reconnecting" | "closed";
export interface LiveHandlers {
  onSnapshot?: (snapshot: ViewerGameSnapshot) => void;
  onEvent?: (event: GameEvent) => void;
  onEphemeral?: (kind: string, payload: unknown) => void;
  onStatus?: (status: LiveStatus) => void;
}

export class LiveGameConnection {
  private socket: WebSocket | null = null;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private status: LiveStatus = "closed";
  private cursor: EventId;
  /** Last snapshot received from the server; kept across reconnects so the UI
   * can show a reconnecting state without blanking out. */
  private snapshot: ViewerGameSnapshot | null = null;

  constructor(
    private readonly gameId: GameId | string,
    cursor: EventId = 0 as EventId,
    private readonly handlers: LiveHandlers = {},
  ) {
    this.cursor = cursor;
  }

  connect() {
    this.closed = false;
    this.setStatus(this.retry ? "reconnecting" : "connecting");
    // A handshake cannot carry an Authorization header, so a browser-safe
    // encoding of the token rides in the subprotocol when one is stored.
    const token = getAuthToken();
    this.socket = token
      ? new WebSocket(wsUrl(`/api/games/${this.gameId}/live`), webSocketBearerProtocols(token))
      : new WebSocket(wsUrl(`/api/games/${this.gameId}/live`));
    this.socket.onopen = () => {
      this.retry = 0;
      this.setStatus("connected");
      const frame = SubscribeFrameSchema.parse({ type: "subscribe", cursor: this.cursor });
      this.socket?.send(JSON.stringify(frame));
    };
    this.socket.onmessage = (message) => void this.receive(message.data);
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
    this.setStatus("closed");
  }

  getCursor() {
    return this.cursor;
  }
  getStatus() {
    return this.status;
  }
  getSnapshot() {
    return this.snapshot;
  }

  private setStatus(status: LiveStatus) {
    this.status = status;
    this.handlers.onStatus?.(status);
  }

  private reconnect() {
    this.setStatus("reconnecting");
    const delay = Math.min(1000 * 2 ** this.retry, 10_000);
    this.retry += 1;
    this.timer = setTimeout(() => this.connect(), delay);
  }

  private async receive(raw: unknown) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      return;
    }
    const result = ServerFrameSchema.safeParse(parsed);
    if (!result.success) return;
    // The schema validated the frame at runtime; the cast only reconciles the
    // schema's inferred optional-property types with the wire contract types.
    const frame = result.data as ServerFrame;
    switch (frame.type) {
      case "sync": {
        this.cursor = frame.cursor;
        this.snapshot = frame.snapshot;
        this.handlers.onSnapshot?.(frame.snapshot);
        for (const event of frame.events) this.handlers.onEvent?.(event);
        break;
      }
      case "event": {
        this.cursor = frame.event.id;
        this.handlers.onEvent?.(frame.event);
        break;
      }
      case "ephemeral": {
        this.handlers.onEphemeral?.(frame.kind, frame.payload);
        break;
      }
      case "resync_required": {
        // The server's cursor moved past what the socket can carry; reload the
        // whole snapshot over HTTP instead of patching local state.
        const snapshot = await api.getSnapshot(this.gameId);
        this.cursor = snapshot.cursor;
        this.snapshot = snapshot;
        this.handlers.onSnapshot?.(snapshot);
        break;
      }
    }
  }
}
