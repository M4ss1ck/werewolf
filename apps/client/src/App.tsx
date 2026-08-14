import { I18nextProvider } from "react-i18next";

import { i18n } from "./i18n/i18n.ts";
import { Routes } from "./routes.tsx";

export function App() {
  return (
    <I18nextProvider i18n={i18n}>
      <Shell />
    </I18nextProvider>
  );
}

function Shell() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-2">
      <h1 className="text-2xl font-semibold">Werewolf</h1>
      <Routes />
    </main>
  );
}
