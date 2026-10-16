'use client';

/**
 * Messages: the full-page view of the chat the dock shows in miniature.
 *
 * Same components, more room. The page exists because a dock is a poor place to
 * read a long thread or hold two conversations, and because a shareable URL is
 * needed for a link in an email or a bookmark.
 */
import { Alert } from '@/components/ui/alert';
import { usePermissions } from '@/components/auth/usePermissions';
import { ChatPanel } from '@/components/chat/chat-panel';

export default function MessagesPage() {
  const { canAny, loading } = usePermissions();

  if (loading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-6">
        <p className="py-16 text-center text-sm text-muted-foreground">Loading permissions…</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Messages</h1>
        <p className="text-sm text-muted-foreground">
          Direct conversations with the rest of the team. The dock in the header shows the same
          threads from anywhere in the app.
        </p>
      </header>

      {canAny('chat.read') ? (
        <ChatPanel variant="page" />
      ) : (
        <Alert>
          Your account does not have chat access. Ask an administrator for the{' '}
          <code className="font-mono">chat.read</code> permission.
        </Alert>
      )}
    </div>
  );
}
