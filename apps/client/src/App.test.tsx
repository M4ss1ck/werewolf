import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { App } from "./App.tsx";

test("renders the sign-in screen when signed out", () => {
  render(<App />);
  expect(screen.getByRole("heading", { name: "Werewolf" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Sign in/ })).toBeInTheDocument();
});
