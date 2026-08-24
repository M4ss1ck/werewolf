import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ChatContent, UserId } from "@werewolf/protocol";
import { useState } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "../api/client.ts";
import { i18n } from "../i18n/i18n.ts";
import { ChatBubble, ChatComposer } from "./chat-components.tsx";
import type { ChatDraft } from "./mentions.ts";

const source = {
  kind: "local" as const,
  candidates: [{ userId: "u2" as never, displayName: "Ana" }],
};
function wrap(node: React.ReactNode) {
  return <I18nextProvider i18n={i18n}>{node}</I18nextProvider>;
}
const draft = { text: "", mentions: [] };

test("composer selects a local mention and sends canonical content", async () => {
  const onDraftChange = vi.fn();
  const onSend = vi.fn<(content: ChatContent) => Promise<void>>().mockResolvedValue();
  function Harness() {
    const [current, setCurrent] = useState<ChatDraft>(draft);
    return (
      <ChatComposer
        inputId="chat"
        label="Message"
        placeholder="Say"
        sendLabel="Send"
        draft={current}
        source={source}
        readOnly={false}
        onDraftChange={(next) => {
          onDraftChange(next);
          setCurrent(next);
        }}
        onSend={onSend}
        onSent={vi.fn()}
      />
    );
  }
  render(wrap(<Harness />));
  const input = screen.getByRole("combobox");
  fireEvent.change(input, { target: { value: "@A" } });
  expect(screen.getByRole("option", { name: /Ana/ })).toBeInTheDocument();
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.keyUp(input, { key: "Enter" });
  expect(onDraftChange).toHaveBeenCalledWith(expect.objectContaining({ text: "@Ana " }));
  expect(screen.queryByRole("option")).not.toBeInTheDocument();
  fireEvent.change(input, { target: { value: "@An" } });
  expect(screen.getByRole("option", { name: /Ana/ })).toBeInTheDocument();
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.keyUp(input, { key: "Enter" });
  expect(screen.queryByRole("option")).not.toBeInTheDocument();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send" })));
  expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ text: "@Ana" }));
});

test("caret restore after selecting a trailing mention must not reopen its own query", async () => {
  const onSend = vi.fn<(content: ChatContent) => Promise<void>>().mockResolvedValue();
  function Harness() {
    const [current, setCurrent] = useState<ChatDraft>(draft);
    return (
      <ChatComposer
        inputId="chat"
        label="Message"
        placeholder="Say"
        sendLabel="Send"
        draft={current}
        source={source}
        readOnly={false}
        onDraftChange={setCurrent}
        onSend={onSend}
        onSent={vi.fn()}
      />
    );
  }
  render(wrap(<Harness />));
  const input = screen.getByRole("combobox") as HTMLInputElement;
  const send = screen.getByRole("button", { name: "Send" });

  fireEvent.change(input, { target: { value: "@A" } });
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.keyUp(input, { key: "Enter" });
  expect(input).toHaveValue("@Ana ");

  // choose() restores the caret with a programmatic setSelectionRange, which
  // fires the input's native `select` event -- the same handler a real user
  // click uses to reopen the mention search at the new caret position.
  input.setSelectionRange(input.value.length, input.value.length);
  fireEvent.select(input);
  expect(screen.queryByRole("option")).not.toBeInTheDocument();

  // Pressing Enter here must submit the message, not re-select the mention.
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.keyUp(input, { key: "Enter" });
  expect(send).not.toBeDisabled();

  await act(async () => fireEvent.click(send));
  expect(onSend).toHaveBeenCalledWith({
    text: "@Ana",
    mentions: [{ userId: "u2", start: 0, length: 4 }],
  });
});

test("composer preserves controlled draft when send rejects", async () => {
  const selectedDraft: ChatDraft = {
    text: "@Alice hello",
    mentions: [{ userId: "alice" as never, start: 0, length: 6 }],
  };
  const onSend = vi.fn().mockRejectedValue(new Error("no"));
  const onDraftChange = vi.fn();
  const onError = vi.fn();
  render(
    wrap(
      <ChatComposer
        inputId="chat"
        label="Message"
        placeholder="Say"
        sendLabel="Send"
        draft={selectedDraft}
        source={source}
        readOnly={false}
        onDraftChange={onDraftChange}
        onSend={onSend}
        onSent={vi.fn()}
        onError={onError}
      />,
    ),
  );
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send" })));
  expect(onSend).toHaveBeenCalledWith({
    text: selectedDraft.text,
    mentions: selectedDraft.mentions,
  });
  expect(screen.getByRole("combobox")).toHaveValue(selectedDraft.text);
  expect(onDraftChange).not.toHaveBeenCalled();
  expect(onError).toHaveBeenCalled();
});

test("bubble renders structured mentions with visible cue", () => {
  render(
    wrap(
      <ChatBubble
        author="Ana"
        authorId={"u2" as never}
        mine={false}
        viewerId={"u1" as never}
        text="hi @Me"
        mentions={[{ userId: "u1" as never, start: 3, length: 3 }]}
      />,
    ),
  );
  expect(screen.getByText("@Me")).toHaveAttribute("data-mention", "true");
  expect(screen.getByText("Mentioned you")).toBeInTheDocument();
});

const remoteCandidates = [
  { userId: "alice" as never, displayName: "Alice" },
  { userId: "alina" as never, displayName: "Alina" },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderControlledComposer({
  source: candidateSource,
  initialDraft = draft,
  onSend = vi.fn<(content: ChatContent) => Promise<void>>().mockResolvedValue(),
  onError = vi.fn(),
  onInvalidMention = vi.fn(),
}: {
  source: typeof remoteSource;
  initialDraft?: ChatDraft;
  onSend?: (content: ChatContent) => Promise<void>;
  onError?: (error: unknown) => void;
  onInvalidMention?: () => void;
}) {
  function Harness() {
    const [current, setCurrent] = useState<ChatDraft>(initialDraft);
    return (
      <ChatComposer
        inputId="remote-chat"
        label="Message"
        placeholder="Say"
        sendLabel="Send"
        draft={current}
        source={candidateSource}
        readOnly={false}
        onDraftChange={setCurrent}
        onSend={onSend}
        onSent={vi.fn()}
        onError={onError}
        onInvalidMention={onInvalidMention}
      />
    );
  }
  return render(wrap(<Harness />));
}

const remoteSource = {
  kind: "remote" as const,
  recentUserIds: ["alice" as never, "historic" as never],
  refreshToken: 0,
  search: vi.fn<(query: string, signal: AbortSignal) => Promise<typeof remoteCandidates>>(),
};

describe("ChatComposer async search and controlled errors", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    remoteSource.search.mockReset();
    remoteSource.search.mockImplementation(() => new Promise<typeof remoteCandidates>(() => {}));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  test("does not request below three query characters and debounces exactly 200ms", () => {
    renderControlledComposer({ source: remoteSource });
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "@" } });
    fireEvent.change(input, { target: { value: "@Al" } });
    act(() => vi.advanceTimersByTime(199));
    expect(remoteSource.search).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(remoteSource.search).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "@Ali" } });
    act(() => vi.advanceTimersByTime(199));
    expect(remoteSource.search).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(remoteSource.search).toHaveBeenCalledWith("Ali", expect.any(AbortSignal));
  });

  test("ignores stale responses and renders only current authoritative IDs", async () => {
    const first = deferred<typeof remoteCandidates>();
    const second = deferred<typeof remoteCandidates>();
    remoteSource.search.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    renderControlledComposer({ source: remoteSource });
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "@Ali" } });
    act(() => vi.advanceTimersByTime(200));
    fireEvent.change(input, { target: { value: "@Alin" } });
    act(() => vi.advanceTimersByTime(200));
    await act(async () => second.resolve([{ userId: "alina" as never, displayName: "Alina" }]));
    await act(async () => first.resolve([{ userId: "alice" as never, displayName: "Alice" }]));
    expect(screen.getByRole("option", { name: /Alina, user alin/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Alice, user alice/ })).not.toBeInTheDocument();
  });

  test("same-query failure preserves success, different-query failure clears options", async () => {
    remoteSource.search
      .mockResolvedValueOnce(remoteCandidates)
      .mockRejectedValueOnce(new Error("429"))
      .mockRejectedValueOnce(new Error("no results"));
    let refresh!: () => void;
    function Harness() {
      const [current, setCurrent] = useState<ChatDraft>(draft);
      const [refreshToken, setRefreshToken] = useState(0);
      refresh = () => setRefreshToken((value) => value + 1);
      return (
        <ChatComposer
          inputId="remote-chat"
          label="Message"
          placeholder="Say"
          sendLabel="Send"
          draft={current}
          source={{ ...remoteSource, refreshToken }}
          readOnly={false}
          onDraftChange={setCurrent}
          onSend={vi.fn().mockResolvedValue(undefined)}
          onSent={vi.fn()}
        />
      );
    }
    render(wrap(<Harness />));
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "@Ali" } });
    await act(async () => vi.advanceTimersByTime(200));
    expect(screen.getByRole("option", { name: /Alice, user alice/ })).toBeInTheDocument();
    act(refresh);
    await act(async () => vi.advanceTimersByTime(200));
    expect(screen.getByRole("option", { name: /Alice, user alice/ })).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "@Bob" } });
    await act(async () => vi.advanceTimersByTime(200));
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  test("local suggestions open after one character and close at zero-prefix", () => {
    const local = { kind: "local" as const, candidates: remoteCandidates };
    function Harness() {
      const [current, setCurrent] = useState<ChatDraft>(draft);
      return (
        <ChatComposer
          inputId="local-chat"
          label="Message"
          placeholder="Say"
          sendLabel="Send"
          draft={current}
          source={local}
          readOnly={false}
          onDraftChange={setCurrent}
          onSend={vi.fn().mockResolvedValue(undefined)}
          onSent={vi.fn()}
        />
      );
    }
    render(wrap(<Harness />));
    const input = screen.getByRole("combobox", { name: "Message" });
    fireEvent.change(input, { target: { value: "@" } });
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "@A" } });
    expect(screen.getByRole("option", { name: /Alice/ })).toBeInTheDocument();
    act(() => fireEvent.change(input, { target: { value: "" } }));
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  test("same-name autocomplete options receive distinct identity colors", () => {
    render(
      wrap(
        <ChatComposer
          inputId="same-name-chat"
          label="Message"
          placeholder="Say"
          sendLabel="Send"
          draft={draft}
          source={{
            kind: "local",
            candidates: [
              { userId: "u9" as never, displayName: "Alex" },
              { userId: "u30" as never, displayName: "Alex" },
            ],
          }}
          readOnly={false}
          onDraftChange={vi.fn()}
          onSend={vi.fn().mockResolvedValue(undefined)}
          onSent={vi.fn()}
        />,
      ),
    );

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "@A" } });
    const u9 = screen.getByRole("option", { name: "Alex, user u9" });
    const u30 = screen.getByRole("option", { name: "Alex, user u30" });
    expect(u9).toBeInTheDocument();
    expect(u30).toBeInTheDocument();
    const u9Circle = u9.querySelector("circle");
    const u30Circle = u30.querySelector("circle");
    expect(u9Circle).toBeInTheDocument();
    expect(u30Circle).toBeInTheDocument();
    expect(u9Circle).toHaveAttribute("stroke");
    expect(u30Circle).toHaveAttribute("stroke");
    if (!u9Circle || !u30Circle) throw new Error("autocomplete identity sigils are missing");
    expect(u9Circle.getAttribute("stroke")).not.toBe(u30Circle.getAttribute("stroke"));
  });

  test("keyboard and pointer selection preserve the caret and full-ID names", () => {
    const local = {
      kind: "local" as const,
      candidates: [
        { userId: "same-1" as never, displayName: "Alex" },
        { userId: "same-2" as never, displayName: "Alex" },
      ],
    };
    render(
      wrap(
        <ChatComposer
          inputId="selection-chat"
          label="Message"
          placeholder="Say"
          sendLabel="Send"
          draft={draft}
          source={local}
          readOnly={false}
          onDraftChange={vi.fn()}
          onSend={vi.fn().mockResolvedValue(undefined)}
          onSent={vi.fn()}
        />,
      ),
    );
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "@A" } });
    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(input).toHaveAttribute("aria-controls");
    expect(input).toHaveAttribute("aria-activedescendant");
    const options = screen.getAllByRole("option");
    expect(input).toHaveAttribute("aria-activedescendant", options[0]!.id);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(options[1]).toHaveAttribute("aria-selected", "false");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input).toHaveAttribute("aria-activedescendant", options[1]!.id);
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    expect(options[0]).toHaveAttribute("aria-selected", "false");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", options[0]!.id);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.keyUp(input, { key: "Escape" });
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "@A" } });
    fireEvent.pointerDown(screen.getAllByRole("option")[1]!);
    act(() => vi.runAllTimers());
    expect(screen.getByRole("combobox")).toHaveFocus();
  });

  test("Tab chooses the active option and touch selection keeps the input focused", () => {
    const onDraftChange = vi.fn();
    const local = {
      kind: "local" as const,
      candidates: [{ userId: "touch-user" as never, displayName: "Touch" }],
    };
    function Harness() {
      const [current, setCurrent] = useState<ChatDraft>(draft);
      return (
        <ChatComposer
          inputId="selection-chat"
          label="Message"
          placeholder="Say"
          sendLabel="Send"
          draft={current}
          source={local}
          readOnly={false}
          onDraftChange={(next) => {
            onDraftChange(next);
            setCurrent(next);
          }}
          onSend={vi.fn().mockResolvedValue(undefined)}
          onSent={vi.fn()}
        />
      );
    }
    render(wrap(<Harness />));
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "@To" } });
    fireEvent.keyDown(input, { key: "Tab" });
    fireEvent.keyUp(input, { key: "Tab" });
    expect(onDraftChange).toHaveBeenCalledWith(expect.objectContaining({ text: "@Touch " }));
    expect(screen.queryByRole("option")).not.toBeInTheDocument();

    onDraftChange.mockClear();
    fireEvent.change(input, { target: { value: "@To" } });
    expect(screen.getByRole("option", { name: /Touch/ })).toBeInTheDocument();
    fireEvent.touchStart(screen.getByRole("option"));
    act(() => vi.runAllTimers());
    expect(onDraftChange).toHaveBeenCalledWith(expect.objectContaining({ text: "@Touch " }));
    expect(input).toHaveFocus();
  });

  test("pointer and touch selection restore the exact trailing-space caret", () => {
    const local = {
      kind: "local" as const,
      candidates: [{ userId: "caret-user" as never, displayName: "Alice" }],
    };
    function Harness() {
      const [current, setCurrent] = useState<ChatDraft>({ text: "say @Al", mentions: [] });
      return (
        <ChatComposer
          inputId="caret-chat"
          label="Message"
          placeholder="Say"
          sendLabel="Send"
          draft={current}
          source={local}
          readOnly={false}
          onDraftChange={setCurrent}
          onSend={vi.fn().mockResolvedValue(undefined)}
          onSent={vi.fn()}
        />
      );
    }

    const pointerView = render(wrap(<Harness />));
    const pointerInput = screen.getByRole("combobox") as HTMLInputElement;
    pointerInput.setSelectionRange(7, 7);
    fireEvent.pointerDown(screen.getByRole("option"));
    act(() => vi.runAllTimers());
    expect(pointerInput).toHaveValue("say @Alice ");
    expect(pointerInput.selectionStart).toBe(11);
    expect(pointerInput.selectionEnd).toBe(11);
    pointerView.unmount();

    render(wrap(<Harness />));
    const touchInput = screen.getByRole("combobox") as HTMLInputElement;
    touchInput.setSelectionRange(7, 7);
    fireEvent.touchStart(screen.getByRole("option"));
    act(() => vi.runAllTimers());
    expect(touchInput).toHaveValue("say @Alice ");
    expect(touchInput.selectionStart).toBe(11);
    expect(touchInput.selectionEnd).toBe(11);
  });

  test("announces result count and active option through combobox relationships", () => {
    render(
      wrap(
        <ChatComposer
          inputId="announcement-chat"
          label="Message"
          placeholder="Say"
          sendLabel="Send"
          draft={draft}
          source={{
            kind: "local",
            candidates: [
              { userId: "one" as never, displayName: "One" },
              { userId: "two" as never, displayName: "Two" },
            ],
          }}
          readOnly={false}
          onDraftChange={vi.fn()}
          onSend={vi.fn().mockResolvedValue(undefined)}
          onSent={vi.fn()}
        />,
      ),
    );
    const input = screen.getByRole("combobox", { name: "Message" });
    fireEvent.change(input, { target: { value: "@O" } });
    const listbox = screen.getByRole("listbox");
    const option = screen.getByRole("option", { name: /One, user one/ });
    expect(input).toHaveAttribute("aria-controls", listbox.id);
    expect(input).toHaveAttribute("aria-activedescendant", option.id);
    expect(option).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("1 results")).toBeInTheDocument();
  });

  test("success clears only after resolve and rejection reports through onError without changing draft", async () => {
    const send = deferred<void>();
    const onError = vi.fn();
    const onInvalidMention = vi.fn();
    const onSent = vi.fn();
    const rejected = vi.fn().mockRejectedValue(new ApiError("INVALID_MENTION"));
    let restoreDraft!: () => void;
    let rejectNext = false;
    function Harness() {
      const [current, setCurrent] = useState<ChatDraft>({
        text: "@Alice ",
        mentions: [{ userId: "alice" as never, start: 0, length: 6 }],
      });
      restoreDraft = () =>
        setCurrent({
          text: "@Alice ",
          mentions: [{ userId: "alice" as never, start: 0, length: 6 }],
        });
      return (
        <ChatComposer
          inputId="remote-chat"
          label="Message"
          placeholder="Say"
          sendLabel="Send"
          draft={current}
          source={remoteSource}
          readOnly={false}
          onDraftChange={setCurrent}
          onSend={() => (rejectNext ? rejected() : send.promise)}
          onSent={onSent}
          onError={onError}
          onInvalidMention={onInvalidMention}
        />
      );
    }
    render(wrap(<Harness />));
    const input = screen.getByRole("combobox");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(input).toHaveValue("@Alice ");
    expect(onSent).not.toHaveBeenCalled();
    await act(async () => send.resolve());
    expect(input).toHaveValue("");
    expect(onSent).toHaveBeenCalledTimes(1);

    rejectNext = true;
    act(restoreDraft);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send" })));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onError).toHaveBeenCalled();
    expect(onInvalidMention).toHaveBeenCalled();
    expect(screen.getByRole("combobox")).toHaveValue("@Alice ");
  });

  test("composer renders no error region even after a failed send", async () => {
    const onSend = vi.fn().mockRejectedValue(new ApiError("PHASE_CLOSED"));
    render(
      wrap(
        <ChatComposer
          inputId="chat"
          label="Message"
          placeholder="Say"
          sendLabel="Send"
          draft={{ text: "hello", mentions: [] }}
          source={source}
          readOnly={false}
          onDraftChange={vi.fn()}
          onSend={onSend}
          onSent={vi.fn()}
        />,
      ),
    );
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send" })));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("Escape closes an in-flight query and ignores its late response", async () => {
    const response = deferred<typeof remoteCandidates>();
    remoteSource.search.mockReturnValueOnce(response.promise);
    renderControlledComposer({ source: remoteSource });
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "@Ali" } });
    act(() => vi.advanceTimersByTime(200));
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.keyUp(input, { key: "Escape" });
    expect(input).toHaveAttribute("aria-expanded", "false");
    act(() => vi.advanceTimersByTime(200));
    expect(remoteSource.search).toHaveBeenCalledTimes(1);
    await act(async () => response.resolve([remoteCandidates[1]!, remoteCandidates[0]!]));
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "@Alin" } });
    act(() => vi.advanceTimersByTime(200));
    expect(remoteSource.search).toHaveBeenCalledTimes(2);
    expect(remoteSource.search).toHaveBeenLastCalledWith("Alin", expect.any(AbortSignal));
  });

  test("plain @text stays ordinary and recent IDs reorder only current results", async () => {
    const response = deferred<typeof remoteCandidates>();
    remoteSource.search.mockReturnValueOnce(response.promise);
    renderControlledComposer({ source: remoteSource });
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "@Ali" } });
    act(() => vi.advanceTimersByTime(200));
    await act(async () => response.resolve([remoteCandidates[1]!, remoteCandidates[0]!]));
    expect(screen.getAllByRole("option")[0]).toHaveAccessibleName("Alice, user alice");
    expect(screen.getAllByRole("option")).toHaveLength(2);

    render(wrap(<ChatBubble author="Ana" mine={false} text="plain @Alice" />));
    expect(screen.getByText("plain @Alice")).not.toHaveAttribute("data-mention");
  });

  test("remote loading is a status row, not an option", () => {
    renderControlledComposer({ source: remoteSource });
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "@Ali" } });
    act(() => vi.advanceTimersByTime(200));
    const listbox = screen.getByRole("listbox");
    expect(listbox).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Searching people…");
    expect(listbox).not.toContainElement(screen.getByRole("status"));
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  test("remote resolution after unmount is ignored", async () => {
    const response = deferred<typeof remoteCandidates>();
    remoteSource.search.mockReturnValueOnce(response.promise);
    const view = renderControlledComposer({ source: remoteSource });
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "@Ali" } });
    act(() => vi.advanceTimersByTime(200));
    view.unmount();
    await act(async () => response.resolve(remoteCandidates));
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  test("remote responses cannot repopulate after a source transition to local", async () => {
    const response = deferred<typeof remoteCandidates>();
    remoteSource.search.mockReturnValueOnce(response.promise);
    const local = {
      kind: "local" as const,
      candidates: [{ userId: "local" as never, displayName: "Alice" }],
    };
    let setSource!: (next: typeof remoteSource | typeof local) => void;
    function Harness() {
      const [currentSource, updateSource] = useState<typeof remoteSource | typeof local>(
        remoteSource,
      );
      const [current, setCurrent] = useState<ChatDraft>(draft);
      setSource = updateSource;
      return (
        <ChatComposer
          inputId="transition-chat"
          label="Message"
          placeholder="Say"
          sendLabel="Send"
          draft={current}
          source={currentSource}
          readOnly={false}
          onDraftChange={setCurrent}
          onSend={vi.fn().mockResolvedValue(undefined)}
          onSent={vi.fn()}
        />
      );
    }
    render(wrap(<Harness />));
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "@Ali" } });
    act(() => vi.advanceTimersByTime(200));
    act(() => setSource(local));
    expect(screen.getByRole("option", { name: /Alice, user local/ })).toBeInTheDocument();
    await act(async () => response.resolve(remoteCandidates));
    expect(screen.queryByRole("option", { name: /Alice, user alice/ })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Alice, user local/ })).toBeInTheDocument();
  });

  test("lookup does not disable sending, but read-only, empty, and over-limit drafts do", () => {
    const pending = deferred<typeof remoteCandidates>();
    remoteSource.search.mockReturnValue(pending.promise);
    renderControlledComposer({
      source: remoteSource,
      initialDraft: { text: "@Ali", mentions: [] },
    });
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  });

  test("read-only, canonical-empty, and over-limit drafts disable send independently", () => {
    const cases = [
      { readOnly: true, draft: { text: "hello", mentions: [] as ChatDraft["mentions"] } },
      { readOnly: false, draft: { text: " ", mentions: [] as ChatDraft["mentions"] } },
      {
        readOnly: false,
        draft: { text: "x".repeat(2_001), mentions: [] as ChatDraft["mentions"] },
      },
    ];
    for (const [index, current] of cases.entries()) {
      const view = render(
        wrap(
          <ChatComposer
            inputId={`disabled-${index}`}
            label="Message"
            placeholder="Say"
            sendLabel="Send"
            draft={current.draft}
            source={source}
            readOnly={current.readOnly}
            onDraftChange={vi.fn()}
            onSend={vi.fn().mockResolvedValue(undefined)}
            onSent={vi.fn()}
          />,
        ),
      );
      expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
      view.unmount();
    }
  });

  test("malformed structured ranges stay plain and do not claim viewer mention", () => {
    render(
      wrap(
        <ChatBubble
          author="Ana"
          mine={false}
          viewerId={"viewer" as UserId}
          text="hello"
          mentions={[{ userId: "viewer" as UserId, start: 99, length: 4 }]}
        />,
      ),
    );
    expect(screen.queryByText("Mentioned you")).not.toBeInTheDocument();
    expect(screen.queryByRole("presentation", { name: "Mentioned you" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("mention")).not.toBeInTheDocument();
  });

  test("concurrent submits call send and onSent once, then recover after rejection", async () => {
    const first = deferred<void>();
    const second = vi.fn().mockRejectedValue(new Error("retry"));
    const onSent = vi.fn();
    const onError = vi.fn();
    const onDraftChange = vi.fn();
    let useFirst = true;
    render(
      wrap(
        <ChatComposer
          inputId="pending-chat"
          label="Message"
          placeholder="Say"
          sendLabel="Send"
          draft={{ text: "hello", mentions: [] }}
          source={source}
          readOnly={false}
          onDraftChange={onDraftChange}
          onSend={() => {
            if (useFirst) return first.promise;
            return second();
          }}
          onSent={onSent}
          onError={onError}
        />,
      ),
    );
    const send = screen.getByRole("button", { name: "Send" });
    fireEvent.click(send);
    fireEvent.click(send);
    expect(onDraftChange).not.toHaveBeenCalled();
    await act(async () => first.resolve());
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(onDraftChange).toHaveBeenCalledTimes(1);

    useFirst = false;
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "retry" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send" })));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  });

  test("combined pointer and touch events select only once", () => {
    const onDraftChange = vi.fn();
    render(
      wrap(
        <ChatComposer
          inputId="dedupe-chat"
          label="Message"
          placeholder="Say"
          sendLabel="Send"
          draft={draft}
          source={{ kind: "local", candidates: [{ userId: "one" as never, displayName: "One" }] }}
          readOnly={false}
          onDraftChange={onDraftChange}
          onSend={vi.fn().mockResolvedValue(undefined)}
          onSent={vi.fn()}
        />,
      ),
    );
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "@On" } });
    onDraftChange.mockClear();
    const option = screen.getByRole("option");
    fireEvent.pointerDown(option);
    fireEvent.touchStart(option);
    expect(onDraftChange).toHaveBeenCalledTimes(1);
  });

  test("selection dedupe resets after the pointer and touch burst", () => {
    let replaceDraft!: (next: ChatDraft) => void;
    function Harness() {
      const [current, setCurrent] = useState<ChatDraft>(draft);
      replaceDraft = setCurrent;
      return (
        <ChatComposer
          inputId="repeat-chat"
          label="Message"
          placeholder="Say"
          sendLabel="Send"
          draft={current}
          source={{ kind: "local", candidates: [{ userId: "one" as never, displayName: "One" }] }}
          readOnly={false}
          onDraftChange={setCurrent}
          onSend={vi.fn().mockResolvedValue(undefined)}
          onSent={vi.fn()}
        />
      );
    }
    render(wrap(<Harness />));
    const input = screen.getByRole("combobox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "@On" } });
    const option = screen.getByRole("option");
    fireEvent.pointerDown(option);
    fireEvent.touchStart(option);
    act(() => vi.advanceTimersByTime(300));
    act(() => replaceDraft({ text: "@On", mentions: [] }));
    const repeatInput = screen.getByRole("combobox") as HTMLInputElement;
    repeatInput.setSelectionRange(3, 3);
    fireEvent.select(repeatInput);
    expect(screen.getByRole("option")).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole("option"));
    expect(repeatInput).toHaveValue("@One ");
  });

  test("local no-prefix text closes the query until a valid edit", () => {
    const local = {
      kind: "local" as const,
      candidates: [{ userId: "moon" as never, displayName: "Moon" }],
    };
    let setSource!: (next: typeof local) => void;
    function Harness() {
      const [currentSource, updateSource] = useState<typeof local>({
        kind: "local",
        candidates: [],
      });
      const [current, setCurrent] = useState<ChatDraft>(draft);
      setSource = updateSource;
      return (
        <ChatComposer
          inputId="ordinary-chat"
          label="Message"
          placeholder="Say"
          sendLabel="Send"
          draft={current}
          source={currentSource}
          readOnly={false}
          onDraftChange={setCurrent}
          onSend={vi.fn().mockResolvedValue(undefined)}
          onSent={vi.fn()}
        />
      );
    }
    render(wrap(<Harness />));
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "@Moon thanks" } });
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    act(() =>
      setSource({
        kind: "local",
        candidates: [{ userId: "moon thanks" as never, displayName: "Moon thanks" }],
      }),
    );
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "@Mo" } });
    expect(screen.getByRole("option", { name: /Moon thanks/ })).toBeInTheDocument();
  });
});
