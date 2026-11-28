// Security headers on every API response (OWASP A02). The API serves JSON and signed-in downloads only, so nothing
// may be sniffed, framed or cached by shared caches, and browsers keep to HTTPS.

const HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=63072000; includeSubDomains",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "cross-origin-resource-policy": "same-site",
};

export function applySecurityHeaders(response: Response): Response {
  // A WebSocket upgrade (101) can't be re-wrapped.
  if (response.status === 101 || (response as Response & { webSocket?: unknown }).webSocket) return response;
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(HEADERS)) if (!headers.has(k)) headers.set(k, v);
  // Responses carry private data unless a handler said otherwise.
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
