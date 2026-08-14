// Pure domain engine.
//
// Hard boundary: this package must not depend on React, Tauri, Hono, Turso,
// Drizzle, Better Auth, WebSockets or i18n. Its only internal dependency is
// @werewolf/protocol. scripts/check-boundaries.ts enforces this.

export * from "./commands/apply.ts";
export * from "./commands/validate.ts";
export * from "./composer/balance-v1.ts";
export * from "./composer/compose.ts";
export * from "./composer/constraints.ts";
export * from "./projection/available-actions.ts";
export * from "./resolution/night.ts";
export * from "./resolution/phase.ts";
export * from "./resolution/victory.ts";
export * from "./resolution/vote.ts";
export * from "./rng/rng.ts";
export * from "./roles/registry.ts";
export * from "./state.ts";
