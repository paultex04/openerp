'use client';

/**
 * URL-backed state for tabs, views and filters.
 *
 * The sidebar deep-links into screens (`/commercial?tab=rates`), which only works
 * if the screen reads its own state from the URL. Before this, every tab was a
 * `useState` that reset on refresh and could not be linked to or shared.
 *
 * Two deliberate choices:
 *
 *  - `router.replace`, not `push`. Switching a tab is not navigation; pushing
 *    would make the Back button walk through every tab a user has clicked,
 *    which reads as a bug.
 *
 *  - The value is validated against `allowed`. It arrives from a query string, so
 *    it is attacker-controlled. Whitelisting here means an unrecognised value
 *    falls back instead of reaching typed code that assumes it is one of a known
 *    set - the same reason the API validates enums rather than trusting them.
 *
 * Requires a `Suspense` boundary above it, because `useSearchParams` opts a
 * client component out of static prerendering.
 */
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo } from 'react';

export function useUrlParam<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): [T, (next: T) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const value = useMemo(() => {
    const raw = searchParams.get(key);
    return raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
    // `allowed` and `fallback` are module-level constants at every call site, so
    // they are stable; depending on the array identity would recompute per render.
  }, [searchParams, key, fallback]); // eslint-disable-line react-hooks/exhaustive-deps

  const setValue = useCallback(
    (next: T) => {
      const params = new URLSearchParams(searchParams.toString());
      // The fallback is the absence of a parameter, not a literal value. Writing
      // `?tab=contracts` would make the URL disagree with what is on screen when
      // the default changes.
      if (next === fallback) params.delete(key);
      else params.set(key, next);

      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams, key, fallback],
  );

  return [value, setValue];
}
