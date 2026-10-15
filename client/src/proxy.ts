import { NextResponse, type NextRequest } from 'next/server';

/**
 * Root routing and the authenticated-area guard.
 *
 * WHY A PROXY: `/` has to decide between `/login` and `/dashboard` before
 * anything renders, and the decision has to be a real HTTP redirect (302) rather
 * than a client-side one that paints the wrong screen first. (Next 16 renamed
 * the `middleware` convention to `proxy`; this file was ported by the official
 * `middleware-to-proxy` codemod.)
 *
 * WHY A COOKIE PRESENCE CHECK IS ENOUGH HERE: this is a *routing* decision, not
 * an authorisation one. It reads only whether the session cookie exists, and the
 * cookie is HTTP-only so no script - including this - can read its contents. A
 * forged or expired cookie passes this gate and is then rejected by the API,
 * which is where authentication actually happens. Do not move real
 * authorisation into this file.
 */

/** Must match the API's `AUTH_COOKIE_NAME` (server/src/config.ts). */
const SESSION_COOKIE = 'openerp_session';

/** Routes reachable without a session. */
const PUBLIC_PATHS = new Set(['/login']);

/**
 * Routes that require a session. Anything not listed and not public is treated
 * as requiring one, so a newly added page is guarded by default rather than
 * accidentally published.
 */
const PROTECTED_PREFIXES = [
  '/dashboard',
  '/commercial',
  '/operations',
  '/billing',
  '/field',
  '/admin',
];

function isProtected(pathname: string): boolean {
  return PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE)?.value);

  // `/` is a pure router: it never renders, it only decides where you belong.
  if (pathname === '/') {
    const destination = hasSession ? '/dashboard' : '/login';
    return NextResponse.redirect(new URL(destination, request.url), 302);
  }

  if (PUBLIC_PATHS.has(pathname)) {
    // Already signed in? There is nothing to do on the sign-in page.
    if (hasSession) {
      return NextResponse.redirect(new URL('/dashboard', request.url), 302);
    }
    return NextResponse.next();
  }

  if (isProtected(pathname) && !hasSession) {
    // `next` is preserved so the user lands where they intended after signing in.
    const destination = new URL('/login', request.url);
    destination.searchParams.set('next', `${pathname}${search}`);
    return NextResponse.redirect(destination, 302);
  }

  return NextResponse.next();
}

export const config = {
  /**
   * Excludes the API proxy, Next internals and static assets. The matcher is
   * explicit rather than a blanket regex because a stray match would apply the
   * auth guard to asset requests and turn a CSS 404 into a redirect to /login.
   */
  matcher: [
    '/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
