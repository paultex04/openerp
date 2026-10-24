'use client';

/**
 * Quick Dark / Light Theme Toggle (Phase 6).
 *
 * Provides a single-click Sun / Moon toggle between Light and Dark (midnight) surfaces,
 * complementing the detailed 5-theme swatch picker.
 */
import { Moon, Sun } from 'lucide-react';
import { useCallback, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  applyTheme,
  DARK_THEME,
  DEFAULT_THEME,
  readAppliedTheme,
  subscribeToTheme,
  THEME_STORAGE_KEY,
  type ThemeId,
} from '@/lib/theme';

export function QuickThemeToggle() {
  const current = useSyncExternalStore(subscribeToTheme, readAppliedTheme, () => DEFAULT_THEME);
  const isDark = current === DARK_THEME;

  const toggle = useCallback(() => {
    const next: ThemeId = isDark ? DEFAULT_THEME : DARK_THEME;
    applyTheme(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Ignore private browsing storage denial
    }
  }, [isDark]);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="size-9"
            onClick={toggle}
            aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {isDark ? (
              <Sun className="size-4 text-amber-400 transition-transform duration-200 rotate-0" />
            ) : (
              <Moon className="size-4 text-slate-700 transition-transform duration-200 rotate-0" />
            )}
          </Button>
        }
      />
      <TooltipContent>
        {isDark ? 'Switch to light surface' : 'Switch to dark surface'}
      </TooltipContent>
    </Tooltip>
  );
}
