import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.tsx";
import { clearStoredTokenOnCookieRuntime } from "./auth/token.ts";
import "./index.css";
import { ToastProvider } from "./toast.tsx";

const container = document.getElementById("root");

if (!container) {
  throw new Error("#root not found");
}

clearStoredTokenOnCookieRuntime();

createRoot(container).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
);
