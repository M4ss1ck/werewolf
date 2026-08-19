// The server drives gameplay legality: the client renders controls from this
// model instead of switching on its own knowledge of roles.

import { z } from "zod";

import { ActionIdSchema } from "./enums.ts";
import { UserIdSchema } from "./ids.ts";

export const AvailableActionSchema = z.discriminatedUnion("type", [
  z.object({
    id: ActionIdSchema,
    type: z.literal("target"),
    targets: z.array(
      z.object({
        userId: UserIdSchema,
        enabled: z.boolean(),
      }),
    ),
    selectedTargetId: UserIdSchema.optional(),
  }),
  z.object({
    id: ActionIdSchema,
    type: z.literal("choice"),
    selected: z.boolean().optional(),
  }),
  z.object({
    id: ActionIdSchema,
    type: z.literal("targets"),
    count: z.number(),
    targets: z.array(
      z.object({
        userId: UserIdSchema,
        enabled: z.boolean(),
      }),
    ),
    selectedTargetIds: z.array(UserIdSchema).optional(),
  }),
]);

/** Union of action models; more shapes may join it later. */
export type AvailableAction = z.infer<typeof AvailableActionSchema>;
