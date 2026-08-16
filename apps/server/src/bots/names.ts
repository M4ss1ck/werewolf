// Display names for bot seats. Villagers, not robots: a seat that announces
// itself as "Bot 3" in chat reads badly, and the roster already carries the
// `isBot` flag for anyone who wants to know.

const POOL = [
  "Mira",
  "Tobias",
  "Elke",
  "Rowan",
  "Ines",
  "Caspar",
  "Nadia",
  "Bram",
  "Otilia",
  "Ferran",
  "Solveig",
  "Emeric",
] as const;

/** First unused pool name, falling back to a numbered seat once it runs out. */
export function pickBotName(taken: ReadonlySet<string>): string {
  const free = POOL.find((name) => !taken.has(name));
  if (free) return free;
  for (let index = 1; ; index += 1) {
    const name = `Villager ${index}`;
    if (!taken.has(name)) return name;
  }
}
