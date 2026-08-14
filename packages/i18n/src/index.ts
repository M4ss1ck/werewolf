// English and Spanish are first-class from the first release.
//
// Framework-agnostic on purpose: this package owns the resource bundles and a
// plain i18next instance factory. React bindings (react-i18next) live in
// apps/client so the client never has to reach past its allowed dependencies.
//
// The server never emits localized prose. It emits semantic event kinds and
// machine-readable error codes, and this package renders them.

export const SUPPORTED_LOCALES = ["en", "es"] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const FALLBACK_LOCALE: Locale = "en";
