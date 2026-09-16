// Proxy one request to TypeSafe. The key arrives in a header from the browser,
// is forwarded as the Bearer token, and is never stored or logged here.
// One TypeSafe call per invocation keeps each function run short; the page
// loops over chunks itself.

export const runtime = 'nodejs';
export const maxDuration = 60;

const UPSTREAM = 'https://api.typesafe.ai/v1/systemone';

export async function POST(req) {
  const key = req.headers.get('x-typesafe-key');
  if (!key) {
    return Response.json({ error: 'Missing TypeSafe API key' }, { status: 401 });
  }

  const body = await req.text();
  const upstream = await fetch(UPSTREAM, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body,
  });

  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { 'Content-Type': upstream.headers.get('content-type') || 'application/json' },
  });
}
