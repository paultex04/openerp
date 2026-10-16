'use client';

/**
 * Chat state for the whole shell.
 *
 * ## Why a provider rather than per-component queries
 *
 * The dock lives in the shell and survives navigation, and the full-page
 * `/messages` view renders the same data. Both read the one cache, so opening a
 * conversation in the dock and then visiting the page neither refetches nor,
 * worse, disagrees about what is unread.
 *
 * ## Live stream, polling as the fallback
 *
 * Step 1 delivered new messages by refetching on an interval. Step 2 opens an SSE
 * stream (`/api/chat/stream`) and lets it drive updates: a `message` event appends
 * to the open thread and refreshes the list, `read` refreshes the "Seen" state,
 * `typing` and `presence` are held here. The intervals are *not* removed — they are
 * the fallback the design always promised. While the stream is open they stretch
 * to a slow safety net (a frame could be missed across a proxy restart); the
 * moment it closes they snap back to the step-1 cadence.
 *
 * ## Unread is derived
 *
 * Nothing is tracked as "read" on the client. A message is unread until the
 * server says it is not, and marking read is a request the moment a conversation
 * is open and carries unread messages. That keeps the count honest across tabs
 * and devices without a client-side ledger to drift.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  api,
  apiUpload,
  type ChatConversation,
  type ChatConversationResponse,
  type ChatConversationsResponse,
  type ChatMessage,
  type ChatMessageResponse,
  type ChatMessagesResponse,
  type ChatStreamEvent,
  type ChatStreamStatus,
  type ChatUser,
  type ChatUsersResponse,
} from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { useChatStream } from '@/components/chat/chat-stream';
import { useChatDockOpen } from '@/lib/shell-preferences';

/** How often the conversation list (and so the badge) refreshes while polling. */
const LIST_POLL_MS = 8000;
/** How often an open thread refreshes while polling. Shorter: a reply is expected. */
const THREAD_POLL_MS = 4000;
/**
 * The same intervals once the stream is open: a slow safety net, not the primary
 * mechanism. A missed frame costs at most this long of staleness.
 */
const STREAM_LIST_POLL_MS = 30_000;
const STREAM_THREAD_POLL_MS = 20_000;
/** Messages per page. Also the batch size for "load earlier". */
const PAGE_SIZE = 50;
/** At most one typing ping per window, so a fast typist is not a request flood. */
const TYPING_THROTTLE_MS = 2000;
/** How long a "typing" signal is shown before it is assumed stale. */
const TYPING_TTL_MS = 4000;

// Module-level constants so an empty list keeps a stable identity. A fresh `[]`
// every render would be a changed dependency on every pass.
const EMPTY_CONVERSATIONS: ChatConversation[] = [];
const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_USERS: ChatUser[] = [];

interface ChatContextValue {
  /** The signed-in account's id, so the thread can right-align its own messages. */
  selfId: number | null;
  conversations: ChatConversation[];
  conversationsLoading: boolean;
  unreadTotal: number;
  activeId: number | null;
  activeConversation: ChatConversation | null;
  selectConversation: (id: number | null) => void;
  /** History for the active conversation, oldest-first, with older pages prepended. */
  messages: ChatMessage[];
  messagesLoading: boolean;
  loadingOlder: boolean;
  hasOlder: boolean;
  loadOlder: () => void;
  sending: boolean;
  send: (body: string) => Promise<void>;
  /** Uploads an image, with an optional caption, to the active conversation. */
  sendAttachment: (file: File, body: string) => Promise<void>;
  /** True while an image upload is in flight. */
  sendingAttachment: boolean;
  /** Deletes the whole conversation, for both members. Final and not undoable. */
  deleteConversation: (conversationId: number) => void;
  /** True while a delete is in flight. */
  deletingConversation: boolean;
  openWith: (userId: number) => void;
  opening: boolean;
  directory: ChatUser[];
  directoryLoading: boolean;
  /** Whether the SSE channel is up. `closed` means the list/thread are polling. */
  streamStatus: ChatStreamStatus;
  isOnline: (userId: number) => boolean;
  /** Whether the other member is typing in this conversation. */
  isTyping: (conversationId: number) => boolean;
  /** Call on each keystroke; throttled and self-stopping, so it is safe to spam. */
  notifyTyping: () => void;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function useChat(): ChatContextValue {
  const value = useContext(ChatContext);
  if (!value) throw new Error('useChat must be used within a ChatProvider.');
  return value;
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function ChatProvider({
  enabled,
  selfId,
  children,
}: {
  /** False for an account without `chat.read`; every query stays idle. */
  enabled: boolean;
  selfId: number | null;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const [activeId, setActiveId] = useState<number | null>(null);
  const [older, setOlder] = useState<ChatMessage[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);
  const [online, setOnline] = useState<Set<number>>(() => new Set());
  const [typing, setTyping] = useState<Record<number, number>>({});

  // The newest message we have already told the server we read, per conversation.
  // Without it the "mark read" effect would fire on every poll while the server's
  // answer was still in flight.
  const lastMarkedRef = useRef<{ conversationId: number; messageId: number } | null>(null);

  // Per-conversation timers that expire a stale "typing" signal if the sender's
  // explicit stop never arrives (they closed the tab mid-sentence).
  const typingTimers = useRef<Map<number, number>>(new Map());
  // Throttle and idle-stop for the outbound typing signal.
  const lastTypingSentRef = useRef(0);
  const typingStopRef = useRef<number | null>(null);

  // The open conversation, readable from the stream callback without making the
  // callback depend on `activeId` (which would rebuild the stream on every switch).
  const activeIdRef = useRef<number | null>(null);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  // Opening the dock supplies the user gesture the browser wants before it will
  // ask about notifications, so the click that opens chat is what asks.
  const [, setDockOpen] = useChatDockOpen();

  /**
   * A desktop notification for a message that arrived while the user was looking
   * somewhere else. Silent when the tab is already showing that very
   * conversation, which is the case the in-app thread covers.
   */
  const notifyIncoming = useCallback(
    (message: ChatMessage) => {
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      if (message.senderId === selfId) return;
      const focusedHere =
        document.visibilityState === 'visible' && activeIdRef.current === message.conversationId;
      if (focusedHere) return;
      const notification = new Notification(message.senderName, {
        body: message.body || (message.attachment ? 'Sent an image' : 'New message'),
        tag: `chat-${message.conversationId}`,
      });
      notification.addEventListener('click', () => {
        window.focus();
        setDockOpen(true);
        setActiveId(message.conversationId);
        notification.close();
      });
    },
    [selfId, setDockOpen],
  );

  /**
   * Removes a conversation from the client's view entirely: the list entry, any
   * history it holds, and the selection if it was the open one. Used both when
   * this account deletes it and when the other member does.
   */
  const forgetConversation = useCallback(
    (conversationId: number) => {
      queryClient.setQueryData<ChatConversationsResponse>(['chat', 'conversations'], (previous) =>
        previous
          ? {
              conversations: previous.conversations.filter(
                (conversation) => conversation.id !== conversationId,
              ),
            }
          : previous,
      );
      queryClient.removeQueries({ queryKey: ['chat', 'messages', conversationId] });
      setActiveId((current) => (current === conversationId ? null : current));
    },
    [queryClient],
  );

  const handleStreamEvent = useCallback(
    (event: ChatStreamEvent) => {
      switch (event.type) {
        case 'ready':
          setOnline(new Set(event.online));
          break;
        case 'presence':
          setOnline((current) => {
            const next = new Set(current);
            if (event.online) next.add(event.userId);
            else next.delete(event.userId);
            return next;
          });
          break;
        case 'message':
          // Append only to a thread we already hold. Creating an entry here would
          // seed a one-message history that react-query would then treat as fresh,
          // so opening the conversation would show a single bubble.
          queryClient.setQueryData<ChatMessagesResponse>(
            ['chat', 'messages', event.conversationId],
            (previous) => {
              if (!previous) return previous;
              if (previous.messages.some((message) => message.id === event.message.id)) {
                return previous;
              }
              return { messages: [...previous.messages, event.message] };
            },
          );
          void queryClient.invalidateQueries({ queryKey: ['chat', 'conversations'] });
          notifyIncoming(event.message);
          break;
        case 'read':
          // The peer's watermark moved; the list carries `peerLastReadAt`, so a
          // refetch is enough to turn the newest own message into "Seen".
          void queryClient.invalidateQueries({ queryKey: ['chat', 'conversations'] });
          break;
        case 'deleted':
          // The other member deleted the whole conversation. Drop it locally now
          // rather than waiting for a poll to notice it is gone.
          forgetConversation(event.conversationId);
          break;
        case 'typing': {
          const { conversationId, userId, isTyping } = event;
          const existingTimer = typingTimers.current.get(conversationId);
          if (existingTimer !== undefined) window.clearTimeout(existingTimer);
          setTyping((current) => {
            const next = { ...current };
            if (isTyping) next[conversationId] = userId;
            else delete next[conversationId];
            return next;
          });
          if (isTyping) {
            const timer = window.setTimeout(() => {
              typingTimers.current.delete(conversationId);
              setTyping((current) => {
                const next = { ...current };
                delete next[conversationId];
                return next;
              });
            }, TYPING_TTL_MS);
            typingTimers.current.set(conversationId, timer);
          } else {
            typingTimers.current.delete(conversationId);
          }
          break;
        }
      }
    },
    [queryClient, notifyIncoming, forgetConversation],
  );

  const streamStatus = useChatStream(enabled, handleStreamEvent);
  const streaming = streamStatus === 'open';

  const conversationsQuery = useQuery({
    queryKey: ['chat', 'conversations'],
    queryFn: () => api.get<ChatConversationsResponse>('/api/chat/conversations'),
    enabled,
    refetchInterval: enabled ? (streaming ? STREAM_LIST_POLL_MS : LIST_POLL_MS) : false,
    // Coming back to the tab should show the badge immediately, not in 8s.
    refetchOnWindowFocus: true,
  });

  const conversations = conversationsQuery.data?.conversations ?? EMPTY_CONVERSATIONS;

  const messagesQuery = useQuery({
    queryKey: ['chat', 'messages', activeId],
    queryFn: () =>
      api.get<ChatMessagesResponse>(`/api/chat/conversations/${activeId}/messages`, {
        limit: PAGE_SIZE,
      }),
    enabled: enabled && activeId !== null,
    refetchInterval:
      enabled && activeId !== null ? (streaming ? STREAM_THREAD_POLL_MS : THREAD_POLL_MS) : false,
  });

  const latest = messagesQuery.data?.messages ?? EMPTY_MESSAGES;
  const messages = useMemo(() => (older.length ? [...older, ...latest] : latest), [older, latest]);

  const directoryQuery = useQuery({
    queryKey: ['chat', 'users'],
    queryFn: () => api.get<ChatUsersResponse>('/api/chat/users'),
    enabled,
    // The account directory changes rarely; no need to poll it.
    staleTime: 5 * 60 * 1000,
  });

  // A new conversation starts a fresh page history and forgets any typing timer.
  useEffect(() => {
    setOlder([]);
    setHasOlder(false);
    lastMarkedRef.current = null;
    lastTypingSentRef.current = 0;
    if (typingStopRef.current !== null) {
      window.clearTimeout(typingStopRef.current);
      typingStopRef.current = null;
    }
  }, [activeId]);

  // Drop every timer on unmount so a late callback cannot set state on a gone tree.
  useEffect(() => {
    const timers = typingTimers.current;
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
      if (typingStopRef.current !== null) window.clearTimeout(typingStopRef.current);
    };
  }, []);

  // Whether there is more history to the left is read off the page the server
  // just returned: a full page implies there may be older messages.
  useEffect(() => {
    if (messagesQuery.data) setHasOlder(messagesQuery.data.messages.length >= PAGE_SIZE);
  }, [messagesQuery.data]);

  const selectedConversation =
    conversations.find((conversation) => conversation.id === activeId) ?? null;

  // Mark read when the open conversation carries unread messages from someone
  // else. Keyed on the newest message id so a reply that arrives while the panel
  // is open is marked too, without re-firing for a message already acknowledged.
  useEffect(() => {
    if (activeId === null) return;
    const conversation = conversations.find((c) => c.id === activeId);
    const newest = conversation?.lastMessage?.id ?? null;
    if (!conversation || conversation.unreadCount === 0 || newest === null) return;

    const marked = lastMarkedRef.current;
    if (marked?.conversationId === activeId && marked.messageId >= newest) return;
    lastMarkedRef.current = { conversationId: activeId, messageId: newest };

    void api
      .post(`/api/chat/conversations/${activeId}/read`)
      .then(() => queryClient.invalidateQueries({ queryKey: ['chat', 'conversations'] }))
      .catch(() => {
        // Leave the marker in place; the next poll retries once a new message
        // arrives. A failed mark-read is not worth an interruption.
      });
  }, [activeId, conversations, queryClient]);

  const stopTyping = useCallback(() => {
    if (activeId === null) return;
    if (typingStopRef.current !== null) {
      window.clearTimeout(typingStopRef.current);
      typingStopRef.current = null;
    }
    lastTypingSentRef.current = 0;
    void api
      .post(`/api/chat/conversations/${activeId}/typing`, { isTyping: false })
      .catch(() => undefined);
  }, [activeId]);

  const notifyTyping = useCallback(() => {
    if (activeId === null) return;
    const now = Date.now();
    if (now - lastTypingSentRef.current >= TYPING_THROTTLE_MS) {
      lastTypingSentRef.current = now;
      void api
        .post(`/api/chat/conversations/${activeId}/typing`, { isTyping: true })
        .catch(() => undefined);
    }
    // Restart the idle countdown: if no keystroke follows, say we stopped.
    if (typingStopRef.current !== null) window.clearTimeout(typingStopRef.current);
    typingStopRef.current = window.setTimeout(() => {
      lastTypingSentRef.current = 0;
      void api
        .post(`/api/chat/conversations/${activeId}/typing`, { isTyping: false })
        .catch(() => undefined);
    }, TYPING_TTL_MS);
  }, [activeId]);

  const sendMutation = useMutation({
    mutationFn: ({ conversationId, body }: { conversationId: number; body: string }) =>
      api.post<ChatMessageResponse>(`/api/chat/conversations/${conversationId}/messages`, {
        body,
        clientToken: crypto.randomUUID(),
      }),
    onSuccess: (data, variables) => {
      // Append straight away so the sender sees the message now, rather than at
      // the next poll. The id check keeps a poll that already delivered it from
      // duplicating the bubble.
      queryClient.setQueryData<ChatMessagesResponse>(
        ['chat', 'messages', variables.conversationId],
        (previous) => {
          const existing = previous?.messages ?? [];
          if (existing.some((m) => m.id === data.message.id))
            return previous ?? { messages: existing };
          return { messages: [...existing, data.message] };
        },
      );
      void queryClient.invalidateQueries({ queryKey: ['chat', 'conversations'] });
    },
    onError: (error) =>
      toast.add({
        title: 'Message not sent',
        description: messageOf(error, 'Try again.'),
        type: 'error',
      }),
  });

  const send = useCallback(
    async (body: string) => {
      if (activeId === null) return;
      try {
        await sendMutation.mutateAsync({ conversationId: activeId, body });
      } catch {
        // Already surfaced by `onError`; the composer keeps the text so it is not
        // lost. Nothing to do here.
      }
      // Sending ends the typing state, whatever the outcome.
      stopTyping();
    },
    [activeId, sendMutation, stopTyping],
  );

  const attachmentMutation = useMutation({
    mutationFn: ({
      conversationId,
      file,
      body,
    }: {
      conversationId: number;
      file: File;
      body: string;
    }) => {
      const form = new FormData();
      form.append('file', file, file.name);
      if (body) form.append('body', body);
      return apiUpload<ChatMessageResponse>(
        `/api/chat/conversations/${conversationId}/attachments`,
        form,
      );
    },
    onSuccess: (data, variables) => {
      // Same append-and-dedupe as a text send: show it now, and let the stream or
      // a poll recognise the same id rather than adding a second bubble.
      queryClient.setQueryData<ChatMessagesResponse>(
        ['chat', 'messages', variables.conversationId],
        (previous) => {
          const existing = previous?.messages ?? [];
          if (existing.some((m) => m.id === data.message.id))
            return previous ?? { messages: existing };
          return { messages: [...existing, data.message] };
        },
      );
      void queryClient.invalidateQueries({ queryKey: ['chat', 'conversations'] });
    },
    onError: (error) =>
      toast.add({
        title: 'Image not sent',
        description: messageOf(error, 'Try again.'),
        type: 'error',
      }),
  });

  const deleteMutation = useMutation({
    mutationFn: (conversationId: number) =>
      api.delete<{ deleted: true }>(`/api/chat/conversations/${conversationId}`),
    onSuccess: (_, conversationId) => {
      // Remove it from the local list at once; the stream confirms with
      // 'deleted', or a poll will within seconds.
      forgetConversation(conversationId);
      queryClient.invalidateQueries({ queryKey: ['chat', 'conversations'] });
      toast.add({
        title: 'Conversation deleted',
        description: 'It is gone for both people and cannot be recovered.',
        type: 'warning',
      });
    },
    onError: (error) =>
      toast.add({
        title: 'Could not delete the conversation',
        description: messageOf(error, 'Try again.'),
        type: 'error',
      }),
  });

  const sendAttachment = useCallback(
    async (file: File, body: string) => {
      if (activeId === null) return;
      try {
        await attachmentMutation.mutateAsync({ conversationId: activeId, file, body });
      } catch {
        // Surfaced by `onError`.
      }
      stopTyping();
    },
    [activeId, attachmentMutation, stopTyping],
  );

  const deleteConversation = useCallback(
    (conversationId: number) => void deleteMutation.mutate(conversationId),
    [deleteMutation],
  );

  const openMutation = useMutation({
    mutationFn: (userId: number) =>
      api.post<ChatConversationResponse>('/api/chat/conversations', { userId }),
    onSuccess: (data) => {
      queryClient.setQueryData<ChatConversationsResponse>(['chat', 'conversations'], (previous) => {
        const list = previous?.conversations ?? [];
        const rest = list.filter((c) => c.id !== data.conversation.id);
        return { conversations: [data.conversation, ...rest] };
      });
      setActiveId(data.conversation.id);
    },
    onError: (error) =>
      toast.add({
        title: 'Could not open the conversation',
        description: messageOf(error, 'Try again.'),
        type: 'error',
      }),
  });

  const loadOlder = useCallback(() => {
    if (activeId === null) return;
    const oldest = older[0] ?? latest[0];
    if (!oldest) return;

    setLoadingOlder(true);
    api
      .get<ChatMessagesResponse>(`/api/chat/conversations/${activeId}/messages`, {
        limit: PAGE_SIZE,
        before: oldest.id,
      })
      .then((response) => {
        if (response.messages.length === 0) {
          setHasOlder(false);
          return;
        }
        setOlder((previous) => [...response.messages, ...previous]);
        if (response.messages.length < PAGE_SIZE) setHasOlder(false);
      })
      .catch(() => undefined)
      .finally(() => setLoadingOlder(false));
  }, [activeId, latest, older]);

  const unreadTotal = useMemo(
    () => conversations.reduce((total, conversation) => total + conversation.unreadCount, 0),
    [conversations],
  );

  const isOnline = useCallback((userId: number) => online.has(userId), [online]);
  const isTyping = useCallback(
    (conversationId: number) => typing[conversationId] !== undefined,
    [typing],
  );

  const value = useMemo<ChatContextValue>(
    () => ({
      selfId,
      conversations,
      conversationsLoading: conversationsQuery.isLoading,
      unreadTotal,
      activeId,
      activeConversation: selectedConversation,
      selectConversation: setActiveId,
      messages,
      messagesLoading: messagesQuery.isLoading,
      loadingOlder,
      hasOlder,
      loadOlder,
      sending: sendMutation.isPending,
      send,
      sendAttachment,
      sendingAttachment: attachmentMutation.isPending,
      deleteConversation,
      deletingConversation: deleteMutation.isPending,
      openWith: (userId: number) => openMutation.mutate(userId),
      opening: openMutation.isPending,
      directory: directoryQuery.data?.users ?? EMPTY_USERS,
      directoryLoading: directoryQuery.isLoading,
      streamStatus,
      isOnline,
      isTyping,
      notifyTyping,
    }),
    [
      selfId,
      conversations,
      conversationsQuery.isLoading,
      unreadTotal,
      activeId,
      selectedConversation,
      messages,
      messagesQuery.isLoading,
      loadingOlder,
      hasOlder,
      loadOlder,
      sendMutation.isPending,
      send,
      sendAttachment,
      attachmentMutation.isPending,
      deleteMutation,
      deleteConversation,
      openMutation,
      directoryQuery.data,
      directoryQuery.isLoading,
      streamStatus,
      isOnline,
      isTyping,
      notifyTyping,
    ],
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}
