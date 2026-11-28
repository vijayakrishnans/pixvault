// Serves the media app's static build with security headers. Every API call goes to api-edge; this Worker holds
// no credentials and reads no data.

const SECURITY_HEADERS = {
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' https://*.workers.dev wss://*.workers.dev",
    "media-src 'self' blob: https:",
    "font-src 'self' data:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; "),
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "x-frame-options": "DENY",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
    // Hashed build assets are immutable; the HTML shell must always revalidate.
    if (url.pathname.startsWith("/assets/")) headers.set("cache-control", "public, max-age=31536000, immutable");
    else headers.set("cache-control", "no-cache");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
};
