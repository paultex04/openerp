'use client';

/**
 * Dual-Rail Navigation State & Persistence Store.
 *
 * Manages active domain selection, drawer pinned/flyout state, favorites list,
 * and recent history tracking with localStorage persistence.
 */
import React, { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';

export interface FavoriteItem {
  href: string;
  label: string;
  iconName?: string;
}

export interface RecentItem {
  href: string;
  label: string;
  timestamp: number;
}

interface DualRailContextType {
  isPinned: boolean;
  togglePin: () => void;
  setPinned: (pinned: boolean) => void;
  activeDomain: string;
  setActiveDomain: (domain: string) => void;
  flyoutOpen: boolean;
  setFlyoutOpen: (open: boolean) => void;
  favorites: FavoriteItem[];
  toggleFavorite: (item: { href: string; label: string; iconName?: string }) => void;
  isFavorite: (href: string) => boolean;
  recents: RecentItem[];
  addRecent: (item: { href: string; label: string }) => void;
  clearRecents: () => void;
}

const PINNED_STORAGE_KEY = 'openerp_nav_pinned';
const FAVORITES_STORAGE_KEY = 'openerp_nav_favorites';
const RECENTS_STORAGE_KEY = 'openerp_nav_recents';

const DEFAULT_FAVORITES: FavoriteItem[] = [
  { href: '/operations', label: 'Job Management', iconName: 'ListChecks' },
  { href: '/timesheets?tab=enter', label: 'Enter Time', iconName: 'Clock' },
  { href: '/tasks', label: 'Tasks', iconName: 'ListTodo' },
];

const DualRailContext = createContext<DualRailContextType | null>(null);

export function DualRailProvider({ children }: { children: React.ReactNode }) {
  // Pinned state (default true on desktop, persisted in localStorage)
  const [isPinned, setIsPinned] = useState<boolean>(true);
  const [activeDomain, setActiveDomain] = useState<string>('operations');
  const [flyoutOpen, setFlyoutOpen] = useState<boolean>(false);
  const [favorites, setFavorites] = useState<FavoriteItem[]>(DEFAULT_FAVORITES);
  const [recents, setRecents] = useState<RecentItem[]>([]);
  const [isHydrated, setIsHydrated] = useState<boolean>(false);

  // Initialize from localStorage on client mount
  useEffect(() => {
    try {
      const storedPinned = localStorage.getItem(PINNED_STORAGE_KEY);
      if (storedPinned !== null) {
        setIsPinned(storedPinned === 'true');
      } else if (typeof window !== 'undefined' && window.innerWidth < 1280) {
        setIsPinned(false);
      }

      const storedFavs = localStorage.getItem(FAVORITES_STORAGE_KEY);
      if (storedFavs) {
        setFavorites(JSON.parse(storedFavs));
      }

      const storedRecents = localStorage.getItem(RECENTS_STORAGE_KEY);
      if (storedRecents) {
        setRecents(JSON.parse(storedRecents));
      }
    } catch {
      // Ignore localStorage errors (private browsing, quotas)
    } finally {
      setIsHydrated(true);
    }
  }, []);

  const togglePin = useCallback(() => {
    setIsPinned((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(PINNED_STORAGE_KEY, String(next));
      } catch {}
      return next;
    });
  }, []);

  const setPinned = useCallback((pinned: boolean) => {
    setIsPinned(pinned);
    try {
      localStorage.setItem(PINNED_STORAGE_KEY, String(pinned));
    } catch {}
  }, []);

  const toggleFavorite = useCallback((item: { href: string; label: string; iconName?: string }) => {
    setFavorites((prev) => {
      const exists = prev.some((f) => f.href === item.href);
      const next = exists
        ? prev.filter((f) => f.href !== item.href)
        : [...prev, { href: item.href, label: item.label, iconName: item.iconName }];
      try {
        localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  const isFavorite = useCallback(
    (href: string) => favorites.some((f) => f.href === href),
    [favorites],
  );

  const addRecent = useCallback((item: { href: string; label: string }) => {
    // Avoid logging generic or empty paths
    if (!item.href || item.href === '/login' || item.href === '/_not-found') return;

    setRecents((prev) => {
      // Remove existing occurrence to promote to top
      const filtered = prev.filter((r) => r.href !== item.href);
      const updated = [{ href: item.href, label: item.label, timestamp: Date.now() }, ...filtered].slice(0, 5);
      try {
        localStorage.setItem(RECENTS_STORAGE_KEY, JSON.stringify(updated));
      } catch {}
      return updated;
    });
  }, []);

  const clearRecents = useCallback(() => {
    setRecents([]);
    try {
      localStorage.removeItem(RECENTS_STORAGE_KEY);
    } catch {}
  }, []);

  // Keyboard shortcut Ctrl+[ or [ to toggle pin
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === '[') {
        e.preventDefault();
        togglePin();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [togglePin]);

  const value = useMemo(
    () => ({
      isPinned: isHydrated ? isPinned : true,
      togglePin,
      setPinned,
      activeDomain,
      setActiveDomain,
      flyoutOpen,
      setFlyoutOpen,
      favorites,
      toggleFavorite,
      isFavorite,
      recents,
      addRecent,
      clearRecents,
    }),
    [
      isHydrated,
      isPinned,
      togglePin,
      setPinned,
      activeDomain,
      flyoutOpen,
      favorites,
      toggleFavorite,
      isFavorite,
      recents,
      addRecent,
      clearRecents,
    ],
  );

  return <DualRailContext.Provider value={value}>{children}</DualRailContext.Provider>;
}

export function useDualRail() {
  const context = useContext(DualRailContext);
  if (!context) {
    throw new Error('useDualRail must be used within a DualRailProvider.');
  }
  return context;
}
