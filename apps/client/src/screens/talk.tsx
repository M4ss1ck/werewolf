import type {
  ChatChannel,
  ChatContent,
  GameEvent,
  GameplayCommand,
  ViewerGameSnapshot,
} from "@werewolf/protocol";
import { CHAT_CHANNELS } from "@werewolf/protocol";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { gameMentionCandidates } from "../chat/candidates.ts";
import {
  ChatComposer,
  ChatList,
  type ChatReadStoreController,
  type ChatViewportSnapshot,
} from "../chat/index.ts";
import {
  type ChatDraft,
  type ClientChatMessage,
  type ConversationKey,
  EMPTY_CHAT_DRAFT,
  gameChatRows,
} from "../chat/model.ts";
import { unreadSummary } from "../chat/read-state.ts";
import { Chip } from "../components.tsx";
import { useToast } from "../toast.tsx";

export type GameChatRecord = {
  draft: ChatDraft;
  jumpToLatestToken: number;
  viewport?: ChatViewportSnapshot;
};

function keyFor(gameId: string, channel: ChatChannel): ConversationKey {
  return `game:${gameId}:${channel}` as ConversationKey;
}

function emptyRecords(): Record<ChatChannel, GameChatRecord> {
  return Object.fromEntries(
    CHAT_CHANNELS.map((channel) => [
      channel,
      { draft: EMPTY_CHAT_DRAFT, jumpToLatestToken: 0, viewport: undefined },
    ]),
  ) as unknown as Record<ChatChannel, GameChatRecord>;
}

function channelLabel(channel: ChatChannel, t: (key: string) => string): string {
  if (channel === "public") return t("ui.publicChat");
  if (channel === "wolves") return t("ui.wolfChat");
  if (channel === "cult") return t("ui.cultChat");
  return t("ui.graveChat");
}

/** Design 06 · controlled in-game Talk with one virtualized list and composer. */
export function Talk({
  snapshot,
  events,
  send,
  chatRows: controlledRows,
  activeChannel: controlledChannel,
  records: controlledRecords,
  readStore,
  onChannelChange,
  onDraftChange,
  onSend,
  onError,
  onSnapshot,
  onVisible,
  onMarkThrough,
}: {
  snapshot: ViewerGameSnapshot;
  events?: GameEvent[];
  send?: (command: Omit<GameplayCommand, "commandId">) => Promise<void>;
  chatRows?: Record<ChatChannel, ClientChatMessage[]>;
  activeChannel?: ChatChannel;
  records?: Record<ChatChannel, GameChatRecord>;
  readStore?: ChatReadStoreController;
  onChannelChange?(channel: ChatChannel): void;
  onDraftChange?(draft: ChatDraft): void;
  onSend?(content: ChatContent): Promise<void>;
  onError?(error: unknown): void;
  onSnapshot?(snapshot: ChatViewportSnapshot): void;
  onVisible?(ids: number[]): void;
  onMarkThrough?(latestId: number): void;
}) {
  const { t } = useTranslation();
  const { showError } = useToast();
  const [localChannel, setLocalChannel] = useState<ChatChannel>("public");
  const [localRecords, setLocalRecords] = useState(emptyRecords);
  const activeChannel = controlledChannel ?? localChannel;
  const chatRows = controlledRows ?? gameChatRows(events ?? [], snapshot.players);
  const records = controlledRecords ?? localRecords;
  const changeChannel = onChannelChange ?? setLocalChannel;
  const record = records[activeChannel];
  const changeDraft =
    onDraftChange ??
    ((draft: ChatDraft) => {
      setLocalRecords((current) => ({
        ...current,
        [activeChannel]: { ...current[activeChannel], draft },
      }));
    });
  const sendContent =
    onSend ??
    (async (content: ChatContent) => {
      const phase = snapshot.game.phase;
      if (phase === null || send === undefined) return;
      await send({
        type: "chat.send",
        phaseId: phase.id,
        payload: { channel: activeChannel, ...content },
      });
    });
  const reportError = onError ?? showError;
  const reportSnapshot = onSnapshot ?? (() => undefined);
  const reportVisible = onVisible ?? (() => undefined);
  const reportMarkThrough = onMarkThrough ?? (() => undefined);
  const me = snapshot.me;
  const viewerId = me?.userId ?? ("" as ViewerGameSnapshot["game"]["ownerUserId"]);
  const available = snapshot.availableChannels;
  const readOnly =
    !available.includes(activeChannel) ||
    me === undefined ||
    me.status === "spectator" ||
    (me.status === "dead" && activeChannel !== "grave") ||
    (activeChannel === "public" && snapshot.game.phase?.type === "night");
  const readStates = readStore?.states;
  const summaries = useMemo(
    () =>
      Object.fromEntries(
        CHAT_CHANNELS.map((channel) => [
          channel,
          unreadSummary(
            readStates?.[keyFor(snapshot.game.id, channel)] ?? { readThrough: 0, seenAfter: [] },
            chatRows[channel],
            viewerId,
          ),
        ]),
      ) as Record<ChatChannel, ReturnType<typeof unreadSummary>>,
    [chatRows, readStates, snapshot.game.id, viewerId],
  );
  const candidates = useMemo(
    () => gameMentionCandidates(snapshot, activeChannel),
    [activeChannel, snapshot],
  );
  const source = useMemo(() => ({ kind: "local" as const, candidates }), [candidates]);
  const conversationKey = keyFor(snapshot.game.id, activeChannel);
  const phase = snapshot.game.phase;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex gap-1.5 overflow-x-auto px-4.5 pb-3 pt-1">
        {available.map((channel) => {
          const summary = summaries[channel];
          const label = channelLabel(channel, t);
          return (
            <button
              aria-label={`${label}${summary.count > 0 ? `, ${summary.count}` : ""}${summary.mentioned ? `, ${t("ui.mentionedYou")}` : ""}`}
              aria-pressed={activeChannel === channel}
              className="rounded-full p-0.5"
              key={channel}
              onClick={() => changeChannel(channel)}
              type="button"
            >
              <Chip
                tone={
                  activeChannel === channel
                    ? "active"
                    : channel === "public"
                      ? "neutral"
                      : "running"
                }
              >
                {label}
                {summary.count > 0 && (
                  <span
                    className="ml-1 font-mono text-[11px]"
                    data-mentioned={summary.mentioned || undefined}
                  >
                    {summary.count > 99 ? "99+" : summary.count}
                    {summary.mentioned && <span aria-hidden="true"> @</span>}
                  </span>
                )}
              </Chip>
            </button>
          );
        })}
      </div>
      <ChatList
        conversationKey={conversationKey}
        emptyLabel={t("ui.chatEmpty")}
        identityCohort={candidates}
        jumpToLatestToken={record.jumpToLatestToken}
        key={conversationKey}
        messages={chatRows[activeChannel]}
        onMarkThrough={reportMarkThrough}
        onSnapshot={reportSnapshot}
        onVisible={reportVisible}
        readState={readStates?.[conversationKey] ?? { readThrough: 0, seenAfter: [] }}
        {...(record.viewport === undefined ? {} : { snapshot: record.viewport })}
        viewerId={viewerId}
      />
      <ChatComposer
        className="border-t border-paper/10 bg-bar px-3.5 py-2.5"
        draft={record.draft}
        inputId={`game-${activeChannel}-message`}
        label={t("ui.messageLabel")}
        onDraftChange={changeDraft}
        onError={reportError}
        onSend={async (content) => {
          if (phase === null) throw new Error("PHASE_CLOSED");
          await sendContent(content);
        }}
        onSent={() => undefined}
        placeholder={t("ui.messagePlaceholder")}
        readOnly={readOnly}
        sendLabel={t("ui.sendMessage")}
        source={source}
      />
    </div>
  );
}
