// Upload-link page (PV6): /_u/<token>. A plain HTML form, no script (the page CSP allows none): the guest picks
// files and submits; each file goes to media-worker, which checks it against the link and the team's quota. The
// page says what arrived and what didn't, and why. Nothing a guest sends is served from here or anywhere until a
// member decides.

import type { Env } from "./env.js";
import { esc, page, unavailable } from "./report.js";

export const UPLOAD_PREFIX = "/_u/";
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
/** One form submission: Workers cap request bodies at 100 MB; leave room for the form encoding. */
const MAX_REQUEST_BYTES = 95 * 1024 * 1024;
const MAX_FILES_PER_POST = 20;
const HEADERS = { "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer" };

interface Info {
  label: string;
  limits: { maxFiles: number; maxFileBytes: number; maxTotalBytes: number; allowedTypes: string[] };
  remaining: { files: number; bytes: number };
  expiresAt: string | null;
  reviewed: boolean;
}

export function parseUploadPath(pathname: string): string | null {
  if (!pathname.startsWith(UPLOAD_PREFIX)) return null;
  const token = pathname.slice(UPLOAD_PREFIX.length);
  return TOKEN_RE.test(token) ? token : null;
}

const fmt = (n: number) => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB` : `${(n / 1073741824).toFixed(1)} GB`);

function uploadPage(status: number, title: string, body: string, extra: Record<string, string> = {}): Response {
  return page(status, title, `${body}<p class="muted">Pixvault upload link. Files you send go only to the team that shared this link.</p>`, { ...HEADERS, ...extra });
}

function gone(status: number): Response {
  if (status === 451) return unavailable();
  if (status === 410) return uploadPage(410, "Link expired", "<h1>This upload link has expired</h1><p>Ask the person who sent it for a new one.</p>");
  if (status === 429) return uploadPage(429, "Too many uploads", "<h1>Too many uploads</h1><p>Wait a minute and try again.</p>", { "retry-after": "60" });
  if (status === 413) return uploadPage(413, "Too large", "<h1>That was too much at once</h1><p>Send fewer or smaller files in each go.</p>");
  if (status >= 500) return uploadPage(503, "Unavailable", "<h1>Something went wrong</h1><p>Try again in a moment.</p>");
  return uploadPage(404, "Link not found", "<h1>This upload link doesn't work</h1><p>It may have been turned off. Ask the person who sent it.</p>");
}

function form(token: string, info: Info, results = ""): Response {
  const l = info.limits;
  const facts = [
    `Up to ${info.remaining.files} more file${info.remaining.files === 1 ? "" : "s"}`,
    `${fmt(l.maxFileBytes)} each`,
    `${fmt(info.remaining.bytes)} in all`,
    l.allowedTypes.length ? `types: ${l.allowedTypes.map(esc).join(", ")}` : "",
    info.expiresAt ? `until ${esc(new Date(info.expiresAt).toUTCString())}` : "",
  ].filter(Boolean).join(" · ");
  const full = info.remaining.files <= 0 || info.remaining.bytes <= 0;
  return uploadPage(
    200,
    info.label || "Send files",
    `<h1>${esc(info.label || "Send files")}</h1><p class="muted">${facts}</p>${info.reviewed ? "<p>The team will review what you send before using it.</p>" : ""}${results}${
      full
        ? "<p><strong>This link has taken all the files it can.</strong></p>"
        : `<form method="post" action="${UPLOAD_PREFIX}${token}" enctype="multipart/form-data"><label for="f">Files</label><input id="f" name="files" type="file" multiple required${
            l.allowedTypes.length ? ` accept="${esc(l.allowedTypes.join(","))}"` : ""
          }><button type="submit">Send</button></form>`
    }`,
  );
}

const REASONS: Record<string, string> = {
  too_large: "too large",
  unsupported_type: "type not accepted",
  limit_reached: "the link is full",
  quota_exceeded: "the team has no room",
  expired: "the link has expired",
  not_found: "the link was turned off",
  validation_error: "not a valid file name",
  conflict: "a file with this name arrived at the same time; send it again",
};

async function open(env: Env, token: string): Promise<Response> {
  return env.MEDIA_WORKER!.fetch("https://media.internal/v1/media/upload-links/open", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
}

export async function handleUploadLink(request: Request, env: Env, token: string): Promise<Response> {
  if (!env.MEDIA_WORKER) return gone(503);
  const ip = request.headers.get("cf-connecting-ip") ?? "";
  if (request.method === "GET" || request.method === "HEAD") {
    if (env.SERVE_RL && ip && !(await env.SERVE_RL.limit({ key: ip })).success) return gone(429);
    const res = await open(env, token);
    if (!res.ok) return gone(res.status);
    return form(token, ((await res.json()) as { data: Info }).data);
  }
  if (request.method !== "POST") return gone(404);
  if (env.SERVE_UPLOAD_RL && ip && !(await env.SERVE_UPLOAD_RL.limit({ key: ip })).success) return gone(429);
  const length = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(length) || length > MAX_REQUEST_BYTES) return gone(413);
  let files: File[];
  try {
    files = ((await request.formData()).getAll("files") as unknown[]).filter((f): f is File => typeof f === "object" && f !== null && "arrayBuffer" in (f as object) && (f as File).size > 0);
  } catch {
    return gone(413);
  }
  const lines: string[] = [];
  for (const [i, f] of files.entries()) {
    if (i >= MAX_FILES_PER_POST) {
      lines.push(`<li>${esc(f.name)}: not sent (at most ${MAX_FILES_PER_POST} files at a time)</li>`);
      continue;
    }
    const qs = new URLSearchParams({ token, name: f.name.slice(0, 255), mime: f.type || "application/octet-stream" });
    const res = await env.MEDIA_WORKER.fetch(`https://media.internal/v1/media/upload-links/upload?${qs}`, {
      method: "POST",
      // A Blob body has a known length, so media-worker gets a Content-Length.
      headers: { "content-type": "application/octet-stream" },
      body: f,
    });
    if (res.status === 201) {
      const d = ((await res.json()) as { data: { file: { name: string } } }).data.file;
      lines.push(`<li>${esc(d.name)}: received</li>`);
    } else {
      let code = "error";
      try {
        code = ((await res.json()) as { error?: { code?: string } }).error?.code ?? "error";
      } catch {
        /* keep "error" */
      }
      if (res.status === 451) return unavailable();
      lines.push(`<li>${esc(f.name)}: not received (${esc(REASONS[code] ?? "something went wrong")})</li>`);
    }
  }
  const after = await open(env, token);
  const results = `<h2>What happened</h2><ul>${lines.join("") || "<li>No files were chosen.</li>"}</ul>`;
  if (!after.ok) return uploadPage(200, "Sent", `<h1>Sent</h1>${results}`);
  return form(token, ((await after.json()) as { data: Info }).data, results);
}
