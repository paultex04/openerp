import { NextResponse } from 'next/server';

const API_ORIGIN = process.env.API_ORIGIN ?? 'http://127.0.0.1:4000';

export async function GET() {
  try {
    const upstream = await fetch(`${API_ORIGIN}/health`, { cache: 'no-store' });
    const data = await upstream.json();
    return NextResponse.json(data, {
      status: upstream.status,
      headers: {
        'cache-control': 'no-store',
      },
    });
  } catch {
    return NextResponse.json(
      { status: 'degraded', error: 'API_UNREACHABLE' },
      { status: 502 },
    );
  }
}
