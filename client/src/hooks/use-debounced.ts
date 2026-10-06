'use client';

/**
 * Debounces a rapidly-changing value.
 *
 * Exists because two screens now type into a search box that queries the server:
 * the jobs register and the service-code picker. Both need the same guarantee — one
 * query per pause in typing, not one per keystroke — and both would otherwise each
 * grow their own timer with their own delay.
 *
 * The timer is cleared on every change, so only the last value in a burst is
 * delivered. Cleanup on unmount matters here more than usual: the job register's
 * search survives navigating away and back, and a timer firing into an unmounted
 * component is the classic React warning.
 */
import { useEffect, useState } from 'react';

export function useDebounced<T>(value: T, delay = 300): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return settled;
}
