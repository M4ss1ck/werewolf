import { MIN_PLAYERS } from "@werewolf/protocol";

export function App() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-2">
      <h1 className="text-2xl font-semibold">Werewolf</h1>
      <p className="text-sm opacity-70">Minimum {MIN_PLAYERS} players.</p>
    </main>
  );
}
