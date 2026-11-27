// The abuse report form (design §4.9) and the 451 notice. Our own small HTML pages: no scripts, styles inline,
// forms post to this origin only.

import type { Env } from "./env.js";

export const REPORT_PATH = "/_report";

export const CATEGORIES: [value: string, label: string][] = [
  ["csam", "Child sexual abuse material"],
  ["sexual", "Sexual or nude content"],
  ["violence", "Violence or gore"],
  ["hate", "Hate or extremism"],
  ["harassment", "Harassment or private information"],
  ["copyright", "Copyright infringement"],
  ["malware", "Malware or phishing"],
  ["spam", "Spam"],
  ["other", "Something else"],
];

const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function page(status: number, title: string, body: string, extra: Record<string, string> = {}): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 16px;color:#1d1d1f;background:#fff}h1{font-size:22px}label{display:block;margin:14px 0 4px;font-weight:600}select,textarea,input{width:100%;box-sizing:border-box;font:inherit;padding:8px;border:1px solid #bbb;border-radius:6px}button{margin-top:16px;padding:10px 18px;font:inherit;border:0;border-radius:6px;background:#4f46e5;color:#fff}.muted{color:#666;font-size:14px}code{word-break:break-all}@media (prefers-color-scheme:dark){body{background:#111;color:#eee}select,textarea,input{background:#1c1c1e;color:#eee;border-color:#444}.muted{color:#aaa}}</style></head><body>${body}</body></html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": PAGE_CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", ...extra },
  });
}

/** 451 for a taken-down file or a suspended team. Says nothing about the file or why. */
export function unavailable(): Response {
  return page(
    451,
    "Unavailable",
    `<h1>This content is unavailable</h1><p>It was removed or restricted following a report or a review under the service's acceptable use policy.</p>`,
  );
}

export function reportLink(origin: string, path: string): string {
  return `${origin}${REPORT_PATH}?u=${encodeURIComponent(path)}`;
}

export function reportForm(path: string, message = ""): Response {
  const opts = CATEGORIES.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("");
  return page(
    200,
    "Report a file",
    `<h1>Report a file</h1><p class="muted">File: <code>${esc(path)}</code></p>${message ? `<p><strong>${esc(message)}</strong></p>` : ""}
<form method="post" action="${REPORT_PATH}"><input type="hidden" name="u" value="${esc(path)}">
<label for="c">What's wrong with it?</label><select id="c" name="category" required>${opts}</select>
<label for="d">Details (optional)</label><textarea id="d" name="details" rows="5" maxlength="2000"></textarea>
<label for="e">Your email (optional, if you want a reply)</label><input id="e" name="email" type="email" maxlength="254">
<button type="submit">Send report</button></form>
<p class="muted">Reports are reviewed by the service's operators. For child sexual abuse material, also report to your national hotline.</p>`,
  );
}

export function reportReceived(): Response {
  return page(202, "Report received", `<h1>Thank you</h1><p>Your report was received and will be reviewed.</p>`);
}

export interface ResolvedFile {
  orgId: string;
  libraryId: string;
  fileId: string;
  sha256: string;
}

/** Forward a report to media-worker (service binding). */
export async function submitReport(env: Env, file: ResolvedFile, form: { category: string; details: string; email: string }): Promise<boolean> {
  if (!env.MEDIA_WORKER) return false;
  const res = await env.MEDIA_WORKER.fetch("https://media.internal/v1/media/abuse-reports", {
    method: "POST",
    headers: { "content-type": "application/json", "x-request-id": crypto.randomUUID() },
    body: JSON.stringify({ ...file, category: form.category, details: form.details || null, email: form.email || null }),
  });
  return res.status === 202;
}
