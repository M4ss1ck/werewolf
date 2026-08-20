import type { UserId } from "@werewolf/protocol";
import { useTranslation } from "react-i18next";
import { Virtuoso } from "react-virtuoso";

import type { ChatState } from "../api/chat-state.ts";
import { ChatBubble, ChatComposer, ErrorMessage } from "../components.tsx";

/** The global chat tab: a virtualized message list that pages backwards as the
 * reader scrolls up, with the composer pinned beneath it. */
export function GlobalChatScreen({
  state,
  viewerId,
  error,
  onSend,
  onLoadOlder,
}: {
  state: ChatState;
  viewerId: UserId;
  error?: unknown;
  onSend: (text: string) => void;
  onLoadOlder: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <h1 className="px-4.5 pt-6 pb-4 text-[30px] font-semibold tracking-[-0.03em]">
        {t("ui.globalChat")}
      </h1>
      {state.messages.length === 0 ? (
        <p className="flex-1 px-4.5 text-sm text-fog">{t("ui.globalChatEmpty")}</p>
      ) : (
        <Virtuoso
          className="global-chat-scrollbar flex-1"
          data={state.messages}
          firstItemIndex={state.firstItemIndex}
          followOutput={(isAtBottom) => (isAtBottom ? "smooth" : false)}
          initialTopMostItemIndex={state.messages.length - 1}
          itemContent={(_index, message) => (
            <div className="px-4.5 pb-4">
              <ChatBubble
                author={message.displayName}
                mine={message.userId === viewerId}
                text={message.text}
              />
            </div>
          )}
          startReached={() => {
            if (state.hasOlder) onLoadOlder();
          }}
        />
      )}
      {error ? (
        <div className="px-4.5 pb-2">
          <ErrorMessage error={error} />
        </div>
      ) : null}
      <ChatComposer
        className="flex items-center gap-2.5 border-t border-paper/10 bg-bar px-3.5 py-2.5"
        inputId="global-chat-message"
        label={t("ui.messageLabel")}
        onSend={onSend}
        placeholder={t("ui.messagePlaceholder")}
        sendLabel={t("ui.sendMessage")}
      />
    </div>
  );
}
