// Share-link pages (PV6): /_s/<token> (landing, password form) and /_s/<token>/f/<fileId> (one file's bytes).
// The adapted idea is ImgBed's public browse page (functions/api/public/list.js), narrowed to one shared file or
// folder. Every request asks media-worker, which checks the link in D1 again, so a revoked link stops at the next
// request. Pages send no referrer (the token is in the URL), can't be framed, aren't cached and aren't indexed.
// After a correct password the guest gets a cookie scoped to this link's path.

import type { Env } from "./env.js";
import { esc, page, unavailable } from "./report.js";

export const SHARE_PREFIX = "/_s/";
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const FILE_RE = /^fil_[0-9a-f]{32}$/;
const COOKIE = "pv_share";
const SHARE_CSP = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const PAGE_HEADERS = { "content-security-policy": SHARE_CSP, "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer" };

interface ShareFile {
  id: string;
  name: string;
  size: number;
  mime: string;
  folder: string;
}
interface Opened {
  share: { kind: "file" | "folder"; mode: "view" | "download"; label: string; expiresAt: string | null; downloadsLeft: number | null };
  files: ShareFile[];
  truncated: boolean;
  proof?: { value: string; maxAge: number };
}

export function parseSharePath(pathname: string): { token: string; fileId: string | null } | null {
  if (!pathname.startsWith(SHARE_PREFIX)) return null;
  const [token, f, fileId, ...rest] = pathname.slice(SHARE_PREFIX.length).split("/");
  if (!token || !TOKEN_RE.test(token) || rest.length) return null;
  if (f === undefined) return { token, fileId: null };
  if (f === "f" && fileId && FILE_RE.test(fileId)) return { token, fileId };
  return null;
}

function cookieProof(request: Request): string | undefined {
  const c = request.headers.get("cookie") ?? "";
  for (const part of c.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return v.join("=");
  }
  return undefined;
}

async function callMedia(env: Env, route: "open" | "content", body: Record<string, unknown>): Promise<Response> {
  return env.MEDIA_WORKER!.fetch(`https://media.internal/v1/media/shares/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const fmt = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);
const viewable = (mime: string) => /^(image\/(png|jpe?g|gif|webp|avif|bmp)|video\/|audio\/)/i.test(mime);

function sharePage(status: number, title: string, body: string, extra: Record<string, string> = {}): Response {
  return page(status, title, `${body}<p class="muted">Shared with Pixvault. Only what was shared is visible here.</p>`, { ...PAGE_HEADERS, ...extra });
}

function gone(status: number): Response {
  if (status === 451) return unavailable();
  if (status === 410) return sharePage(410, "Link no longer available", "<h1>This link is no longer available</h1><p>It has expired or reached its download limit. Ask the person who shared it for a new one.</p>");
  if (status === 429) return sharePage(429, "Too many tries", "<h1>Too many tries</h1><p>Wait a minute and try again.</p>", { "retry-after": "60" });
  if (status >= 500) return sharePage(503, "Unavailable", "<h1>Something went wrong</h1><p>Try again in a moment.</p>");
  return sharePage(404, "Link not found", "<h1>This link doesn't work</h1><p>It may have been turned off. Ask the person who shared it.</p>");
}

function passwordForm(token: string, wrong: boolean): Response {
  return sharePage(
    401,
    "Password needed",
    `<h1>This link needs a password</h1>${wrong ? "<p><strong>That password isn't right.</strong></p>" : ""}
<form method="post" action="${SHARE_PREFIX}${token}"><label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required maxlength="128" autofocus>
<button type="submit">Open</button></form>`,
  );
}

function landing(token: string, o: Opened): Response {
  const base = `${SHARE_PREFIX}${token}/f/`;
  const dl = (f: ShareFile) => `<a href="${base}${f.id}?dl=1" download>Download</a>`;
  const meta = [
    o.share.expiresAt ? `Available until ${esc(new Date(o.share.expiresAt).toUTCString())}` : "",
    o.share.downloadsLeft !== null ? `${o.share.downloadsLeft} download${o.share.downloadsLeft === 1 ? "" : "s"} left` : "",
  ].filter(Boolean).join(" · ");
  let body: string;
  if (o.share.kind === "file" && o.files[0]) {
    const f = o.files[0];
    // In download mode, every fetch of the bytes counts, so there's no inline preview.
    const preview =
      o.share.mode === "view" && viewable(f.mime)
        ? /^image\//i.test(f.mime)
          ? `<p><img src="${base}${f.id}" alt="${esc(f.name)}" style="max-width:100%;height:auto;border-radius:8px"></p>`
          : /^video\//i.test(f.mime)
            ? `<p><video src="${base}${f.id}" controls preload="metadata" style="max-width:100%"></video></p>`
            : `<p><audio src="${base}${f.id}" controls preload="metadata"></audio></p>`
        : "";
    body = `<h1>${esc(f.name)}</h1><p class="muted">${esc(f.mime)} · ${fmt(f.size)}${meta ? ` · ${meta}` : ""}</p>${preview}<p>${dl(f)}</p>`;
  } else {
    const rows = o.files
      .map((f) => `<li><code>${esc(f.folder === "/" ? "" : `${f.folder.slice(1)}/`)}</code>${esc(f.name)} <span class="muted">${fmt(f.size)}</span> · ${o.share.mode === "view" && viewable(f.mime) ? `<a href="${base}${f.id}">View</a> · ` : ""}${dl(f)}</li>`)
      .join("");
    body = `<h1>${esc(o.share.label)}</h1><p class="muted">${o.files.length} file${o.files.length === 1 ? "" : "s"}${meta ? ` · ${meta}` : ""}</p>${
      o.files.length ? `<ul style="padding-left:18px;line-height:1.9">${rows}</ul>` : "<p>This folder is empty.</p>"
    }${o.truncated ? '<p class="muted">Only the first 500 files are listed.</p>' : ""}`;
  }
  return sharePage(200, o.share.kind === "file" ? (o.files[0]?.name ?? "Shared file") : o.share.label, body);
}

/** /_s/… requests. */
export async function handleShare(request: Request, env: Env, p: { token: string; fileId: string | null }): Promise<Response> {
  if (!env.MEDIA_WORKER) return gone(503);
  const ip = request.headers.get("cf-connecting-ip") ?? "";
  if (env.SERVE_RL && ip && !(await env.SERVE_RL.limit({ key: ip })).success) return gone(429);
  const proof = cookieProof(request);

  if (p.fileId) {
    if (request.method !== "GET" && request.method !== "HEAD") return gone(404);
    const download = new URL(request.url).searchParams.get("dl") === "1";
    const res = await callMedia(env, "content", { token: p.token, proof, fileId: p.fileId, download });
    if (res.status === 401) return passwordForm(p.token, false);
    if (!res.ok) return gone(res.status);
    const headers = new Headers(res.headers);
    headers.delete("x-request-id");
    headers.set("x-robots-tag", "noindex, nofollow");
    return new Response(request.method === "HEAD" ? null : res.body, { status: 200, headers });
  }

  if (request.method === "POST") {
    // Password tries: 5 a minute per address and link, on top of the general limit.
    if (env.SERVE_SHARE_RL && !(await env.SERVE_SHARE_RL.limit({ key: `${ip}:${p.token.slice(0, 16)}` })).success) return gone(429);
    let password = "";
    try {
      const form = await request.formData();
      password = String(form.get("password") ?? "").slice(0, 128);
    } catch {
      return passwordForm(p.token, false);
    }
    const res = await callMedia(env, "open", { token: p.token, password });
    if (res.status === 401) return passwordForm(p.token, true);
    if (!res.ok) return gone(res.status);
    const o = ((await res.json()) as { data: Opened }).data;
    const headers: Record<string, string> = { location: `${SHARE_PREFIX}${p.token}`, "cache-control": "no-store", "referrer-policy": "no-referrer" };
    if (o.proof) headers["set-cookie"] = `${COOKIE}=${o.proof.value}; Path=${SHARE_PREFIX}${p.token}; Max-Age=${o.proof.maxAge}; HttpOnly; Secure; SameSite=Lax`;
    return new Response(null, { status: 303, headers });
  }
  if (request.method !== "GET" && request.method !== "HEAD") return gone(404);
  const res = await callMedia(env, "open", { token: p.token, proof });
  if (res.status === 401) return passwordForm(p.token, false);
  if (!res.ok) return gone(res.status);
  return landing(p.token, ((await res.json()) as { data: Opened }).data);
}
