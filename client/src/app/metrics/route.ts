import { NextResponse } from 'next/server';

const API_ORIGIN = process.env.API_ORIGIN ?? 'http://127.0.0.1:4000';

export async function GET() {
  try {
    const upstream = await fetch(`${API_ORIGIN}/metrics`, { cache: 'no-store' });
    const text = await upstream.text();
    return new NextResponse(text, {
      status: upstream.status,
      headers: {
        'content-type': 'text/plain; version=0.0.4; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  } catch {
    return new NextResponse('error: API_UNREACHABLE\n', {
      status: 502,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
      },
    });
  }
}
