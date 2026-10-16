'use client';

/**
 * The chat dock: the header toggle and the panel it opens.
 *
 * ## Overlay by default, pinned on request
 *
 * The panel overlays the content unless the user pins it, and pinning only takes
 * effect on a wide screen. That default is deliberate: most screens in this app
 * are full-width tables, and a dock that reflowed them the moment someone sent a
 * message would be a layout bug, not a feature. The pin is the opt-in.
 *
 * The dock is a sibling of `SidebarInset` inside the shell's flex row, so pinned
 * it is a real column that pushes the content; unpinned it is `fixed`, so it
 * leaves the layout untouched.
 */
import { MessageSquare, Pin, PinOff, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ChatPanel } from '@/components/chat/chat-panel';
import { useChat } from '@/components/chat/chat-provider';
import { usePermissions } from '@/components/auth/usePermissions';
import { useMediaQuery } from '@/hooks/use-media-query';
import { useChatDockOpen, useChatDockPinned } from '@/lib/shell-preferences';

/** Where pinning is allowed to take effect. Below this the panel stays an overlay. */
const PIN_BREAKPOINT = '(min-width: 1024px)';

/**
 * The header button that opens the dock, carrying the unread badge.
 *
 * Rendered in the shell's right-hand cluster so it is reachable from every
 * screen. It is a courtesy mirror of the API guard, like every other control in
 * the shell: an account without `chat.read` is not shown it, and would be refused
 * anyway.
 */
export function ChatToggle() {
  const [open, setOpen] = useChatDockOpen();
  const { canAny } = usePermissions();
  const chat = useChat();

  if (!canAny('chat.read')) return null;

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={open ? 'Close messages' : 'Open messages'}
      aria-pressed={open}
      className="relative"
      onClick={() => setOpen(!open)}
    >
      <MessageSquare aria-hidden />
      {chat.unreadTotal > 0 && !open && (
        <span
          aria-label={`${chat.unreadTotal} unread`}
          className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground"
        >
          {chat.unreadTotal > 9 ? '9+' : chat.unreadTotal}
        </span>
      )}
    </Button>
  );
}

export function ChatDock() {
  const [open, setOpen] = useChatDockOpen();
  const [pinned, setPinned] = useChatDockPinned();
  const isWide = useMediaQuery(PIN_BREAKPOINT);
  const { canAny } = usePermissions();

  if (!canAny('chat.read') || !open) return null;

  const docked = pinned && isWide;

  if (docked) {
    return (
      <aside
        aria-label="Messages"
        className="hidden w-[22rem] shrink-0 flex-col border-l bg-background lg:flex"
      >
        <DockHeader
          pinned
          showPin
          onTogglePin={() => setPinned(false)}
          onClose={() => setOpen(false)}
        />
        <ChatPanel />
      </aside>
    );
  }

  return (
    <aside
      aria-label="Messages"
      className="fixed top-14 right-0 bottom-0 z-30 flex w-full max-w-md flex-col border-l bg-background shadow-2xl"
    >
      <DockHeader
        pinned={false}
        showPin={isWide}
        onTogglePin={() => setPinned(true)}
        onClose={() => setOpen(false)}
      />
      <ChatPanel />
    </aside>
  );
}

function DockHeader({
  pinned,
  showPin,
  onTogglePin,
  onClose,
}: {
  pinned: boolean;
  /** Only offer the pin where it can actually dock. */
  showPin: boolean;
  onTogglePin: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
      <MessageSquare aria-hidden="true" className="size-4 text-muted-foreground" />
      <p className="text-sm font-semibold">Messages</p>
      <div className="ml-auto flex items-center gap-1">
        {showPin && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={pinned ? 'Unpin panel' : 'Pin panel beside content'}
            aria-pressed={pinned}
            onClick={onTogglePin}
          >
            {pinned ? <PinOff aria-hidden /> : <Pin aria-hidden />}
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" aria-label="Close messages" onClick={onClose}>
          <X aria-hidden />
        </Button>
      </div>
    </div>
  );
}
