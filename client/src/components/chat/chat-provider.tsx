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
 * ## Polling first, streaming later
 *
 * Step 1 delivers new messages by refetching on an interval. That is deliberate:
 * it works through the existing same-origin proxy with no new failure modes, and
 * it is exactly what the SSE step falls back *to*. The interval is short while a
 * conversation is open - someone is waiting for a reply - and long otherwise,
 * because the badge only needs to be roughly right.
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
  type ChatConversation,
  type ChatConversationResponse,
  type ChatConversationsResponse,
  type ChatMessage,
  type ChatMessageResponse,
  type ChatMessagesResponse,
  type ChatUser,
  type ChatUsersResponse,
} from '@/lib/api';
import { toast } from '@/components/ui/toast';

/** How often the conversation list (and so the badge) refreshes. */
const LIST_POLL_MS = 8000;
/** How often an open thread refreshes. Shorter: a reply is expected. */
const THREAD_POLL_MS = 4000;
/** Messages per page. Also the batch size for "load earlier". */
const PAGE_SIZE = 50;

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
  openWith: (userId: number) => void;
  opening: boolean;
  directory: ChatUser[];
  directoryLoading: boolean;
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

  // The newest message we have already told the server we read, per conversation.
  // Without it the "mark read" effect would fire on every poll while the server's
  // answer was still in flight.
  const lastMarkedRef = useRef<{ conversationId: number; messageId: number } | null>(null);

  const conversationsQuery = useQuery({
    queryKey: ['chat', 'conversations'],
    queryFn: () => api.get<ChatConversationsResponse>('/api/chat/conversations'),
    enabled,
    refetchInterval: enabled ? LIST_POLL_MS : false,
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
    refetchInterval: enabled && activeId !== null ? THREAD_POLL_MS : false,
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

  // A new conversation starts a fresh page history.
  useEffect(() => {
    setOlder([]);
    setHasOlder(false);
    lastMarkedRef.current = null;
  }, [activeId]);

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
    },
    [activeId, sendMutation],
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
      openWith: (userId: number) => openMutation.mutate(userId),
      opening: openMutation.isPending,
      directory: directoryQuery.data?.users ?? EMPTY_USERS,
      directoryLoading: directoryQuery.isLoading,
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
      openMutation,
      directoryQuery.data,
      directoryQuery.isLoading,
    ],
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}
