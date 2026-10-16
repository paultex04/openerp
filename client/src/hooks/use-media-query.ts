'use client';

/**
 * Reports whether a CSS media query currently matches.
 *
 * `useSyncExternalStore` rather than `useState` + an effect: the server snapshot
 * is a fixed `false`, so the first paint is deterministic and React swaps in the
 * real value at hydration. An effect-based version renders one frame of the wrong
 * branch, which is visible as the chat dock jumping from drawer to pinned.
 */
import { useCallback, useSyncExternalStore } from 'react';

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );

  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
