/**
 * Theme catalogue and persistence.
 *
 * A theme is identified by a string that appears in exactly two places: the
 * `data-theme` attribute on `<html>`, and a `[data-theme='...']` block in
 * `globals.css`. This module is the TypeScript view of the same list.
 *
 * WHY THE CATALOGUE LIVES HERE AND NOT IN THE CSS
 *
 * The switcher has to render a label and a swatch per theme. Deriving those from
 * the stylesheet would mean reading computed styles, which cannot run before
 * paint - and the whole point of setting `data-theme` before first paint is to
 * avoid a flash of the wrong colours. So the catalogue is duplicated, and
 * `smoke-phase6.mjs` asserts that the two lists agree. A theme added to the CSS
 * but not here is caught by a failing test rather than by a user finding a
 * theme that renders but cannot be selected.
 *
 * WHY `localStorage` AND NOT A COOKIE
 *
 * The theme is a purely client-side presentation preference. It must be readable
 * by the inline script in the root layout *before* React hydrates, which rules
 * out React state and makes `localStorage` the natural store - a cookie would
 * also work but would send a cosmetic preference to the server on every
 * request. See `THEME_BOOTSTRAP_SCRIPT`.
 */

/** The five themes. `harbour` is the default and must always exist. */
export const THEMES = [
  {
    id: 'harbour',
    label: 'Harbour',
    description: 'Cool slate with industrial cyan-blue. The default.',
    /** Shown in the picker; mirrors `--primary` for that theme. */
    swatch: 'oklch(0.55 0.16 238)',
  },
  {
    id: 'steel',
    label: 'Steel',
    description: 'Cooler and bluer. Suits finance-led work.',
    swatch: 'oklch(0.5 0.19 268)',
  },
  {
    id: 'ember',
    label: 'Ember',
    description: 'Warm neutrals with an amber-orange accent.',
    swatch: 'oklch(0.58 0.16 48)',
  },
  {
    id: 'verdant',
    label: 'Verdant',
    description: 'Green-tinted neutrals with an emerald accent.',
    swatch: 'oklch(0.52 0.14 162)',
  },
  {
    id: 'midnight',
    label: 'Midnight',
    description: 'Dark surface with a violet accent.',
    swatch: 'oklch(0.68 0.15 288)',
  },
] as const;

export type ThemeId = (typeof THEMES)[number]['id'];

export const DEFAULT_THEME: ThemeId = 'harbour';

/** `localStorage` key. Versioned so a future palette change can invalidate it. */
export const THEME_STORAGE_KEY = 'openerp_theme_v1';

/** The dark theme, identified so callers can branch on it if they ever must. */
export const DARK_THEME: ThemeId = 'midnight';

export const THEME_IDS: readonly ThemeId[] = THEMES.map((theme) => theme.id);

/** Narrowing guard. The value comes from storage, so it is untrusted input. */
export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && (THEME_IDS as readonly string[]).includes(value);
}

export function themeById(id: ThemeId) {
  return THEMES.find((theme) => theme.id === id) ?? THEMES[0];
}

/**
 * Applies a theme to the document.
 *
 * Writes `data-theme`, and mirrors the dark theme onto the `dark` class because
 * the shadcn components' own `dark:` variants are keyed off that class. Setting
 * both means a component's `dark:` utility agrees with the theme instead of
 * contradicting it - which is exactly what happens when a dark theme is applied
 * without the class and every `dark:bg-white/5` quietly does nothing.
 *
 * Notifies subscribers so React consumers re-render. Nothing else needs to know
 * the theme changed.
 */
export function applyTheme(id: ThemeId): void {
  const root = document.documentElement;
  root.dataset.theme = id;
  root.classList.toggle('dark', id === DARK_THEME);

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: { theme: id } }));
  }
}

/** Fired on `window` whenever the active theme changes. */
export const THEME_CHANGE_EVENT = 'openerp:theme-change';

/**
 * Reads the theme currently on <html>.
 *
 * This is the single source of truth for "what is active" once the page has
 * loaded - not `localStorage`, which the bootstrap script may have found
 * unavailable.
 */
export function readAppliedTheme(): ThemeId {
  if (typeof document === 'undefined') return DEFAULT_THEME;
  const attr = document.documentElement.dataset.theme;
  return isThemeId(attr) ? attr : DEFAULT_THEME;
}

/**
 * Subscribes to theme changes, including from another tab.
 *
 * The `storage` event is included so a user with two windows open sees the theme
 * change in both. Without it the second window keeps its own stale swatch while
 * showing the new colours, which looks like a bug.
 */
export function subscribeToTheme(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener(THEME_CHANGE_EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(THEME_CHANGE_EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}

/**
 * The script injected into <head> to set the theme before first paint.
 *
 * Kept as a string because it must run synchronously during HTML parsing; a
 * React effect runs far too late and the user sees a flash of the default
 * palette on every navigation.
 *
 * It is deliberately tiny and defensive: it cannot throw, cannot fetch, and
 * falls back to the default for anything unrecognised. A bootstrap script that
 * can break the page is a worse bug than a flash of colour.
 */
export const THEME_BOOTSTRAP_SCRIPT = `
(function(){
  try {
    var stored = localStorage.getItem('${THEME_STORAGE_KEY}');
    var valid = ${JSON.stringify(THEME_IDS)};
    var theme = valid.indexOf(stored) !== -1 ? stored : ${JSON.stringify(DEFAULT_THEME)};
    var root = document.documentElement;
    root.dataset.theme = theme;
    if (theme === ${JSON.stringify(DARK_THEME)}) { root.classList.add('dark'); }
  } catch (e) {
    // Private mode, disabled storage, or a corrupt value. The CSS default in
    // :root is already correct, so there is nothing to repair.
  }
})();
`.trim();
