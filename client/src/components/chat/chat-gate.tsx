'use client';

/**
 * Supplies chat to the shell and its pages.
 *
 * A thin client wrapper around `ChatProvider` so the authenticated layout can
 * stay a server component: the provider needs the resolved session (to know
 * whether chat is even available, and who "me" is), and only a client component
 * can read that. The account-without-`chat.read` case is handled here rather than
 * by every consumer, so a role that cannot chat simply never mounts the queries.
 */
import type { ReactNode } from 'react';
import { usePermissions } from '@/components/auth/usePermissions';
import { ChatProvider } from '@/components/chat/chat-provider';

export function ChatGate({ children }: { children: ReactNode }) {
  const { canAny, user } = usePermissions();
  return (
    <ChatProvider enabled={canAny('chat.read')} selfId={user?.user.id ?? null}>
      {children}
    </ChatProvider>
  );
}
