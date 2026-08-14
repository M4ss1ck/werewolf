import type { Locale } from "@werewolf/i18n";
import { afterEach, expect, test, vi } from "vitest";

import { LOCALE_STORAGE_KEY } from "./i18n.ts";

afterEach(() => {
  localStorage.clear();
  delete (navigator as unknown as { language?: string }).language;
});

/** Re-import i18n.ts with a stubbed saved preference and browser locale, so the
 * module-level `locale` is computed from exactly those two sources. */
async function resolveLocale(preference: string | null, detected: string): Promise<Locale> {
  localStorage.clear();
  if (preference !== null) localStorage.setItem(LOCALE_STORAGE_KEY, preference);
  Object.defineProperty(navigator, "language", { configurable: true, get: () => detected });
  vi.resetModules();
  const { locale } = await import("./i18n.ts");
  return locale;
}

test("locale prefers the saved preference, then the browser locale, then English", async () => {
  // A supported saved preference beats the browser locale.
  await expect(resolveLocale("es", "en-US")).resolves.toBe("es");
  // An unsupported saved preference falls through to a supported browser locale.
  await expect(resolveLocale("fr", "es-AR")).resolves.toBe("es");
  // Nothing supported anywhere falls back to English.
  await expect(resolveLocale("fr", "de-DE")).resolves.toBe("en");
  // No saved preference: the browser locale decides.
  await expect(resolveLocale(null, "es-ES")).resolves.toBe("es");
  // An English browser locale resolves to English.
  await expect(resolveLocale(null, "en-GB")).resolves.toBe("en");
});
