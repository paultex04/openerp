'use client';

/**
 * Reading browser-held state without a setState-in-effect.
 *
 * The shell needs two values that exist before React does: the sidebar's
 * open/closed cookie and the collapsed-section list in localStorage. The obvious
 * implementation - `useEffect(() => setState(read()), [])` - triggers a
 * cascading re-render on every mount, which the react-hooks lint rules flag for
 * good reason, and it makes the sidebar visibly snap into place after paint.
 *
 * `useSyncExternalStore` is the correct primitive: the store is read during
 * render, the server snapshot keeps the first paint deterministic, and React
 * swaps in the real client value at hydration without a mismatch warning.
 *
 * Writes go through the same module so there is exactly one way to change the
 * value, which is what keeps the notification path honest.
 */
import { useCallback, useSyncExternalStore } from 'react';

/** Where the sidebar open/closed state lives between reloads. */
export const SIDEBAR_COOKIE = 'openerp_sidebar';

/** Where the collapsed navigation section keys live between reloads. */
export const SECTIONS_KEY = 'openerp_sidebar_sections';

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * Subscribes to changes made through this module.
 *
 * Cross-tab updates are deliberately not wired up: the cookie is read from
 * `document.cookie` of this document, and a storage event in another tab is not
 * worth a listener for a preference.
 */
function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

function readSidebarOpen(): boolean {
  const match = new RegExp(`(?:^|; )${SIDEBAR_COOKIE}=([^;]*)`).exec(document.cookie);
  // Default to open. A collapsed rail hides the section labels, and a first-time
  // user would have no cue that more navigation exists.
  return match?.[1] ? match[1] === 'open' : true;
}

function writeSidebarOpen(open: boolean): void {
  document.cookie = `${SIDEBAR_COOKIE}=${open ? 'open' : 'closed'}; path=/; max-age=31536000; samesite=lax`;
  emit();
}

/** The sidebar's persisted open state, safe to render during SSR. */
export function useSidebarOpen(): [boolean, (open: boolean) => void] {
  // The server has no cookie, so it always renders the expanded shell and the
  // client corrects at hydration. Reversing this would make the first paint
  // depend on a value the server cannot see.
  const open = useSyncExternalStore(subscribe, readSidebarOpen, () => true);
  const setOpen = useCallback((next: boolean) => writeSidebarOpen(next), []);
  return [open, setOpen];
}

/**
 * Shared empty result.
 *
 * `useSyncExternalStore` requires `getSnapshot` to return a *cached* value:
 * React compares snapshots by identity, so returning a fresh array literal on
 * every call is indistinguishable from the store having changed, and React
 * re-renders forever. That surfaces as "Maximum update depth exceeded" and takes
 * the whole tree down - which is exactly what happened the first time this was
 * written with inline `[]` literals. See ADR-006, F6.
 */
const NO_SECTIONS_COLLAPSED: readonly string[] = Object.freeze([]);

function readCollapsedSections(): readonly string[] {
  const stored = window.localStorage.getItem(SECTIONS_KEY);
  if (!stored) return NO_SECTIONS_COLLAPSED;
  try {
    const parsed: unknown = JSON.parse(stored);
    // Validated rather than trusted: localStorage is user-writable, and a value
    // that is not a string array would otherwise become a Set of arbitrary keys.
    if (!Array.isArray(parsed) || !parsed.every((key) => typeof key === 'string')) {
      window.localStorage.removeItem(SECTIONS_KEY);
      return NO_SECTIONS_COLLAPSED;
    }
    // `JSON.parse` allocates a new array per call, so the value must be cached by
    // identity for the snapshot comparison to be stable. Comparing the contents
    // against the last read is cheaper than re-reading storage, and keeps React
    // from looping on an unchanged-but-newly-allocated array.
    if (
      parsed.length === lastParsed.length &&
      parsed.every((key, index) => key === lastParsed[index])
    ) {
      return lastParsed;
    }
    lastParsed = parsed as string[];
    return lastParsed;
  } catch {
    // Corrupt JSON is not worth surfacing; fall back to "nothing collapsed".
    window.localStorage.removeItem(SECTIONS_KEY);
    return NO_SECTIONS_COLLAPSED;
  }
}

/** Last value returned by `readCollapsedSections`, for identity caching. */
let lastParsed: readonly string[] = NO_SECTIONS_COLLAPSED;

function writeCollapsedSections(keys: readonly string[]): void {
  try {
    window.localStorage.setItem(SECTIONS_KEY, JSON.stringify(keys));
  } catch {
    // Private-mode storage denial must not break navigation.
  }
  emit();
}

/** Which navigation sections are collapsed, persisted between reloads. */
export function useCollapsedSections(): [ReadonlySet<string>, (key: string) => void] {
  const snapshot = useSyncExternalStore(
    subscribe,
    readCollapsedSections,
    () => NO_SECTIONS_COLLAPSED,
  );
  const collapsed = new Set(snapshot);

  const toggle = useCallback((key: string) => {
    const next = new Set(readCollapsedSections());
    if (next.has(key)) next.delete(key);
    else next.add(key);
    writeCollapsedSections([...next]);
  }, []);

  return [collapsed, toggle];
}

/** Where the chat dock's open/closed state lives between reloads. */
export const CHAT_OPEN_KEY = 'openerp_chat_open';

/** Where the chat dock's pinned state lives between reloads. */
export const CHAT_PINNED_KEY = 'openerp_chat_pinned';

function readFlag(key: string, fallback: boolean): boolean {
  const stored = window.localStorage.getItem(key);
  return stored === null ? fallback : stored === 'true';
}

function writeFlag(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Private-mode storage denial must not break the dock.
  }
  emit();
}

/**
 * Whether the chat dock is open.
 *
 * Closed by default: a conversation panel that opened itself on every page load
 * would be an interruption, and the unread badge on the toggle is what tells the
 * user there is something to open. Booleans are primitives, so the snapshot is
 * stable by value and needs none of the identity caching the section list does.
 */
export function useChatDockOpen(): [boolean, (open: boolean) => void] {
  const open = useSyncExternalStore(
    subscribe,
    () => readFlag(CHAT_OPEN_KEY, false),
    () => false,
  );
  const setOpen = useCallback((next: boolean) => writeFlag(CHAT_OPEN_KEY, next), []);
  return [open, setOpen];
}

/**
 * Whether the dock is pinned beside the content on wide screens.
 *
 * Off by default: pinning reflows every table, so it is a deliberate choice
 * rather than something the app does on first run.
 */
export function useChatDockPinned(): [boolean, (pinned: boolean) => void] {
  const pinned = useSyncExternalStore(
    subscribe,
    () => readFlag(CHAT_PINNED_KEY, false),
    () => false,
  );
  const setPinned = useCallback((next: boolean) => writeFlag(CHAT_PINNED_KEY, next), []);
  return [pinned, setPinned];
}
