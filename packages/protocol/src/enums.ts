// Stable wire vocabulary. These strings are never renamed, reformatted,
// pluralised or translated; translation only affects presentation. Each set is
// declared once as a const tuple, with the union type and the Zod enum derived
// from it so the three cannot drift apart.

import { z } from "zod";

export const ROLE_IDS = [
  "villager",
  "werewolf",
  "mason",
  "seer",
  "cursed",
  "harlot",
  "hunter",
  "princess",
  "veteran",
  "serial_killer",
] as const;
export type RoleId = (typeof ROLE_IDS)[number];
export const RoleIdSchema = z.enum(ROLE_IDS);

export const FACTION_IDS = ["village", "wolves", "veteran", "serial_killer"] as const;
export type FactionId = (typeof FACTION_IDS)[number];
export const FactionIdSchema = z.enum(FACTION_IDS);

export const GAME_PHASES = ["discussion", "voting", "night"] as const;
export type GamePhase = (typeof GAME_PHASES)[number];
export const GamePhaseSchema = z.enum(GAME_PHASES);

export const GAME_STATUSES = ["lobby", "scheduled", "running", "finished", "cancelled"] as const;
export type GameStatus = (typeof GAME_STATUSES)[number];
export const GameStatusSchema = z.enum(GAME_STATUSES);

export const GAME_PLAYER_STATUSES = ["lobby", "alive", "dead", "spectator"] as const;
export type GamePlayerStatus = (typeof GAME_PLAYER_STATUSES)[number];
export const GamePlayerStatusSchema = z.enum(GAME_PLAYER_STATUSES);

export const ACTION_IDS = [
  "wolf.attack",
  "seer.inspect",
  "harlot.visit",
  "harlot.stay",
  "serial_killer.visit",
  "serial_killer.stay",
] as const;
export type ActionId = (typeof ACTION_IDS)[number];
export const ActionIdSchema = z.enum(ACTION_IDS);

export const EVENT_SCOPES = ["public", "player", "faction", "server"] as const;
export type EventScope = (typeof EVENT_SCOPES)[number];
export const EventScopeSchema = z.enum(EVENT_SCOPES);

/** Chat channels a client may address; the server decides who may access them. */
export const CHAT_CHANNELS = ["public", "wolves"] as const;
export type ChatChannel = (typeof CHAT_CHANNELS)[number];
export const ChatChannelSchema = z.enum(CHAT_CHANNELS);

// The spec stores a `visibility` column on games without enumerating its
// values; "public" games are discoverable, "private" games are joined by code.
export const GAME_VISIBILITIES = ["public", "private"] as const;
export type GameVisibility = (typeof GAME_VISIBILITIES)[number];
export const GameVisibilitySchema = z.enum(GAME_VISIBILITIES);

export const CONVERSION_CAUSES = ["cursed"] as const;
export type ConversionCause = (typeof CONVERSION_CAUSES)[number];
export const ConversionCauseSchema = z.enum(CONVERSION_CAUSES);
