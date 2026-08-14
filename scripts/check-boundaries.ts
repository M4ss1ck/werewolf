#!/usr/bin/env bun
/**
 * Package dependency rules, enforced instead of documented.
 *
 * The critical rule is that the client must never import game-engine: the
 * client is not authoritative and must not be able to compute hidden state.
 * The engine is additionally barred from any framework, transport, persistence
 * or i18n dependency, so it stays a pure domain module.
 */

const INTERNAL_ALLOWLIST: Record<string, readonly string[]> = {
  "packages/protocol": [],
  "packages/game-engine": ["@werewolf/protocol"],
  "packages/db": ["@werewolf/protocol", "@werewolf/game-engine"],
  "packages/i18n": ["@werewolf/protocol"],
  "apps/server": ["@werewolf/protocol", "@werewolf/game-engine", "@werewolf/db"],
  "apps/client": ["@werewolf/protocol", "@werewolf/i18n"],
};

/** The engine stays pure: no frameworks, transports, persistence or i18n. */
const ENGINE_FORBIDDEN_EXTERNALS = [
  "react",
  "react-dom",
  "@tauri-apps/",
  "hono",
  "@libsql/",
  "drizzle-orm",
  "better-auth",
  "ws",
  "i18next",
];

const transpiler = new Bun.Transpiler({ loader: "tsx" });

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

type Violation = { file: string; specifier: string; rule: string };

const violations: Violation[] = [];

for (const [pkg, allowed] of Object.entries(INTERNAL_ALLOWLIST)) {
  const glob = new Bun.Glob("**/*.{ts,tsx}");
  const dir = `${root}/${pkg}/src`;

  for await (const relative of glob.scan({ cwd: dir, onlyFiles: true })) {
    const file = `${pkg}/src/${relative}`;
    const source = await Bun.file(`${dir}/${relative}`).text();

    for (const { path: specifier } of transpiler.scanImports(source)) {
      if (specifier.startsWith("@werewolf/")) {
        const owner = specifier.split("/").slice(0, 2).join("/");

        if (!allowed.includes(owner)) {
          violations.push({
            file,
            specifier,
            rule: `${pkg} may only import [${allowed.join(", ") || "nothing"}]`,
          });
        }
      }

      if (pkg === "packages/game-engine") {
        const forbidden = ENGINE_FORBIDDEN_EXTERNALS.find(
          (name) => specifier === name || specifier.startsWith(name),
        );

        if (forbidden) {
          violations.push({
            file,
            specifier,
            rule: "game-engine must stay free of frameworks, transports, persistence and i18n",
          });
        }
      }
    }
  }
}

if (violations.length > 0) {
  console.error("Package boundary violations:\n");

  for (const { file, specifier, rule } of violations) {
    console.error(`  ${file}\n    imports "${specifier}"\n    ${rule}\n`);
  }

  process.exit(1);
}

console.log("Package boundaries OK.");
