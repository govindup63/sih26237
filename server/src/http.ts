/**
 * The frontend runs on the developer's laptop and reaches this server through an
 * SSH tunnel, so every response needs CORS headers for the Vite dev origin.
 */
const ALLOWED_ORIGINS = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
])

export function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('origin')
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return {}
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    // The session header is on every request, so it has to survive preflight.
    'Access-Control-Allow-Headers': 'Content-Type, x-sih-session',
    'Access-Control-Max-Age': '86400',
  }
}

export function json(request: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
  })
}

export function bytes(request: Request, body: Uint8Array, contentType: string): Response {
  return new Response(body, {
    headers: { 'Content-Type': contentType, ...corsHeaders(request) },
  })
}
