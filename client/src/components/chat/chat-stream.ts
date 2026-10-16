'use client';

/**
 * The live chat channel, as a hook.
 *
 * `EventSource` is the right tool here: it reconnects on its own with the server's
 * `retry` hint, it sends the session cookie on a same-origin URL without any
 * header plumbing, and it survives the Next Route Handler proxy (a WebSocket
 * upgrade would not). It cannot set custom headers, which is exactly why the
 * cookie-only auth of the API suits it.
 *
 * The hook reports status rather than hiding it: `closed` is how the provider
 * knows to fall back to polling. `onEvent` is held in a ref so a caller that
 * re-creates its handler every render does not tear the connection down and
 * rebuild it on each pass.
 */
import { useEffect, useRef, useState } from 'react';
import type { ChatStreamEvent, ChatStreamStatus } from '@/lib/api';

const EVENT_NAMES = ['ready', 'message', 'read', 'typing', 'presence'] as const;

export function useChatStream(
  enabled: boolean,
  onEvent: (event: ChatStreamEvent) => void,
): ChatStreamStatus {
  const [status, setStatus] = useState<ChatStreamStatus>('closed');
  const handlerRef = useRef(onEvent);

  useEffect(() => {
    handlerRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    if (!enabled) {
      setStatus('closed');
      return;
    }

    setStatus('connecting');
    const source = new EventSource('/api/chat/stream', { withCredentials: true });

    const handleFrame = (message: MessageEvent<string>) => {
      try {
        handlerRef.current(JSON.parse(message.data) as ChatStreamEvent);
      } catch (error) {
        // A frame we cannot parse is dropped; the next one may still be fine.
        void error;
      }
    };
    const handleOpen = () => setStatus('open');
    // Also fires for the automatic reconnect, so this is conservative: the
    // provider polls until the channel is genuinely back.
    const handleError = () => setStatus('closed');

    for (const name of EVENT_NAMES) {
      source.addEventListener(name, handleFrame as EventListener);
    }
    source.addEventListener('open', handleOpen);
    source.addEventListener('error', handleError);

    return () => {
      for (const name of EVENT_NAMES) {
        source.removeEventListener(name, handleFrame as EventListener);
      }
      source.removeEventListener('open', handleOpen);
      source.removeEventListener('error', handleError);
      source.close();
      setStatus('closed');
    };
  }, [enabled]);

  return status;
}
