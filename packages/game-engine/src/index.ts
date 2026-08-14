// Pure domain engine.
//
// Hard boundary: this package must not depend on React, Tauri, Hono, Turso,
// Drizzle, Better Auth, WebSockets or i18n. Its only internal dependency is
// @werewolf/protocol. scripts/check-boundaries.ts enforces this.
//
// Modules to be filled in: state, composer/, roles/, commands/, resolution/,
// projection/, rng/.

export {};
