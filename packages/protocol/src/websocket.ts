// Realtime push over WebSocket. Gameplay mutations go over HTTP; the socket
// carries only the client subscribe message and server-to-client frames. The
// frames are a discriminated union keyed on "type".

import { z } from "zod";
import type { GameEvent } from "./events.ts";
import { GameEventSchema } from "./events.ts";
import type { EventId } from "./ids.ts";
import { EventIdSchema } from "./ids.ts";
import type { ViewerGameSnapshot } from "./snapshots.ts";
import { ViewerGameSnapshotSchema } from "./snapshots.ts";

export const SubscribeFrameSchema = z.object({
  type: z.literal("subscribe"),
  cursor: EventIdSchema,
});
export type SubscribeFrame = z.infer<typeof SubscribeFrameSchema>;

export type ServerFrame =
  | {
      type: "sync";
      snapshot: ViewerGameSnapshot;
      events: GameEvent[];
      cursor: EventId;
    }
  | {
      type: "event";
      event: GameEvent;
    }
  | {
      type: "ephemeral";
      kind: string;
      payload: unknown;
    }
  | {
      type: "resync_required";
    };

/** Runtime validation for frames arriving from the server over the socket. */
export const ServerFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("sync"),
    snapshot: ViewerGameSnapshotSchema,
    events: z.array(GameEventSchema),
    cursor: EventIdSchema,
  }),
  z.object({
    type: z.literal("event"),
    event: GameEventSchema,
  }),
  z.object({
    type: z.literal("ephemeral"),
    kind: z.string(),
    payload: z.unknown(),
  }),
  z.object({
    type: z.literal("resync_required"),
  }),
]);
