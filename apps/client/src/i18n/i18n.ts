import { createI18n, type Locale, resolveLocale } from "@werewolf/i18n";
import { api } from "../api/client.ts";

export const LOCALE_STORAGE_KEY = "werewolf.locale";
const stored = () => localStorage.getItem(LOCALE_STORAGE_KEY);
const detected = () => navigator.language;

export const locale = resolveLocale(stored(), detected());
export const i18n = createI18n(locale);

export async function changeLocale(next: Locale, signedIn = true) {
  localStorage.setItem(LOCALE_STORAGE_KEY, next);
  await i18n.changeLanguage(next);
  if (signedIn) await api.patchLocale(next);
}
