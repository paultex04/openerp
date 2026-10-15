import { redirect } from 'next/navigation';

/**
 * `/` is a router, not a page.
 *
 * `src/proxy.ts` (the Next 16 name for middleware) handles the normal path with a
 * real 302 before any render happens. This component is the fallback for the case
 * where the proxy is bypassed - a direct server-side invocation, or a request
 * that never matched the matcher - so there is no way to land on an unstyled or
 * misleading root.
 *
 * It deliberately does not inspect the cookie: the cookie is HTTP-only, its
 * contents cannot be read here, and its presence is not proof of a valid
 * session. Authentication belongs to the API.
 */
export default function RootPage(): never {
  redirect('/dashboard');
}
