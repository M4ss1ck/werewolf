import type {
  ChatChannel,
  GameEvent,
  GameplayCommand,
  ViewerGameSnapshot,
} from "@werewolf/protocol";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ChatBubble, ChatComposer, Chip, DividerNote } from "../components.tsx";

type Send = (command: Omit<GameplayCommand, "commandId">) => Promise<void>;

/** Design 06 · the Talk tab: channel chips, the message list, the composer. */
export function Talk({
  snapshot,
  events,
  send,
}: {
  snapshot: ViewerGameSnapshot;
  events: GameEvent[];
  send: Send;
}) {
  const { t } = useTranslation();
  const [channel, setChannel] = useState<ChatChannel>("public");
  const me = snapshot.me;
  const readOnly =
    me === undefined ||
    me.status === "dead" ||
    me.status === "spectator" ||
    (channel === "public" && snapshot.game.phase?.type === "night");
  const names = new Map(snapshot.players.map((player) => [player.userId, player.displayName]));
  const myId = me?.userId;
  type ChatRow =
    | Extract<GameEvent, { kind: "chat.message" }>
    | Extract<GameEvent, { kind: "player.eliminated" }>;
  const rows = events.filter(
    (event): event is ChatRow =>
      event.kind === "player.eliminated" ||
      (event.kind === "chat.message" && event.payload.channel === channel),
  );
  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-1.5">
        <button
          aria-pressed={channel === "public"}
          className="rounded-full p-0.5"
          onClick={() => setChannel("public")}
          type="button"
        >
          <Chip tone={channel === "public" ? "active" : "neutral"}>{t("ui.publicChat")}</Chip>
        </button>
        {snapshot.availableChannels.includes("wolves") && (
          <button
            aria-pressed={channel === "wolves"}
            className="rounded-full p-0.5"
            onClick={() => setChannel("wolves")}
            type="button"
          >
            <Chip tone={channel === "wolves" ? "active" : "running"}>
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-blood" />
              {t("ui.wolfChat")}
            </Chip>
          </button>
        )}
      </div>
      <ul className="flex flex-col gap-4">
        {rows.length === 0 ? (
          <li className="text-sm text-fog">{t("ui.chatEmpty")}</li>
        ) : (
          rows.map((event) => {
            if (event.kind === "player.eliminated") {
              return (
                <li key={event.id}>
                  <DividerNote>
                    {t("events.public.player.eliminated", {
                      player: names.get(event.payload.playerId) ?? event.payload.playerId,
                      role: t(`roles.${event.payload.role}.name`),
                    })}
                  </DividerNote>
                </li>
              );
            }
            const mine = event.actorUserId === myId;
            const authorId = event.actorUserId;
            const author = authorId !== undefined ? (names.get(authorId) ?? authorId) : "";
            return (
              <li key={event.id}>
                <ChatBubble author={author} mine={mine} text={event.payload.text} />
              </li>
            );
          })
        )}
      </ul>
      <ChatComposer
        className="sticky bottom-0 -mx-[18px] flex items-center gap-2.5 border-t border-paper/10 bg-bar px-[14px] py-2.5"
        disabled={readOnly}
        inputId="talk-message"
        label={t("ui.messageLabel")}
        onSend={(text) => {
          const phase = snapshot.game.phase;
          if (phase === null) return;
          return send({ type: "chat.send", phaseId: phase.id, payload: { channel, text } });
        }}
        placeholder={t("ui.messagePlaceholder")}
        sendLabel={t("ui.sendMessage")}
      />
    </div>
  );
}
