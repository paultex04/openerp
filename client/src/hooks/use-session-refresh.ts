'use client';

import { useEffect, useRef } from 'react';
import { api, ApiError } from '@/lib/api';

/**
 * Sliding session refresh interval: every 5 minutes (300,000 ms).
 * JWT access token expires in 15 minutes, so 5 minutes leaves a 10-minute margin.
 */
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/** Minimum cooldown between focus/activity refresh triggers (3 minutes). */
const MIN_ACTIVITY_COOLDOWN_MS = 3 * 60 * 1000;

export function useSessionRefresh() {
  const lastRefreshRef = useRef<number>(Date.now());
  const isRefreshingRef = useRef<boolean>(false);

  useEffect(() => {
    let mounted = true;

    async function triggerRefresh() {
      if (isRefreshingRef.current) return;
      if (typeof navigator !== 'undefined' && !navigator.onLine) return;

      isRefreshingRef.current = true;
      try {
        await api.refreshSession();
        if (mounted) {
          lastRefreshRef.current = Date.now();
        }
      } catch (caught) {
        // If the session has expired after days/hours of inactivity, 401 is returned.
        // Cleanly redirect to /login with an expired notice and preserved destination.
        if (caught instanceof ApiError && caught.status === 401) {
          if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
            const next = encodeURIComponent(window.location.pathname + window.location.search);
            window.location.href = `/login?expired=1&next=${next}`;
            return;
          }
        }
      } finally {
        if (mounted) {
          isRefreshingRef.current = false;
        }
      }
    }

    // 1. Periodic background interval
    const timer = setInterval(() => {
      triggerRefresh();
    }, REFRESH_INTERVAL_MS);

    // 2. Refresh on window focus / tab becoming visible if cooldown elapsed
    function onVisibilityOrFocus() {
      if (document.visibilityState === 'visible') {
        const elapsed = Date.now() - lastRefreshRef.current;
        if (elapsed >= MIN_ACTIVITY_COOLDOWN_MS) {
          triggerRefresh();
        }
      }
    }

    window.addEventListener('focus', onVisibilityOrFocus);
    document.addEventListener('visibilitychange', onVisibilityOrFocus);

    return () => {
      mounted = false;
      clearInterval(timer);
      window.removeEventListener('focus', onVisibilityOrFocus);
      document.removeEventListener('visibilitychange', onVisibilityOrFocus);
    };
  }, []);
}
