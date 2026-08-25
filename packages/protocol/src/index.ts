// Shared wire vocabulary between client and server. This package only
// describes the wire: schema and type definitions, no helpers or runtime
// logic, and no internal dependencies. The one exception is a pure
// derivation over wire values (dayOfPhase), which carries no state or I/O.

export const MIN_PLAYERS = 5;
export const BALANCE_VERSION = 1;

export * from "./actions.ts";
export * from "./bots.ts";
export * from "./chat.ts";
export * from "./commands.ts";
export * from "./enums.ts";
export * from "./errors.ts";
export * from "./events.ts";
export * from "./game-entry.ts";
export * from "./ids.ts";
export * from "./snapshots.ts";
export * from "./stats.ts";
export * from "./summaries.ts";
export * from "./websocket.ts";
