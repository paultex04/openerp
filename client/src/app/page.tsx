import { redirect } from 'next/navigation';

/**
 * `/` is a router, not a page.
 *
 * `src/middleware.ts` handles the normal path with a real 302 before any render
 * happens. This component is the fallback for the case where middleware is
 * bypassed - a direct server-side invocation, or a request that never matched the
 * matcher - so there is no way to land on an unstyled or misleading root.
 *
 * It deliberately does not inspect the cookie: the cookie is HTTP-only, its
 * contents cannot be read here, and its presence is not proof of a valid
 * session. Authentication belongs to the API.
 */
export default function RootPage(): never {
  redirect('/dashboard');
}
