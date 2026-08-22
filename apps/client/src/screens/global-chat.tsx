import type { ChatContent, UserId } from "@werewolf/protocol";
import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import type { ChatState } from "../api/chat-state.ts";
import {
  ChatComposer,
  ChatList,
  type ChatViewportSnapshot,
  type MentionCandidateSource,
} from "../chat/index.ts";
import type { MentionCandidate } from "../chat/mentions.ts";
import { type ChatDraft, globalChatRow } from "../chat/model.ts";
import type { ConversationReadState } from "../chat/read-state.ts";

export function GlobalChatScreen({
  state,
  viewerId,
  readState,
  draft,
  candidates,
  mentionSource,
  viewport,
  jumpToLatestToken,
  error,
  onDraftChange,
  onSend,
  onSent,
  onError,
  onInvalidMention,
  onSnapshot,
  onVisible,
  onMarkThrough,
  onLoadOlder,
}: {
  state: ChatState;
  viewerId: UserId;
  readState: ConversationReadState;
  draft: ChatDraft;
  candidates: MentionCandidate[];
  mentionSource: MentionCandidateSource;
  viewport?: ChatViewportSnapshot;
  jumpToLatestToken: number;
  error?: unknown;
  onDraftChange(draft: ChatDraft): void;
  onSend(content: ChatContent): Promise<void>;
  onSent(): void;
  onError(error: unknown): void;
  onInvalidMention(): void;
  onSnapshot(snapshot: ChatViewportSnapshot): void;
  onVisible(ids: number[]): void;
  onMarkThrough(latestId: number): void;
  onLoadOlder(): void;
}) {
  const { t } = useTranslation();
  const messages = state.messages.map(globalChatRow);
  const latestMessages = useRef(messages);
  latestMessages.current = messages;
  const snapshotCaptured = useRef(false);
  const captureSnapshot = useCallback(
    (snapshot: ChatViewportSnapshot) => {
      snapshotCaptured.current = true;
      onSnapshot(snapshot);
    },
    [onSnapshot],
  );
  useEffect(() => {
    return () => {
      if (snapshotCaptured.current || latestMessages.current.length === 0) return;
      const first = latestMessages.current[0]!;
      onSnapshot({
        virtuoso: { ranges: [], scrollTop: 0 },
        messageIds: latestMessages.current.map((message) => message.id),
        anchorId: first.id,
        anchorOffset: 0,
      });
    };
  }, [onSnapshot]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <h1 className="px-4.5 pt-6 pb-4 text-[30px] font-semibold tracking-[-0.03em]">
        {t("ui.globalChat")}
      </h1>
      <ChatList
        conversationKey="global"
        emptyLabel={t("ui.globalChatEmpty")}
        firstItemIndex={state.firstItemIndex}
        hasOlder={state.hasOlder}
        historyTruncated={state.historyTruncated}
        identityCohort={candidates}
        jumpToLatestToken={jumpToLatestToken}
        messages={messages}
        onLoadOlder={onLoadOlder}
        onMarkThrough={onMarkThrough}
        onSnapshot={captureSnapshot}
        onVisible={onVisible}
        readState={readState}
        {...(viewport === undefined ? {} : { snapshot: viewport })}
        viewerId={viewerId}
      />
      <ChatComposer
        className="border-t border-paper/10 bg-bar px-3.5 py-2.5"
        draft={draft}
        error={error}
        inputId="global-chat-message"
        label={t("ui.messageLabel")}
        onDraftChange={onDraftChange}
        onError={onError}
        onInvalidMention={onInvalidMention}
        onSend={onSend}
        onSent={onSent}
        placeholder={t("ui.messagePlaceholder")}
        readOnly={false}
        sendLabel={t("ui.sendMessage")}
        source={mentionSource}
      />
    </div>
  );
}
