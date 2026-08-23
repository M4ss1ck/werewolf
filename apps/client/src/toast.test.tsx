import { act, fireEvent, render, screen } from "@testing-library/react";
import { en } from "@werewolf/i18n";
import type { ReactElement } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, test, vi } from "vitest";
import { ApiError } from "./api/client.ts";
import { i18n } from "./i18n/i18n.ts";
import { ToastProvider, useToast } from "./toast.tsx";

function Harness() {
  const { show, showError } = useToast();
  return (
    <div>
      <button onClick={() => show("error", "boom")} type="button">
        show
      </button>
      <button onClick={() => showError(new ApiError("PHASE_CLOSED"))} type="button">
        show-error
      </button>
      <button onClick={() => show("success", "ok")} type="button">
        show-success
      </button>
    </div>
  );
}

function renderWithI18n(ui: ReactElement) {
  return render(
    <I18nextProvider i18n={i18n}>
      <ToastProvider>{ui}</ToastProvider>
    </I18nextProvider>,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

test("an error toast renders the translated error code and never auto-dismisses", () => {
  vi.useFakeTimers();
  renderWithI18n(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "show-error" }));
  expect(screen.getByRole("status")).toHaveTextContent(en.errors.PHASE_CLOSED);
  // Well past any plausible auto-dismiss: the toast must still be standing.
  act(() => vi.advanceTimersByTime(60_000));
  expect(screen.getByRole("status")).toHaveTextContent(en.errors.PHASE_CLOSED);
});

test("the close button dismisses the toast", () => {
  vi.useFakeTimers();
  renderWithI18n(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "show" }));
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  act(() => vi.advanceTimersByTime(300));
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

test("a horizontal swipe past the threshold dismisses the toast", () => {
  vi.useFakeTimers();
  renderWithI18n(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "show" }));
  const toast = screen.getByRole("status");
  fireEvent.pointerDown(toast, { pointerId: 1, clientX: 100 });
  fireEvent.pointerMove(toast, { pointerId: 1, clientX: 200 });
  fireEvent.pointerUp(toast, { pointerId: 1, clientX: 200 });
  act(() => vi.advanceTimersByTime(300));
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

test("a horizontal swipe under the threshold springs back and keeps the toast", () => {
  vi.useFakeTimers();
  renderWithI18n(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "show" }));
  const toast = screen.getByRole("status");
  fireEvent.pointerDown(toast, { pointerId: 1, clientX: 100 });
  fireEvent.pointerMove(toast, { pointerId: 1, clientX: 150 });
  fireEvent.pointerUp(toast, { pointerId: 1, clientX: 150 });
  act(() => vi.advanceTimersByTime(300));
  expect(screen.getByRole("status")).toHaveTextContent("boom");
});

test("showing a second toast replaces the first", () => {
  vi.useFakeTimers();
  renderWithI18n(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "show" }));
  fireEvent.click(screen.getByRole("button", { name: "show-success" }));
  expect(screen.getAllByRole("status")).toHaveLength(1);
  expect(screen.getByRole("status")).toHaveTextContent("ok");
});
