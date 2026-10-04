'use client';

/**
 * Theme picker.
 *
 * A swatch button in the header that opens a menu of the five themes. Selecting
 * one writes `data-theme` on <html> and persists the choice.
 *
 * Why the write goes straight to the DOM rather than through React state:
 * `data-theme` is a *document* attribute, not component state. Setting it
 * directly restyles the whole tree in one frame with no reconciliation pass and,
 * crucially, no flash - React would have to re-render every consumer of the
 * tokens, which is slower and buys nothing, since no component reads the theme
 * as a value.
 *
 * The local state below exists only so the menu can show which theme is
 * selected, and it is initialised from the attribute the bootstrap script
 * already set, so it is correct on first paint.
 */
import { Check, Palette } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DEFAULT_THEME,
  DARK_THEME,
  THEME_STORAGE_KEY,
  THEMES,
  applyTheme,
  readAppliedTheme,
  subscribeToTheme,
  themeById,
  type ThemeId,
} from '@/lib/theme';
import { useCallback, useSyncExternalStore } from 'react';

export function ThemePicker() {
  /*
   * `useSyncExternalStore` rather than `useState` seeded from the DOM.
   *
   * The bootstrap script puts the theme on <html> before React runs, so reading
   * `dataset.theme` during the first render returns e.g. 'ember' on the client
   * while the server rendered 'harbour'. React reports that as a hydration
   * mismatch and cannot patch it - the markup genuinely differs.
   *
   * `useSyncExternalStore` is built for exactly this case: it renders the
   * *server* snapshot during hydration and swaps to the real client value right
   * after, deterministically and without a warning. The server snapshot is a
   * constant, which also satisfies its "snapshots must be cached" requirement.
   */
  const current = useSyncExternalStore(subscribeToTheme, readAppliedTheme, () => DEFAULT_THEME);

  const choose = useCallback((id: ThemeId) => {
    applyTheme(id);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, id);
    } catch {
      // Private-mode storage denial must not prevent the theme from applying for
      // this session; it just will not be remembered across reloads.
    }
    // `applyTheme` already notifies subscribers, which is what re-renders the
    // swatch and the live region below. Dispatching again here would be a
    // double notification.
  }, []);

  const active = themeById(current);

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-9"
                  aria-label={`Theme: ${active.label}. Change theme`}
                >
                  <Palette aria-hidden="true" />
                  {/*
                    A visible swatch of the current theme's accent. Without it the
                    control is an identical grey icon across all five themes, and
                    the user has no way to tell what is selected without opening
                    the menu.
                  */}
                  <span
                    aria-hidden="true"
                    className="size-2.5 rounded-full ring-1 ring-border"
                    style={{ backgroundColor: active.swatch }}
                  />
                </Button>
              }
            />
          }
        />
        <TooltipContent>Theme: {active.label}</TooltipContent>
      </Tooltip>

      <DropdownMenuContent align="end" className="w-72">
        {/*
          `DropdownMenuGroup` is required: shadcn's `DropdownMenuLabel` wraps
          Base UI's `MenuGroupLabel`, which throws without a group parent.
        */}
        <DropdownMenuGroup>
          <DropdownMenuLabel>Appearance</DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />

        {/*
          A radio group rather than five checkable items: the choice is exclusive,
          and a radiogroup announces "3 of 5" to assistive tech where a list of
          checkboxes announces nothing about the exclusivity.
        */}
        <DropdownMenuRadioGroup value={current} onValueChange={(value) => choose(value as ThemeId)}>
          {THEMES.map((theme) => (
            <DropdownMenuRadioItem key={theme.id} value={theme.id} className="gap-2.5 py-2">
              <span
                aria-hidden="true"
                className="size-4 shrink-0 rounded-full ring-1 ring-border"
                style={{ backgroundColor: theme.swatch }}
              />
              <span className="flex min-w-0 flex-col">
                <span className="text-sm font-medium">{theme.label}</span>
                <span className="text-xs text-muted-foreground">{theme.description}</span>
              </span>
              {/*
                A visual affordance for the selected item. The radio semantics are
                carried by the group itself; this is for sighted users, and it is
                hidden from the accessibility tree to avoid announcing it twice.
              */}
              {theme.id === current && (
                <Check aria-hidden="true" className="ml-auto size-4 shrink-0" />
              )}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator />
        <p className="px-1.5 py-1 text-xs text-muted-foreground">
          {DARK_THEME === current ? 'Dark surface.' : 'Light surface.'} Applies to every screen and
          survives sign-out on this device.
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Announces theme changes to assistive technology.
 *
 * A colour change is completely invisible to a screen-reader user, so without
 * this the picker would close and appear to have done nothing. `polite` rather
 * than `assertive` because it is a confirmation of a deliberate action, not an
 * error - it should not interrupt whatever is being read.
 *
 * Rendered outside the menu so it survives the menu closing.
 */
export function ThemeAnnouncer() {
  const current = useSyncExternalStore(subscribeToTheme, readAppliedTheme, () => DEFAULT_THEME);
  const active = themeById(current);

  return (
    <p aria-live="polite" aria-atomic="true" className="sr-only">
      Theme set to {active.label}. {DARK_THEME === current ? 'Dark' : 'Light'} surface.
    </p>
  );
}
