// Dev-only. Imported automatically by @reticlehq/vite-plugin, so you do not need to import it.
// Self-guards on import.meta.env.DEV, so it is a no-op in a production build.
import { registerCapabilities, registerStore } from "@reticlehq/react";

import { i18n } from "./i18n/i18n.ts";
import { currentRoute } from "./routes.tsx";

if (import.meta.env.DEV) {
  // The app has no global store: session, snapshot and chat all live in `useState` inside `Shell`,
  // which nothing outside React can read. What *is* readable from outside is the shell of the app —
  // which screen the user is on and which language it renders in — so that is what we register.
  registerStore("shell", {
    getState: () => ({ route: currentRoute(), locale: i18n.language }),
    subscribe: (listener) => {
      window.addEventListener("popstate", listener);
      i18n.on("languageChanged", listener);
      return () => {
        window.removeEventListener("popstate", listener);
        i18n.off("languageChanged", listener);
      };
    },
  });

  registerCapabilities({
    // The app has no data-testid attributes; its own tests select by role, text and label, and so
    // does Reticle. Add ids here only alongside the attributes they name.
    testids: [],
    signals: [],
    stores: ["shell"],
  });
}
