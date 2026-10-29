import { CHAT_CLEAR_COMMAND, type ChatState, type RepoView } from "@blackwall/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, sendChat } from "../../api";
import { canSendChat, clearNeedsConfirm, freshIds, isClearCommand, needsCardId } from "../../chat";
import { commonPrefixLength } from "../../chat-stream";
import { useDraft } from "../../drafts";
import { chatQuery, queryKeys, tasksQuery } from "../../query";
import { errorMessage } from "../../settings-forms";
import { useChatFlavour } from "../use-chat-flavour";

/** Within this many px of the bottom, the log follows new messages. */
const FOLLOW_SLACK_PX = 24;

/**
 * Which messages fade in: those appended after the chat first rendered with data. Fresh assistant
 * replies reveal instead, from `streamFrom`: where the draft shown before them stopped.
 */
export interface FadeState {
  seen: ReadonlySet<string>;
  fading: ReadonlySet<string>;
  streamFrom: ReadonlyMap<string, number>;
  /** The streamed draft as last shown, for the reply that replaces it. */
  lastDraft: string | null;
  /** How much of a draft shows at once: all of one already streaming when the chat loaded. */
  draftFrom: number;
}

export type ChatConversation = ReturnType<typeof useChatConversation>;

/**
 * One chat's state, shared by the side panel's repo chat and a task page's task channel: the
 * conversation, its draft, sending and clearing, and the log's fade and follow state.
 */
export function useChatConversation(
  repo: RepoView,
  /** The task whose own conversation this is; undefined for the repo chat. */
  taskId: string | undefined,
) {
  const queryClient = useQueryClient();
  const chat = useQuery(chatQuery(repo.id, taskId));
  const tasks = useQuery(tasksQuery);
  const repoTasks = (tasks.data ?? []).filter((t) => t.repoId === repo.id);
  const [draft, setDraft, clearDraft] = useDraft(
    taskId ? `task:${taskId}:chat` : `repo:${repo.id}:chat`,
  );
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  /** Set while the Stop and clear dialog is open; `fromDraft` when `/clear` was typed. */
  const [confirmClear, setConfirmClear] = useState<{ fromDraft: boolean } | null>(null);
  const [fade, setFade] = useState<FadeState | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const following = useRef(true);

  const state = chat.data;
  const messages = state?.messages;
  const busy = state?.busy ?? false;
  const liveDraft = state?.draft ?? null;

  // Seed the seen ids on the first render with data, so history shows without fading.
  if (messages) {
    if (fade === null) {
      setFade({
        seen: new Set(messages.map((m) => m.id)),
        fading: new Set(),
        streamFrom: new Map(),
        lastDraft: liveDraft,
        draftFrom: liveDraft?.length ?? 0,
      });
    } else {
      const fresh = freshIds(messages, fade.seen);
      if (fresh.length > 0) {
        const streamFrom = new Map(fade.streamFrom);
        for (const m of messages) {
          if (m.role !== "assistant" || !fresh.includes(m.id)) continue;
          streamFrom.set(m.id, fade.lastDraft ? commonPrefixLength(fade.lastDraft, m.text) : 0);
        }
        setFade({
          seen: new Set([...fade.seen, ...fresh]),
          fading: new Set([...fade.fading, ...fresh]),
          streamFrom,
          lastDraft: liveDraft,
          draftFrom: 0,
        });
      } else if (liveDraft !== fade.lastDraft) {
        setFade({ ...fade, lastDraft: liveDraft });
      }
    }
  }

  const count = messages?.length ?? 0;
  const activity = state?.activity ?? null;
  const flavour = useChatFlavour(busy, activity);
  useEffect(() => {
    if (following.current) end.current?.scrollIntoView({ block: "end" });
  }, [count, activity, busy, liveDraft]);

  /** Keeps the log at the bottom while a reply reveals, unless the user scrolled up. */
  const onGrow = useCallback(() => {
    if (following.current) end.current?.scrollIntoView({ block: "end" });
  }, []);

  /** Follows new messages only while the log is scrolled to the bottom. */
  function onScroll() {
    const el = log.current;
    if (el) {
      following.current = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX;
    }
  }

  function scrollToEnd() {
    following.current = true;
    end.current?.scrollIntoView({ block: "end" });
  }

  async function post(text: string): Promise<void> {
    setSending(true);
    setSendError(null);
    try {
      const next = await sendChat(repo.id, text, taskId);
      queryClient.setQueryData<ChatState>(queryKeys.chat(repo.id, taskId), next);
      scrollToEnd();
    } catch (cause) {
      throw new Error(
        cause instanceof ApiError && cause.status === 409
          ? "The chat is still answering. Wait, or send /clear."
          : errorMessage(cause),
        { cause },
      );
    } finally {
      setSending(false);
    }
  }

  async function sendDraft() {
    if (!canSendChat(draft, busy) || sending) return;
    if (isClearCommand(draft) && clearNeedsConfirm(busy)) {
      setConfirmClear({ fromDraft: true });
      return;
    }
    try {
      await post(draft.trim());
      clearDraft();
    } catch (error) {
      setSendError(errorMessage(error));
    }
  }

  async function clear() {
    if (clearNeedsConfirm(busy)) {
      setConfirmClear({ fromDraft: false });
      return;
    }
    try {
      await post(CHAT_CLEAR_COMMAND);
    } catch (error) {
      setSendError(errorMessage(error));
    }
  }

  const canClear = busy || count > 0;
  const needsId = messages ? needsCardId(messages, repoTasks, repo.id) : null;

  return {
    repo,
    taskId,
    chat,
    repoTasks,
    draft,
    setDraft,
    clearDraft,
    sending,
    sendError,
    setSendError,
    confirmClear,
    setConfirmClear,
    fade,
    log,
    end,
    onScroll,
    messages,
    busy,
    liveDraft,
    count,
    flavour,
    onGrow,
    post,
    sendDraft,
    clear,
    canClear,
    needsId,
  };
}
