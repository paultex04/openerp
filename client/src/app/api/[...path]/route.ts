import { NextResponse } from 'next/server';

/**
 * Same-origin API proxy.
 *
 * The client calls `/api/*` on its own origin and this route forwards each
 * request to the Fastify API. That keeps the session cookie unambiguously
 * first-party — no CORS, no cross-site cookie rules, and no dependency on
 * `NEXT_PUBLIC_*` variables being inlined correctly at build time.
 *
 * WHY THIS EXISTS (learned the hard way):
 *
 *  - A `rewrites()` entry in next.config.mjs was tried first. The rewrite never
 *    matched and every proxied call returned 404 with nothing logged anywhere.
 *    A filesystem Route Handler takes precedence over rewrites and over 404s,
 *    so it cannot fail that way.
 *  - Calling the API cross-origin instead (via NEXT_PUBLIC_API_BASE_URL) also
 *    failed, because Next.js only reads `.env` files from its own directory —
 *    the repo-root `.env` is invisible to it, so the variable was never inlined
 *    and every request silently went to the client's own origin.
 *
 * Run without `export const runtime` so this stays on the Node runtime, where
 * `fetch` and header handling are unrestricted.
 */

const API_ORIGIN = process.env.API_ORIGIN ?? 'http://127.0.0.1:4000';

/**
 * Headers worth forwarding upstream. `cookie` carries the session; the rest are
 * content negotiation.
 */
const FORWARD_REQUEST_HEADERS = [
  'cookie',
  'authorization',
  'x-csrf-token',
  'content-type',
  'accept',
  'accept-language',
];

/**
 * Headers returned downstream. `set-cookie` is the important one: without it the
 * login response cannot establish a session in the browser.
 */
const FORWARD_RESPONSE_HEADERS = [
  'content-type',
  'content-disposition',
  'content-length',
  'set-cookie',
  'cache-control',
  'x-accel-buffering',
];

async function proxy(request: Request, path: string[]): Promise<Response> {
  const url = new URL(request.url);
  // Preserve the query string; job and rate filters depend on it.
  const target = `${API_ORIGIN}/api/${path.join('/')}${url.search}`;

  const headers = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }

  // GET and HEAD must not carry a body.
  const method = request.method;
  const hasBody = method !== 'GET' && method !== 'HEAD' && request.body !== null;

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method,
      headers,
      body: hasBody ? request.body : undefined,
      // @ts-expect-error duplex is required by Node.js fetch when body is a ReadableStream
      duplex: hasBody ? 'half' : undefined,
      // Never let a cached response mask a 401.
      cache: 'no-store',
      redirect: 'manual',
      signal: request.signal,
    });
  } catch {
    // If the client aborted the connection (e.g. navigated away or closed the tab),
    // return a clean 499 Client Closed Request rather than logging an unreachable server error.
    if (request.signal.aborted) {
      return new Response(null, { status: 499 });
    }

    return NextResponse.json(
      {
        error: 'API_UNREACHABLE',
        message: `Could not reach the OpenERP API at ${API_ORIGIN}. Is the server running?`,
      },
      { status: 502 },
    );
  }

  const responseHeaders = new Headers();
  for (const name of FORWARD_RESPONSE_HEADERS) {
    if (name === 'set-cookie') continue;
    const value = upstream.headers.get(name);
    if (value !== null) responseHeaders.set(name, value);
  }

  // Forward Set-Cookie headers properly using getSetCookie() to avoid mangling multiple cookies
  const setCookies =
    typeof upstream.headers.getSetCookie === 'function'
      ? upstream.headers.getSetCookie()
      : ([upstream.headers.get('set-cookie')].filter(Boolean) as string[]);

  for (const cookieStr of setCookies) {
    responseHeaders.append('set-cookie', cookieStr);
  }

  let responseBody: BodyInit | null = upstream.body;
  const contentType = upstream.headers.get('content-type') ?? '';
  if (responseBody && contentType.includes('text/event-stream')) {
    // When forwarding Server-Sent Events, wrap in a TransformStream and safely absorb
    // client aborts/disconnections so Next.js does not log unhandled pipe errors (UND_ERR_SOCKET).
    const transform = new TransformStream();
    upstream.body?.pipeTo(transform.writable, { signal: request.signal }).catch(() => {
      // Normal client socket closure/abort; safely ignored.
    });
    responseBody = transform.readable;
  }

  return new NextResponse(responseBody, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export async function GET(request: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return proxy(request, (await ctx.params).path);
}

export async function POST(request: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return proxy(request, (await ctx.params).path);
}

export async function PUT(request: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return proxy(request, (await ctx.params).path);
}

export async function PATCH(request: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return proxy(request, (await ctx.params).path);
}

export async function DELETE(request: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return proxy(request, (await ctx.params).path);
}
