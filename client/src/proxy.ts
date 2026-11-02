import { NextResponse, type NextRequest } from 'next/server';

/**
 * Root routing and the authenticated-area guard.
 *
 * Next 16 uses `proxy.ts` instead of `middleware.ts`.
 *
 * All routes except `/login`, `/health`, `/metrics`, and static assets require
 * a session. If no session cookie is present, unauthenticated visitors are
 * cleanly redirected (302) to `/login?next=...`.
 */

/** Must match the API's `AUTH_COOKIE_NAME` (server/src/config.ts). */
const SESSION_COOKIE = 'openerp_session';

/** Routes reachable without a session. */
const PUBLIC_PATHS = new Set(['/login']);

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  if (pathname.startsWith('/health') || pathname.startsWith('/metrics')) return true;
  return false;
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

  // Any non-public path requires an active session cookie.
  // Missing or expired cookie redirects cleanly to /login with `next` preserved.
  if (!isPublic(pathname) && !hasSession) {
    const destination = new URL('/login', request.url);
    destination.searchParams.set('next', `${pathname}${search}`);
    return NextResponse.redirect(destination, 302);
  }

  return NextResponse.next();
}

export const config = {
  /**
   * Excludes the API proxy, Next internals and static assets.
   */
  matcher: [
    '/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
