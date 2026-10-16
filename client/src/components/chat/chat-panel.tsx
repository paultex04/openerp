'use client';

/**
 * The chat surface, shared by the dock and the full-page view.
 *
 * One component rather than two so the two placements cannot drift: the dock
 * shows one pane at a time (a list, then a thread with a back button), while
 * `/messages` shows both side by side. The pieces are the same pieces.
 *
 * The list is filtered on the client and, from step 3, the box also asks the
 * server to search message bodies. Both are shown: conversation names match
 * instantly from the loaded list because that costs nothing, and matching
 * messages arrive a moment later from `/api/chat/search`.
 */
import { useQuery } from '@tanstack/react-query';
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { ArrowLeft, ImagePlus, MessageSquarePlus, Search, SendHorizontal } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { ChatAvatar } from '@/components/chat/chat-avatar';
import { useChat } from '@/components/chat/chat-provider';
import { cn } from '@/lib/utils';
import { api, type ChatConversation, type ChatMessage, type ChatSearchResponse } from '@/lib/api';

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});

function shortTime(iso: string): string {
  return timeFormat.format(new Date(iso));
}

function longTime(iso: string): string {
  return timeFormat.format(new Date(iso));
}

function dayLabel(iso: string): string {
  return dayFormat.format(new Date(iso));
}

function sameDay(a: string, b: string): boolean {
  return a.slice(0, 10) === b.slice(0, 10);
}

function CenteredSpinner() {
  return (
    <div className="flex flex-1 items-center justify-center py-8">
      <Spinner className="size-5 text-muted-foreground" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}

export function ChatPanel({ variant = 'dock' }: { variant?: 'dock' | 'page' }) {
  const chat = useChat();
  const [showDirectory, setShowDirectory] = useState(false);

  if (variant === 'page') {
    return (
      <div className="flex min-h-0 flex-1 gap-4">
        <section className="flex w-80 shrink-0 flex-col overflow-hidden rounded-xl border bg-card">
          <ListPane showDirectory={showDirectory} setShowDirectory={setShowDirectory} />
        </section>
        <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card">
          {chat.activeId ? <Thread /> : <NothingSelected />}
        </section>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {chat.activeId ? (
        <Thread onBack={() => chat.selectConversation(null)} />
      ) : (
        <ListPane showDirectory={showDirectory} setShowDirectory={setShowDirectory} />
      )}
    </div>
  );
}

function ListPane({
  showDirectory,
  setShowDirectory,
}: {
  showDirectory: boolean;
  setShowDirectory: Dispatch<SetStateAction<boolean>>;
}) {
  const [search, setSearch] = useState('');
  const chat = useChat();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b p-3">
        <h2 className="text-sm font-semibold">{showDirectory ? 'New message' : 'Messages'}</h2>
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          aria-label={showDirectory ? 'Back to conversations' : 'Start a new conversation'}
          onClick={() => setShowDirectory((value) => !value)}
        >
          {showDirectory ? <ArrowLeft aria-hidden /> : <MessageSquarePlus aria-hidden />}
        </Button>
      </div>

      <div className="shrink-0 border-b p-3">
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={showDirectory ? 'Search people…' : 'Search conversations…'}
            className="pl-7"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {showDirectory ? (
          <DirectoryList
            search={search}
            onPick={(userId) => {
              chat.openWith(userId);
              setShowDirectory(false);
            }}
          />
        ) : (
          <>
            <MessageMatches search={search} onPick={chat.selectConversation} />
            <ConversationRows search={search} />
          </>
        )}
      </div>
    </div>
  );
}

/** A short input delay so a fast typist issues one search, not one per key. */
function useDebounced(value: string, delay: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/**
 * Message search results, from the server, above the conversation list.
 *
 * Two characters is the floor the API enforces, and it doubles as the point at
 * which the box stops being "filter the list" and starts being "search".
 */
function MessageMatches({
  search,
  onPick,
}: {
  search: string;
  onPick: (conversationId: number) => void;
}) {
  const term = useDebounced(search.trim(), 250);
  const enabled = term.length >= 2;
  const query = useQuery({
    queryKey: ['chat', 'search', term],
    queryFn: () => api.get<ChatSearchResponse>('/api/chat/search', { q: term }),
    enabled,
    // A search is a lookup, not a subscription; the answer is worth a minute.
    staleTime: 60_000,
  });

  if (!enabled) return null;
  const results = query.data?.results ?? [];

  return (
    <div className="border-b">
      <p className="px-3 pt-2 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        Messages
      </p>
      {query.isLoading ? (
        <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
          <Spinner className="size-3.5" />
          Searching…
        </div>
      ) : results.length === 0 ? (
        <p className="p-3 text-xs text-muted-foreground">No matching messages.</p>
      ) : (
        <ul className="flex flex-col gap-0.5 p-1">
          {results.map((result) => (
            <li key={result.message.id}>
              <button
                type="button"
                onClick={() => onPick(result.conversationId)}
                className={cn(
                  'flex w-full flex-col rounded-lg p-2 text-left',
                  'hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                )}
              >
                <span className="flex w-full items-baseline gap-2">
                  <span className="truncate text-xs font-medium">{result.peer.name}</span>
                  <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                    {shortTime(result.message.createdAt)}
                  </span>
                </span>
                <span className="line-clamp-2 text-xs text-muted-foreground">
                  {result.message.body || (result.message.attachment ? 'Image' : '')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ConversationRows({ search }: { search: string }) {
  const chat = useChat();

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return chat.conversations;
    return chat.conversations.filter((conversation) =>
      conversation.peer.name.toLowerCase().includes(term),
    );
  }, [chat.conversations, search]);

  if (chat.conversationsLoading) return <CenteredSpinner />;

  if (rows.length === 0) {
    return (
      <Empty className="border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MessageSquarePlus aria-hidden />
          </EmptyMedia>
          <EmptyTitle>{search ? 'No matches' : 'No conversations yet'}</EmptyTitle>
          <EmptyDescription>
            {search ? 'Try a different name.' : 'Start one with the “new message” button above.'}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <ul className="flex flex-col gap-0.5 p-1">
      {rows.map((conversation) => (
        <li key={conversation.id}>
          <ConversationRow
            conversation={conversation}
            active={chat.activeId === conversation.id}
            own={conversation.lastMessage?.senderId === chat.selfId}
            online={chat.isOnline(conversation.peer.id)}
            onSelect={() => chat.selectConversation(conversation.id)}
          />
        </li>
      ))}
    </ul>
  );
}

function ConversationRow({
  conversation,
  active,
  own,
  online,
  onSelect,
}: {
  conversation: ChatConversation;
  active: boolean;
  own: boolean;
  online: boolean;
  onSelect: () => void;
}) {
  const last = conversation.lastMessage;
  const preview = last
    ? `${own ? 'You: ' : ''}${last.body || (last.attachment ? 'Image' : '')}`
    : 'No messages yet';

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'flex w-full items-center gap-2 rounded-lg p-2 text-left',
        'hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        active && 'bg-muted',
      )}
    >
      <ChatAvatar
        name={conversation.peer.name}
        email={conversation.peer.email}
        avatarUpdatedAt={conversation.peer.avatarUpdatedAt}
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2">
          <span className="flex items-center gap-1.5 truncate text-sm font-medium">
            {conversation.peer.name}
            {online && (
              <span
                className="size-1.5 shrink-0 rounded-full bg-positive"
                role="img"
                aria-label="Online"
              />
            )}
          </span>
          {conversation.lastMessageAt && (
            <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
              {shortTime(conversation.lastMessageAt)}
            </span>
          )}
        </span>
        <span className="flex items-center gap-2">
          <span className="truncate text-xs text-muted-foreground">{preview}</span>
          {conversation.unreadCount > 0 && (
            <Badge className="ml-auto shrink-0">
              {conversation.unreadCount > 99 ? '99+' : conversation.unreadCount}
            </Badge>
          )}
        </span>
      </span>
    </button>
  );
}

function DirectoryList({ search, onPick }: { search: string; onPick: (userId: number) => void }) {
  const chat = useChat();

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return chat.directory;
    return chat.directory.filter(
      (user) => user.name.toLowerCase().includes(term) || user.email.toLowerCase().includes(term),
    );
  }, [chat.directory, search]);

  if (chat.directoryLoading) return <CenteredSpinner />;

  if (rows.length === 0) {
    return (
      <p className="p-4 text-center text-xs text-muted-foreground">
        No people found. Only active accounts can be messaged.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-0.5 p-1">
      {rows.map((user) => (
        <li key={user.id}>
          <button
            type="button"
            onClick={() => onPick(user.id)}
            disabled={chat.opening}
            className={cn(
              'flex w-full items-center gap-2 rounded-lg p-2 text-left',
              'hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
              'disabled:pointer-events-none disabled:opacity-60',
            )}
          >
            <ChatAvatar
              name={user.name}
              email={user.email}
              avatarUpdatedAt={user.avatarUpdatedAt}
            />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium">{user.name}</span>
              <span className="truncate text-[11px] text-muted-foreground">{user.email}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Thread({ onBack }: { onBack?: () => void }) {
  const chat = useChat();
  const conversation = chat.activeConversation;
  const scrollRef = useRef<HTMLDivElement>(null);

  // Jump to the newest message whenever the conversation changes or grows. The
  // container is its own scroll region, so this scrolls the thread, not the app.
  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [chat.messages.length, chat.activeId]);

  if (!conversation) return null;

  // The newest own message is the only one that can carry a "Seen" marker; the
  // peer's watermark is a point in time, so anything at or before it is read.
  const peerReadAt = conversation.peerLastReadAt;
  let lastOwnId: number | null = null;
  for (let index = chat.messages.length - 1; index >= 0; index -= 1) {
    const candidate = chat.messages[index];
    if (candidate && candidate.senderId === chat.selfId) {
      lastOwnId = candidate.id;
      break;
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b p-3">
        {onBack && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Back to conversations"
            onClick={onBack}
          >
            <ArrowLeft aria-hidden />
          </Button>
        )}
        <ChatAvatar
          name={conversation.peer.name}
          email={conversation.peer.email}
          avatarUpdatedAt={conversation.peer.avatarUpdatedAt}
        />
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 truncate text-sm font-semibold">
            {conversation.peer.name}
            {chat.isOnline(conversation.peer.id) && (
              <span
                className="size-2 shrink-0 rounded-full bg-positive"
                role="img"
                aria-label="Online"
              />
            )}
          </p>
          <p className="truncate text-[11px] text-muted-foreground">
            {chat.isTyping(conversation.id) ? 'typing…' : conversation.peer.email}
          </p>
        </div>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-3">
        {chat.hasOlder && (
          <div className="pb-3 text-center">
            <Button
              variant="ghost"
              size="sm"
              disabled={chat.loadingOlder}
              onClick={() => chat.loadOlder()}
            >
              {chat.loadingOlder ? 'Loading…' : 'Load earlier messages'}
            </Button>
          </div>
        )}

        {chat.messagesLoading && chat.messages.length === 0 ? (
          <CenteredSpinner />
        ) : chat.messages.length === 0 ? (
          <p className="py-8 text-center text-xs text-muted-foreground">
            No messages yet. Say hello.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {chat.messages.map((message, index) => {
              const previous = chat.messages[index - 1];
              const showDay = !previous || !sameDay(previous.createdAt, message.createdAt);
              return (
                <Fragment key={message.id}>
                  {showDay && <DaySeparator iso={message.createdAt} />}
                  <MessageBubble
                    message={message}
                    own={message.senderId === chat.selfId}
                    seen={
                      message.id === lastOwnId &&
                      peerReadAt !== null &&
                      message.createdAt <= peerReadAt
                    }
                  />
                </Fragment>
              );
            })}
          </ul>
        )}
      </div>

      <Composer />
    </div>
  );
}

function DaySeparator({ iso }: { iso: string }) {
  return (
    <li className="my-2 flex items-center gap-2 text-[10px] tracking-wide text-muted-foreground uppercase">
      <span className="h-px flex-1 bg-border" />
      {dayLabel(iso)}
      <span className="h-px flex-1 bg-border" />
    </li>
  );
}

function MessageBubble({
  message,
  own,
  seen,
}: {
  message: ChatMessage;
  own: boolean;
  /** The peer has read up to at least this message, and it is the newest own one. */
  seen?: boolean;
}) {
  return (
    <li className={cn('flex items-end gap-2', own ? 'flex-row-reverse' : 'flex-row')}>
      {!own && <ChatAvatar name={message.senderName} className="size-6" />}
      <div
        className={cn(
          'max-w-[78%] rounded-2xl px-3 py-1.5 text-sm',
          own ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground',
        )}
      >
        {message.attachment && (
          // A plain <img>: these bytes come from our own session-scoped route, so
          // the Next image optimiser cannot fetch them (no cookie) and must not
          // be asked to.
          <img
            src={`/api/chat/attachments/${message.attachment.id}`}
            alt={message.attachment.originalName ?? 'Attached image'}
            width={message.attachment.width}
            height={message.attachment.height}
            loading="lazy"
            className="mb-1 max-h-72 rounded-lg"
          />
        )}
        {message.body && <p className="break-words whitespace-pre-wrap">{message.body}</p>}
        <p
          className={cn(
            'mt-0.5 text-right text-[10px]',
            own ? 'text-primary-foreground/70' : 'text-muted-foreground',
          )}
        >
          {longTime(message.createdAt)}
          {seen && <span className="ml-1 font-medium">· Seen</span>}
        </p>
      </div>
    </li>
  );
}

function Composer() {
  const chat = useChat();
  const [value, setValue] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const body = value.trim();
  const busy = chat.sending || chat.sendingAttachment;
  const canSend = body.length > 0 && !busy;

  const submit = () => {
    if (!canSend) return;
    // Clear now: the mutation surfaces a failure through a toast, and holding the
    // text hostage until the round-trip finishes makes typing feel laggy.
    setValue('');
    void chat.send(body);
  };

  const pickImage = (file: File) => {
    // The typed text rides along as the caption, so an image with a note is one
    // message rather than two.
    const caption = value.trim();
    setValue('');
    void chat.sendAttachment(file, caption);
  };

  return (
    <form
      className="flex shrink-0 items-end gap-2 border-t p-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Reset so choosing the same file again still fires a change event.
          event.target.value = '';
          if (file) pickImage(file);
        }}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Attach an image"
        disabled={chat.sendingAttachment}
        onClick={() => fileRef.current?.click()}
      >
        {chat.sendingAttachment ? <Spinner className="size-4" /> : <ImagePlus aria-hidden />}
      </Button>
      <textarea
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          if (event.target.value.trim().length > 0) chat.notifyTyping();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
        rows={1}
        placeholder="Write a message…"
        aria-label="Message"
        className={cn(
          'max-h-32 min-h-9 flex-1 resize-none rounded-lg border border-input bg-transparent',
          'px-2.5 py-2 text-sm outline-none',
          'placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
        )}
      />
      <Button type="submit" size="icon" disabled={!canSend} aria-label="Send message">
        <SendHorizontal aria-hidden />
      </Button>
    </form>
  );
}

function NothingSelected() {
  return (
    <Empty className="border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <MessageSquarePlus aria-hidden />
        </EmptyMedia>
        <EmptyTitle>No conversation selected</EmptyTitle>
        <EmptyDescription>Pick someone on the left, or start a new conversation.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
