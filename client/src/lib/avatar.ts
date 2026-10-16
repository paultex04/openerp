/**
 * Avatar presentation, shared by the shell's user menu and the profile page.
 *
 * The helpers live here rather than in either component because both render the
 * same avatar: the shell at 28px with a tinted fallback, the profile at 80px
 * with the same tint, so the two must derive initials and colour identically or
 * the header and the profile would disagree about who you are.
 */

/**
 * Avatar tint, chosen from the address so it is stable per user rather than
 * changing on every render or navigation.
 *
 * Built from theme tokens rather than literal colour ramps. The literals were a
 * fixed set of four colours that ignored the active theme entirely, so under
 * Midnight four dark-on-dark avatars rendered at near-zero contrast. A low-alpha
 * fill plus the solid token for the text lets the tint follow the palette and
 * keeps the lettering legible in every theme.
 */
const ROLE_TINTS = [
  'bg-info/15 text-info',
  'bg-primary/15 text-primary',
  'bg-warning/15 text-warning',
  'bg-success/15 text-success',
] as const;

export function avatarTint(seed: string | undefined): string {
  const index = (seed ?? 'anon').length % ROLE_TINTS.length;
  return ROLE_TINTS[index] ?? ROLE_TINTS[0];
}

/**
 * Derives avatar initials from either a person's name or an email address.
 *
 * Names split on whitespace ("Bongani Dlamini" -> "BD"); addresses fall back to
 * the local part with separators treated as word breaks ("david.m" -> "DM"), since
 * not every account has a linked employee record.
 */
export function initials(value: string | undefined): string {
  if (!value) return '?';
  if (value.includes('@')) {
    const local = value.split('@')[0] ?? '';
    const parts = local.split(/[._-]+/).filter(Boolean);
    const letters = parts.slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '');
    return letters.join('') || (local[0] ?? '?').toUpperCase();
  }
  const parts = value.trim().split(/\s+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '');
  return letters.join('') || (value[0] ?? '?').toUpperCase();
}

/**
 * The avatar image URL for a version stamp, or undefined when there is none.
 *
 * The stamp is the cache-buster: the avatar route serves the bytes as
 * immutable, so a new upload must be reachable at a *new* URL or the browser
 * would keep showing the old face. `undefined` renders the initials fallback.
 */
export function avatarImageUrl(updatedAt: string | null | undefined): string | undefined {
  return updatedAt ? `/api/auth/me/avatar?v=${encodeURIComponent(updatedAt)}` : undefined;
}
