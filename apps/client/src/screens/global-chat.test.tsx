import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ChatMessage, ChatMessageId, UserId } from "@werewolf/protocol";
import type { ReactElement } from "react";
import { I18nextProvider } from "react-i18next";
import { expect, test, vi } from "vitest";

// jsdom has no layout, so the real virtualizer measures everything at 0px and
// renders nothing. This stand-in renders every row and exposes startReached as
// a button, which is what lets the wiring be asserted at all.
vi.mock("react-virtuoso", () => ({
  Virtuoso: ({
    data,
    itemContent,
    startReached,
  }: {
    data: ChatMessage[];
    itemContent: (index: number, message: ChatMessage) => ReactElement;
    startReached?: () => void;
  }) => (
    <div>
      <button onClick={() => startReached?.()} type="button">
        start-reached
      </button>
      {data.map((message, index) => (
        <div key={message.id}>{itemContent(index, message)}</div>
      ))}
    </div>
  ),
}));

const { GlobalChatScreen } = await import("./global-chat.tsx");
const { initialChatState, withHistory } = await import("../api/chat-state.ts");
const { ApiError } = await import("../api/client.ts");
const { i18n } = await import("../i18n/i18n.ts");

function message(id: number, text: string): ChatMessage {
  return {
    id: id as ChatMessageId,
    userId: "u1" as UserId,
    displayName: "Ana",
    text,
    createdAt: 1_000_000 + id,
  };
}

function renderWithI18n(ui: ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

test("renders the messages it is given", () => {
  const state = withHistory(
    initialChatState,
    [message(1, "anyone up at 21:00?"), message(2, "I'm in")],
    2 as ChatMessageId,
  );

  renderWithI18n(
    <GlobalChatScreen
      onLoadOlder={() => undefined}
      onSend={() => undefined}
      state={state}
      viewerId={"u2" as UserId}
    />,
  );

  expect(screen.getByText("anyone up at 21:00?")).toBeInTheDocument();
  expect(screen.getByText("I'm in")).toBeInTheDocument();
});

test("shows the empty state when there are no messages", () => {
  renderWithI18n(
    <GlobalChatScreen
      onLoadOlder={() => undefined}
      onSend={() => undefined}
      state={initialChatState}
      viewerId={"u2" as UserId}
    />,
  );

  expect(screen.getByText("No messages yet. Say hello.")).toBeInTheDocument();
});

test("sending a message calls onSend and clears the composer", async () => {
  const sent: string[] = [];
  renderWithI18n(
    <GlobalChatScreen
      onLoadOlder={() => undefined}
      onSend={(text) => {
        sent.push(text);
      }}
      state={initialChatState}
      viewerId={"u2" as UserId}
    />,
  );

  const input = screen.getByLabelText("Message");
  fireEvent.change(input, { target: { value: "21:00 works" } });
  await act(async () => {
    fireEvent.submit(input.closest("form")!);
    await Promise.resolve();
  });

  expect(sent).toEqual(["21:00 works"]);
  expect(input).toHaveValue("");
});

test("reaching the start asks for an older page", () => {
  let calls = 0;
  const state = withHistory(initialChatState, [message(2, "I'm in")], 2 as ChatMessageId);

  renderWithI18n(
    <GlobalChatScreen
      onLoadOlder={() => {
        calls += 1;
      }}
      onSend={() => undefined}
      state={{ ...state, hasOlder: true }}
      viewerId={"u2" as UserId}
    />,
  );
  fireEvent.click(screen.getByText("start-reached"));

  expect(calls).toBe(1);
});

test("a send error shows its translated message", () => {
  renderWithI18n(
    <GlobalChatScreen
      error={new ApiError("RATE_LIMITED")}
      onLoadOlder={() => undefined}
      onSend={() => undefined}
      state={initialChatState}
      viewerId={"u2" as UserId}
    />,
  );

  expect(screen.getByRole("alert")).toHaveTextContent("You are sending messages too quickly.");
});

test("no error means no alert", () => {
  renderWithI18n(
    <GlobalChatScreen
      onLoadOlder={() => undefined}
      onSend={() => undefined}
      state={initialChatState}
      viewerId={"u2" as UserId}
    />,
  );

  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("reaching the start does nothing once there is nothing older", () => {
  let calls = 0;
  const state = withHistory(initialChatState, [message(2, "I'm in")], 2 as ChatMessageId);

  renderWithI18n(
    <GlobalChatScreen
      onLoadOlder={() => {
        calls += 1;
      }}
      onSend={() => undefined}
      state={{ ...state, hasOlder: false }}
      viewerId={"u2" as UserId}
    />,
  );
  fireEvent.click(screen.getByText("start-reached"));

  expect(calls).toBe(0);
});
