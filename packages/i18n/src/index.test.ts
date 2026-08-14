import { expect, test } from "bun:test";
import { ACTION_IDS, ERROR_CODES, EVENT_KINDS, ROLE_IDS } from "@werewolf/protocol";

import { createI18n, en, es, FALLBACK_LOCALE, resolveLocale, SUPPORTED_LOCALES } from "./index.ts";

type Leaf = { path: string; value: string };

function collectLeaves(prefix: string, node: unknown, out: Leaf[]): Leaf[] {
  if (typeof node === "string") {
    out.push({ path: prefix, value: node });
    return out;
  }
  if (node === null || typeof node !== "object") return out;
  for (const [key, child] of Object.entries(node)) {
    collectLeaves(prefix === "" ? key : `${prefix}.${key}`, child, out);
  }
  return out;
}

/** The `t()` keys for every value; plural objects collapse to `<path>.count`. */
function collectRenderKeys(prefix: string, node: unknown, out: string[]): void {
  if (typeof node === "string") {
    out.push(prefix);
    return;
  }
  if (node === null || typeof node !== "object") return;
  if ("count_one" in node || "count_other" in node) {
    out.push(`${prefix}.count`);
    return;
  }
  for (const [key, child] of Object.entries(node)) {
    collectRenderKeys(`${prefix}.${key}`, child, out);
  }
}

test("English and Spanish are both first-class", () => {
  expect([...SUPPORTED_LOCALES]).toEqual(["en", "es"]);
});

test("English is the fallback when nothing else is known", () => {
  expect(FALLBACK_LOCALE).toBe("en");
  expect(SUPPORTED_LOCALES).toContain(FALLBACK_LOCALE);
});

test("createI18n defaults to the fallback locale", () => {
  const instance = createI18n();
  expect(instance.language).toBe("en");
  expect(instance.t("ui.signIn")).toBe("Sign in");
});

test("createI18n serves the requested locale", () => {
  const instance = createI18n("es");
  expect(instance.language).toBe("es");
  expect(instance.t("ui.signIn")).toBe("Iniciar sesión");
});

test("resolveLocale picks a supported locale from preference or detection", () => {
  expect(resolveLocale()).toBe("en");
  expect(resolveLocale(null, null)).toBe("en");
  expect(resolveLocale("fr")).toBe("en");
  expect(resolveLocale(null, "de-DE")).toBe("en");
  expect(resolveLocale("fr", "es-AR")).toBe("es");
  expect(resolveLocale(null, "es")).toBe("es");
  expect(resolveLocale("es")).toBe("es");
  expect(resolveLocale("en-US")).toBe("en");
  expect(resolveLocale("EN-us", null)).toBe("en");
});

test("Spanish mirrors the English key shape with no gaps, extras or empty values", () => {
  const enLeaves = collectLeaves("", en, []);
  const esLeaves = collectLeaves("", es, []);
  expect(esLeaves.map((leaf) => leaf.path).sort()).toEqual(
    enLeaves.map((leaf) => leaf.path).sort(),
  );
  const empty = [...enLeaves, ...esLeaves].filter((leaf) => leaf.value.trim() === "");
  expect(empty.map((leaf) => leaf.path)).toEqual([]);
});

test("every RoleId has a name and a description in both locales", () => {
  for (const role of ROLE_IDS) {
    for (const resource of [en, es]) {
      const entry = resource.roles[role];
      expect(entry.name.trim()).not.toBe("");
      expect(entry.description.trim()).not.toBe("");
    }
  }
});

test("every ActionId has a label and a prompt in both locales", () => {
  for (const action of ACTION_IDS) {
    for (const resource of [en, es]) {
      const entry = resource.actions[action];
      expect(entry.label.trim()).not.toBe("");
      expect(entry.prompt.trim()).not.toBe("");
    }
  }
});

test("every error code has a message a player can act on, in both locales", () => {
  for (const code of ERROR_CODES) {
    for (const resource of [en, es]) {
      expect(resource.errors[code].trim()).not.toBe("");
    }
  }
});

test("every player-facing event kind renders in both locales", () => {
  // Server-scope audit events never reach a viewer, so they have no
  // presentation here; everything else — public, player and faction scopes —
  // must render a sentence in each language.
  const playerFacing = EVENT_KINDS.filter(
    (kind) => kind !== "audit.vote" && kind !== "audit.night",
  );
  const vars = {
    player: "Alice",
    role: "Werewolf",
    phase: "Night",
    faction: "Wolves",
    text: "hello",
    abstain: 1,
    noVote: 2,
    count: 2,
    minimum: 5,
  };
  for (const kind of playerFacing) {
    for (const locale of SUPPORTED_LOCALES) {
      const resource = locale === "en" ? en : es;
      const branch = (resource.events as Record<string, unknown>)[
        kind in resource.events.public ? "public" : "player"
      ];
      const node = (branch as Record<string, unknown>)[kind];
      if (node === undefined) {
        throw new Error(`event kind "${kind}" has no translation in "${locale}"`);
      }
      const keys: string[] = [];
      collectRenderKeys(
        `events.${kind in resource.events.public ? "public" : "player"}.${kind}`,
        node,
        keys,
      );
      const t = createI18n(locale).t;
      for (const key of keys) {
        const rendered = t(key, vars);
        expect(rendered).not.toBe("");
        expect(rendered).not.toBe(key);
      }
    }
  }
});

test("server-only audit events are never presented", () => {
  for (const resource of [en, es]) {
    for (const kind of ["audit.vote", "audit.night"] as const) {
      expect(kind in resource.events.public).toBe(false);
      expect(kind in resource.events.player).toBe(false);
    }
  }
});

test("an elimination sentence names only the player and their revealed role", () => {
  for (const resource of [en, es]) {
    const placeholders = [
      ...resource.events.public["player.eliminated"].matchAll(/\{\{(\w+)\}\}/g),
    ].map((match) => match[1] ?? "");
    expect(placeholders.sort()).toEqual(["player", "role"]);
  }
});

test("night resolution counts deaths without naming how they died", () => {
  for (const resource of [en, es]) {
    const placeholders = [
      ...resource.events.public["night.resolved"].count_one.matchAll(/\{\{(\w+)\}\}/g),
      ...resource.events.public["night.resolved"].count_other.matchAll(/\{\{(\w+)\}\}/g),
    ].map((match) => match[1] ?? "");
    expect([...new Set(placeholders)]).toEqual(["count"]);
  }
});

test("plurals render differently for one and for several in each language", () => {
  for (const locale of SUPPORTED_LOCALES) {
    const t = createI18n(locale).t;
    const one = t("ui.players.count", { count: 1 });
    const several = t("ui.players.count", { count: 3 });
    expect(one).not.toBe("");
    expect(several).not.toBe("");
    expect(one).not.toBe(several);
  }
});
