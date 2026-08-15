import { act, fireEvent, render, screen } from "@testing-library/react";
import { MessageCircle, Moon, Users } from "lucide-react";
import { afterEach, expect, test, vi } from "vitest";

import {
  AvatarStack,
  ChatBubble,
  ChatComposer,
  Countdown,
  Segmented,
  Stepper,
  TabBar,
  Toggle,
} from "./components.tsx";

afterEach(() => {
  vi.useRealTimers();
});

test("Toggle flips and exposes aria-checked", () => {
  const onChange = vi.fn();
  const { rerender } = render(
    <Toggle checked={false} onChange={onChange} label="Allow spectating" />,
  );
  const toggle = screen.getByRole("switch", { name: "Allow spectating" });
  expect(toggle).toHaveAttribute("aria-checked", "false");

  fireEvent.click(toggle);
  expect(onChange).toHaveBeenCalledWith(true);

  rerender(<Toggle checked={true} onChange={onChange} label="Allow spectating" />);
  expect(screen.getByRole("switch", { name: "Allow spectating" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test("Stepper clamps at min and max and reports its value", () => {
  const onChange = vi.fn();
  const { rerender } = render(
    <Stepper
      label="Discussion"
      value={15}
      onChange={onChange}
      step={15}
      min={15}
      max={600}
      unit="s"
    />,
  );

  const minus = screen.getByRole("button", { name: "Discussion −" });
  const plus = screen.getByRole("button", { name: "Discussion +" });
  expect(minus).toBeDisabled();
  expect(plus).toBeEnabled();
  expect(screen.getByText("15s")).toBeInTheDocument();

  fireEvent.click(plus);
  expect(onChange).toHaveBeenCalledWith(30);
  fireEvent.click(minus); // still disabled at the floor: nothing is sent
  expect(onChange).toHaveBeenCalledTimes(1);

  // At the ceiling the plus button gives up too.
  rerender(
    <Stepper
      label="Discussion"
      value={600}
      onChange={onChange}
      step={15}
      min={15}
      max={600}
      unit="s"
    />,
  );
  expect(screen.getByRole("button", { name: "Discussion +" })).toBeDisabled();
});

test("Countdown renders m:ss, ticks and clamps at 0:00", () => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  // skew = mount(10_000) - serverNow(30_000) = -20_000; remaining at t=10_000 is 100_000ms.
  render(<Countdown endsAt={130_000} serverNow={30_000} />);
  expect(screen.getByText("1:40")).toBeInTheDocument();

  act(() => vi.advanceTimersByTime(30_000));
  expect(screen.getByText("1:10")).toBeInTheDocument();

  act(() => vi.advanceTimersByTime(120_000));
  expect(screen.getByText("0:00")).toBeInTheDocument();

  act(() => vi.advanceTimersByTime(60_000));
  expect(screen.getByText("0:00")).toBeInTheDocument();
});

test("AvatarStack shows +N once names exceed the max", () => {
  const { rerender } = render(<AvatarStack names={["Wren", "Bram", "Odile", "Mattias"]} />);
  expect(screen.getByText("+1")).toBeInTheDocument();

  rerender(<AvatarStack names={["Wren", "Bram", "Odile"]} />);
  expect(screen.queryByText(/^\+/)).not.toBeInTheDocument();
});

test("TabBar marks the current item with aria-current and selects on click", () => {
  const items = [
    { id: "village", label: "Village", icon: Users },
    { id: "talk", label: "Talk", icon: MessageCircle },
    { id: "act", label: "Act", icon: Moon },
  ];
  const onSelect = vi.fn();
  render(<TabBar current="talk" items={items} onSelect={onSelect} />);

  expect(screen.getByRole("button", { name: "Talk" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("button", { name: "Village" })).not.toHaveAttribute("aria-current");

  fireEvent.click(screen.getByRole("button", { name: "Act" }));
  expect(onSelect).toHaveBeenCalledWith("act");
});

test("Segmented reads like a radio group and reports its value", () => {
  const onChange = vi.fn();
  render(
    <Segmented
      label="Visibility"
      onChange={onChange}
      options={[
        { value: "public", label: "Public" },
        { value: "private", label: "Private" },
      ]}
      value="public"
    />,
  );

  expect(screen.getByRole("radio", { name: "Public" })).toBeChecked();
  fireEvent.click(screen.getByRole("radio", { name: "Private" }));
  expect(onChange).toHaveBeenCalledWith("private");
});

test("ChatBubble shows the author for other people's messages", () => {
  render(<ChatBubble author="Ana" mine={false} text="21:00 works" />);

  expect(screen.getByText("Ana")).toBeInTheDocument();
  expect(screen.getByText("21:00 works")).toBeInTheDocument();
});

test("ChatBubble omits the author for your own messages", () => {
  render(<ChatBubble author="Ana" mine={true} text="on my way" />);

  expect(screen.queryByText("Ana")).not.toBeInTheDocument();
  expect(screen.getByText("on my way")).toBeInTheDocument();
});

test("ChatComposer sends the trimmed text and clears the input", () => {
  const sent: string[] = [];
  render(
    <ChatComposer
      className="flex"
      inputId="test-message"
      label="Message"
      onSend={(text) => sent.push(text)}
      placeholder="Say something"
      sendLabel="Send"
    />,
  );

  const input = screen.getByLabelText("Message");
  fireEvent.change(input, { target: { value: "hello" } });
  fireEvent.click(screen.getByLabelText("Send"));

  expect(sent).toEqual(["hello"]);
  expect(input).toHaveValue("");
});

test("ChatComposer ignores a blank message", () => {
  const sent: string[] = [];
  render(
    <ChatComposer
      className="flex"
      inputId="test-message"
      label="Message"
      onSend={(text) => sent.push(text)}
      placeholder="Say something"
      sendLabel="Send"
    />,
  );

  fireEvent.change(screen.getByLabelText("Message"), {
    target: { value: "   " },
  });
  fireEvent.click(screen.getByLabelText("Send"));

  expect(sent).toEqual([]);
});

test("ChatComposer disabled blocks input and sending", () => {
  const sent: string[] = [];
  render(
    <ChatComposer
      className="flex"
      disabled={true}
      inputId="test-message"
      label="Message"
      onSend={(text) => sent.push(text)}
      placeholder="Say something"
      sendLabel="Send"
    />,
  );

  expect(screen.getByLabelText("Message")).toBeDisabled();
  expect(screen.getByLabelText("Send")).toBeDisabled();
});
