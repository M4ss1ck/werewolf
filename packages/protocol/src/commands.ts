// Gameplay commands, sent by the client over HTTP. One discriminated union
// keyed on "type". `commandId` makes commands idempotent (a retried message
// must not produce two events); `phaseId` must equal the current phase's id.

import { z } from "zod";

import { ActionIdSchema, ChatChannelSchema } from "./enums.ts";
import { PhaseIdSchema, UserIdSchema } from "./ids.ts";

export const VoteSetCommandSchema = z.object({
  commandId: z.string().min(1),
  phaseId: PhaseIdSchema,
  type: z.literal("vote.set"),
  payload: z.object({
    targetId: UserIdSchema,
  }),
});
export type VoteSetCommand = z.infer<typeof VoteSetCommandSchema>;

export const VoteAbstainCommandSchema = z.object({
  commandId: z.string().min(1),
  phaseId: PhaseIdSchema,
  type: z.literal("vote.abstain"),
  payload: z.object({}),
});
export type VoteAbstainCommand = z.infer<typeof VoteAbstainCommandSchema>;

// Which actions take a target is part of the wire contract: wolf.attack,
// seer.inspect and harlot.visit need a targetId, harlot.stay takes none (and
// is rejected if one is supplied).
export const NightActionSetPayloadSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("wolf.attack"),
    targetId: UserIdSchema,
  }),
  z.object({
    action: z.literal("seer.inspect"),
    targetId: UserIdSchema,
  }),
  z.object({
    action: z.literal("harlot.visit"),
    targetId: UserIdSchema,
  }),
  z
    .object({
      action: z.literal("harlot.stay"),
    })
    .strict(),
  z.object({
    action: z.literal("cupid.link"),
    targetIds: z.array(UserIdSchema).length(2),
  }),
  z.object({
    action: z.literal("priest.protect"),
    targetId: UserIdSchema,
  }),
  z.object({
    action: z.literal("guardian.bond"),
    targetId: UserIdSchema,
  }),
]);
export type NightActionSetPayload = z.infer<typeof NightActionSetPayloadSchema>;

export const NightActionSetCommandSchema = z.object({
  commandId: z.string().min(1),
  phaseId: PhaseIdSchema,
  type: z.literal("night.action.set"),
  payload: NightActionSetPayloadSchema,
});
export type NightActionSetCommand = z.infer<typeof NightActionSetCommandSchema>;

export const NightActionClearCommandSchema = z.object({
  commandId: z.string().min(1),
  phaseId: PhaseIdSchema,
  type: z.literal("night.action.clear"),
  payload: z.object({
    action: ActionIdSchema,
  }),
});
export type NightActionClearCommand = z.infer<typeof NightActionClearCommandSchema>;

export const DayActionSetPayloadSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("mayor.reveal"),
    targetId: UserIdSchema,
  }),
  z
    .object({
      action: z.literal("mayor.pardon"),
    })
    .strict(),
]);
export type DayActionSetPayload = z.infer<typeof DayActionSetPayloadSchema>;

export const DayActionSetCommandSchema = z.object({
  commandId: z.string().min(1),
  phaseId: PhaseIdSchema,
  type: z.literal("day.action.set"),
  payload: DayActionSetPayloadSchema,
});
export type DayActionSetCommand = z.infer<typeof DayActionSetCommandSchema>;

export const ChatSendCommandSchema = z.object({
  commandId: z.string().min(1),
  phaseId: PhaseIdSchema,
  type: z.literal("chat.send"),
  payload: z.object({
    channel: ChatChannelSchema,
    text: z.string(),
  }),
});
export type ChatSendCommand = z.infer<typeof ChatSendCommandSchema>;

export const PhaseReadyCommandSchema = z.object({
  commandId: z.string().min(1),
  phaseId: PhaseIdSchema,
  type: z.literal("phase.ready"),
  payload: z.object({ ready: z.boolean() }),
});
export type PhaseReadyCommand = z.infer<typeof PhaseReadyCommandSchema>;

export const GameplayCommandSchema = z.discriminatedUnion("type", [
  VoteSetCommandSchema,
  VoteAbstainCommandSchema,
  NightActionSetCommandSchema,
  NightActionClearCommandSchema,
  DayActionSetCommandSchema,
  ChatSendCommandSchema,
  PhaseReadyCommandSchema,
]);
export type GameplayCommand = z.infer<typeof GameplayCommandSchema>;
