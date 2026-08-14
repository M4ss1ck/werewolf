// English and Spanish are first-class from the first release.
//
// Framework-agnostic on purpose: this package owns the resource bundles and a
// plain i18next instance factory. React bindings (react-i18next) live in
// apps/client so the client never has to reach past its allowed dependencies.
//
// The server never emits localized prose. It emits semantic event kinds and
// machine-readable error codes, and this package renders them.

import type { i18n } from "i18next";
import i18next from "i18next";
import type { TranslationResource } from "./resources/en.ts";
import { en } from "./resources/en.ts";
import { es } from "./resources/es.ts";

export type { TranslationResource };
export { en, es };

export const SUPPORTED_LOCALES = ["en", "es"] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const FALLBACK_LOCALE: Locale = "en";

/** Both bundles under one namespace so `t("key")` resolves without prefixes. */
export const resources: Record<Locale, TranslationResource> = { en, es };

/** A configured i18next instance for one locale; English covers the rest. */
export function createI18n(locale: Locale = FALLBACK_LOCALE): i18n {
  const instance = i18next.createInstance();
  void instance.init({
    lng: locale,
    fallbackLng: FALLBACK_LOCALE,
    supportedLngs: [...SUPPORTED_LOCALES],
    resources: {
      en: { translation: en },
      es: { translation: es },
    },
    // Bundled resources: no async loading, so `t` is ready synchronously.
    initImmediate: false,
    // No DOM: values are plain text and player names must not be escaped.
    interpolation: { escapeValue: false },
    showSupportNotice: false,
  });
  return instance;
}

/**
 * Pick a locale from a stored preference and a browser/OS locale, falling
 * back to English. Accepts full tags ("es-AR", "EN-us") and takes the
 * language part only.
 */
export function resolveLocale(preference?: string | null, detected?: string | null): Locale {
  for (const candidate of [preference, detected]) {
    if (!candidate) continue;
    const lang = (candidate.split("-")[0] ?? "").toLowerCase();
    if ((SUPPORTED_LOCALES as readonly string[]).includes(lang)) {
      return lang as Locale;
    }
  }
  return FALLBACK_LOCALE;
}
