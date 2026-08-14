import { expect, test } from "bun:test";
import { FALLBACK_LOCALE, SUPPORTED_LOCALES } from "./index.ts";

test("English and Spanish are both first-class", () => {
  expect([...SUPPORTED_LOCALES]).toEqual(["en", "es"]);
});

test("English is the fallback when nothing else is known", () => {
  expect(FALLBACK_LOCALE).toBe("en");
  expect(SUPPORTED_LOCALES).toContain(FALLBACK_LOCALE);
});
