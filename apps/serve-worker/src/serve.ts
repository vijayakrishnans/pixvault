// Derived from MarSeventh/CloudFlare-ImgBed@611153e:functions/file/[[path]].js (MIT), modified.
// ImgBed serves /file/<id> from a channel, checking an instance-wide allow/block list and referrer rule.
// Here: /<orgSlug>/<libSlug>/<path> → one KV map read (often from the isolate), one KV route read, then the edge
// cache or R2. Every rule is the library's own. Private files need a signature bound to their library, path and
// expiry. A file of library A is never reachable through library B: the route key carries the library id from B's
// own map.

import { verifyPath } from "@saas/shared/media-signing";
import type { Env } from "./env.js";
import { remoteStore, type MediaStore, type StoredObject } from "@saas/shared/media-store";
import { negotiateFormat, presetOptions, transformImage } from "./transform.js";
import { ipAllowed, referrerAllowed } from "./rules.js";
import { SHARE_PREFIX, handleShare, parseSharePath } from "./share.js";
import { GALLERY_RE, galleryPage, hexToUuid, type GalleryView } from "./gallery.js";
import { UPLOAD_PREFIX, handleUploadLink, parseUploadPath } from "./upload-link.js";
import { REPORT_PATH, reportForm, reportLink, reportReceived, submitReport, unavailable } from "./report.js";

interface LibraryMap {
  o: string;
  l: string;
  v: "public" | "private";
  k: Record<string, string>;
  r: string[];
  ia: string[];
  ib: string[];
  rnd: boolean;
  p: string[];
  /** "suspended": the team is suspended; everything answers 451. */
  s?: string;
  /** Set when the library's files are in a customer bucket (PV7): backend id and key prefix. */
  b?: { i: string; p: string };
}

interface RouteValue {
  k: string;
  m: string;
  s: number;
  e: string;
  v: "public" | "private";
  st: string;
  n: string;
  f: string;
}

export interface ServeDeps {
  cache?: Cache | null;
  now?: () => number;
  /** Monotonic clock for Server-Timing (tests inject one). */
  clock?: () => number;
  waitUntil?: (p: Promise<unknown>) => void;
}

// KV results are cached at each edge location for KV_CACHE_TTL seconds (KV's minimum), so a visibility change or a
// trash reaches every location within about that long (GAPS G50). The isolate keeps maps no longer than KV does.
export const KV_CACHE_TTL = 30;
const MAP_TTL_MS = 15_000;
const mapMemo = new Map<string, { at: number; value: LibraryMap | null }>();

/** Exported for tests: forget the isolate's library maps. */
export function clearMapMemo(): void {
  mapMemo.clear();
}

// Types a browser can show without risk; anything else (HTML, SVG, scripts…) downloads instead of rendering.
const INLINE = /^(image\/(png|jpe?g|gif|webp|avif|bmp|x-icon)|video\/[a-z0-9.+-]+|audio\/[a-z0-9.+-]+|application\/pdf|text\/plain)$/i;
const SAFE_CSP = "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox";

/** Mirrors media-worker's sharing.ts: unset means off in prod, on elsewhere. */
export function publicSharingAllowed(env: { ENVIRONMENT?: string; PUBLIC_SHARING?: string }): boolean {
  if (env.PUBLIC_SHARING === "on") return true;
  if (env.PUBLIC_SHARING === "off") return false;
  return env.ENVIRONMENT !== "prod";
}

function text(status: number, body: string, extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra } });
}
const notFound = () => text(404, "Not found");

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Split and decode "/org/lib/a/b.png" safely. A segment may not decode to "/", "." or "..", or contain controls. */
export function parsePath(pathname: string): { org: string; lib: string; path: string } | null {
  const raw = pathname.split("/").slice(1);
  if (raw.length < 3) return null;
  const parts: string[] = [];
  for (const seg of raw) {
    let d: string;
    try {
      d = decodeURIComponent(seg);
    } catch {
      return null;
    }
    if (!d || d === "." || d === ".." || d.includes("/") || /[\u0000-\u001f\u007f]/.test(d)) return null;
    parts.push(d);
  }
  const [org, lib, ...rest] = parts as [string, string, ...string[]];
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(org) || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(lib)) return null;
  return { org, lib, path: `/${rest.join("/")}` };
}

async function loadMap(env: Env, org: string, lib: string, now: number): Promise<LibraryMap | null> {
  const key = `lib:${org}/${lib}`;
  const memo = mapMemo.get(key);
  if (memo && now - memo.at < MAP_TTL_MS) return memo.value;
  const raw = await env.ROUTES_KV!.get(key, { cacheTtl: KV_CACHE_TTL });
  const value = raw ? (JSON.parse(raw) as LibraryMap) : null;
  mapMemo.set(key, { at: now, value });
  return value;
}

function dispositionFor(mime: string, name: string): string {
  const safe = name.replace(/["\\\r\n]/g, "_");
  const kind = INLINE.test(mime) ? "inline" : "attachment";
  return `${kind}; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function analytics(env: Env, request: Request, map: LibraryMap, route: RouteValue | null, bytes: number, outcome: string, preset: string): void {
  try {
    const ref = request.headers.get("referer");
    let refHost = "";
    try {
      refHost = ref ? new URL(ref).hostname : "";
    } catch {
      refHost = "";
    }
    const country = (request as unknown as { cf?: { country?: string } }).cf?.country ?? "";
    // Library, file, referrer host, country, preset, outcome; bytes. Never an IP address.
    env.SERVE_AE?.writeDataPoint({ blobs: [map.l, route?.f ?? "", refHost, country, preset, outcome], doubles: [bytes], indexes: [map.l] });
  } catch {
    /* analytics never breaks serving */
  }
}

/**
 * Serve one request and report the worker's own time in Server-Timing. In Workers the clock advances only across
 * I/O, so `dur` is the time spent on KV, cache, R2 and Images: the part of TTFB the product controls, apart from the
 * client's network.
 */
export async function serve(request: Request, env: Env, deps: ServeDeps = {}): Promise<Response> {
  const clock = deps.clock ?? (() => performance.now());
  const t0 = clock();
  let res = await handle(request, env, deps);
  const dur = Math.max(0, clock() - t0).toFixed(1);
  try {
    res.headers.set("server-timing", `worker;dur=${dur}`);
  } catch {
    res = new Response(res.body, res);
    res.headers.set("server-timing", `worker;dur=${dur}`);
  }
  return res;
}

async function handle(request: Request, env: Env, deps: ServeDeps): Promise<Response> {
  const now = deps.now?.() ?? Date.now();
  const url = new URL(request.url);
  if (url.pathname === "/health") return Response.json({ status: "ok", service: "serve-worker", environment: env.ENVIRONMENT ?? "local" });
  if (url.pathname === REPORT_PATH) return handleReport(request, env, url, now);
  if (url.pathname.startsWith(UPLOAD_PREFIX)) {
    const token = parseUploadPath(url.pathname);
    // Upload links are public sharing too: off while it is.
    if (!token || !publicSharingAllowed(env)) return notFound();
    return handleUploadLink(request, env, token);
  }
  if (url.pathname.startsWith(SHARE_PREFIX)) {
    const sp = parseSharePath(url.pathname);
    // Share links are public sharing too: off while it is (prod, until W-5/W-6).
    if (!sp || !publicSharingAllowed(env)) return notFound();
    return handleShare(request, env, sp);
  }
  if (request.method !== "GET" && request.method !== "HEAD") return text(405, "Method not allowed", { allow: "GET, HEAD" });
  if (!env.ROUTES_KV || !env.MEDIA_BUCKET) return text(503, "Unavailable");

  const p = parsePath(url.pathname);
  if (!p) return notFound();

  const ip = request.headers.get("cf-connecting-ip") ?? "";
  if (env.SERVE_RL && ip) {
    const { success } = await env.SERVE_RL.limit({ key: ip });
    if (!success) return text(429, "Too many requests", { "retry-after": "60" });
  }

  const map = await loadMap(env, p.org, p.lib, now);
  if (!map) return notFound();
  if (map.s === "suspended") return unavailable();

  if (!ipAllowed(ip, map.ia, map.ib)) return text(403, "Forbidden");
  if (!referrerAllowed(request.headers.get("referer"), map.r, url.hostname)) return text(403, "Hotlinking from this site isn't allowed");

  const publicOk = publicSharingAllowed(env);

  // A public gallery (PV6): a collection the team marked public, showing its public files.
  const g = p.path.match(GALLERY_RE);
  if (g) {
    if (!publicOk || !env.LIBRARY_INDEX) return notFound();
    const ns = env.LIBRARY_INDEX;
    const stub = ns.get(ns.idFromName(`org:${map.o}:lib:${map.l}`)) as unknown as {
      call(scope: { orgId: string; libraryId: string }, req: unknown): Promise<{ ok: boolean; value?: GalleryView | null }>;
    };
    const r = await stub.call({ orgId: map.o, libraryId: map.l }, { op: "gallery", id: hexToUuid(g[1]!) });
    if (!r.ok || !r.value) return notFound();
    analytics(env, request, map, null, 0, "gallery", "");
    return galleryPage(p.org, p.lib, r.value);
  }

  // Random-image API (functions/random/**): a random public image in a folder, as a redirect.
  if (p.path === "/_random") {
    if (!publicOk || !map.rnd || !env.LIBRARY_INDEX) return notFound();
    const folderParam = url.searchParams.get("folder") ?? "/";
    const folder = `/${folderParam.split("/").filter(Boolean).join("/")}`.replace(/^\/$/, "/");
    if (folder.split("/").some((s) => s === "." || s === "..")) return notFound();
    const ns = env.LIBRARY_INDEX;
    const stub = ns.get(ns.idFromName(`org:${map.o}:lib:${map.l}`)) as unknown as {
      call(scope: { orgId: string; libraryId: string }, req: unknown): Promise<{ ok: boolean; value?: { path: string } | null }>;
    };
    const r = await stub.call({ orgId: map.o, libraryId: map.l }, { op: "randomPublic", folder, mimePrefix: "image/" });
    if (!r.ok || !r.value) return notFound();
    const target = `/${p.org}/${p.lib}${r.value.path.split("/").map(encodeURIComponent).join("/")}`;
    analytics(env, request, map, null, 0, "random", "");
    return new Response(null, { status: 302, headers: { location: target, "cache-control": "no-store" } });
  }

  const raw = await env.ROUTES_KV.get(`route:${map.l}:${await sha256Hex(p.path)}`, { cacheTtl: KV_CACHE_TTL });
  if (!raw) return notFound();
  const route = JSON.parse(raw) as RouteValue;
  if (route.st === "removed") return unavailable(); // taken down by an operator
  if (route.st !== "public" && route.st !== "private") return notFound(); // processing, held, flagged: not served (PV4)

  // While public sharing is off (prod, until CSAM scanning and the domain exist), every file needs a signed link.
  const isPrivate = route.v === "private" || route.st === "private" || !publicOk;
  if (isPrivate) {
    const v = await verifyPath(map.k, map.l, p.path, url.searchParams.get("exp"), url.searchParams.get("sig"), Math.floor(now / 1000));
    if (v === "expired") return text(410, "This link has expired");
    if (v !== "ok") return notFound();
  }

  const preset = url.searchParams.get("preset") ?? "";
  let format: string | null = null;
  if (preset) {
    const opts = presetOptions(preset);
    if (!opts || !map.p.includes(preset)) return text(400, `Unknown preset for this library: ${preset.slice(0, 40)}`);
    if (!/^image\/(png|jpe?g|webp|avif|gif)$/i.test(route.m)) return text(400, "Presets apply to images only");
    format = negotiateFormat(request.headers.get("accept"), route.m);
  }

  const etag = preset ? `"${route.e}-${preset}-${format!.split("/")[1]}"` : `"${route.e}"`;
  const baseHeaders: Record<string, string> = {
    etag,
    "cache-control": isPrivate ? "private, no-store" : "public, max-age=300, stale-while-revalidate=86400",
    "x-content-type-options": "nosniff",
    "content-security-policy": SAFE_CSP,
    "cross-origin-resource-policy": "cross-origin",
    vary: "Accept",
    ...(isPrivate ? {} : { "access-control-allow-origin": "*" }),
    // Where to report this file (design §4.9: "link plus header").
    link: `<${reportLink(url.origin, url.pathname)}>; rel="report"`,
  };

  const inm = request.headers.get("if-none-match");
  if (inm && inm.split(",").map((s) => s.trim()).includes(etag)) {
    analytics(env, request, map, route, 0, "not_modified", preset);
    return new Response(null, { status: 304, headers: baseHeaders });
  }

  // Edge cache for public files, keyed by the bytes' hash (a replaced file is a new key; a removed route 404s first).
  const cacheKey = new Request(`https://serve-cache.internal/${route.e}/${preset || "o"}/${format ?? "orig"}`);
  const rangeHeader = request.headers.get("range");
  if (!isPrivate && deps.cache && !rangeHeader) {
    const hit = await deps.cache.match(cacheKey);
    if (hit) {
      analytics(env, request, map, route, Number(hit.headers.get("content-length") ?? 0), "cache", preset);
      const h = new Headers(hit.headers);
      h.set("x-cache", "HIT");
      return new Response(request.method === "HEAD" ? null : hit.body, { status: 200, headers: h });
    }
  }

  // Originals support a single byte range (video seeking, resumable downloads).
  let range: { offset: number; length: number } | undefined;
  if (rangeHeader && !preset) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (m && (m[1] || m[2])) {
      const start = m[1] ? Number(m[1]) : Math.max(0, route.s - Number(m[2]));
      const end = m[1] && m[2] ? Math.min(Number(m[2]), route.s - 1) : route.s - 1;
      if (start > end || start >= route.s) return new Response(null, { status: 416, headers: { "content-range": `bytes */${route.s}` } });
      range = { offset: start, length: end - start + 1 };
    }
  }

  const store: MediaStore | null = map.b ? (env.STORAGE_WORKER ? remoteStore(env.STORAGE_WORKER, { orgId: map.o, libraryId: map.l, backendId: map.b.i, prefix: map.b.p }) : null) : env.MEDIA_BUCKET;
  if (!store) return text(503, "Unavailable");
  let obj: StoredObject | null;
  try {
    obj = await store.get(route.k, range ? { range } : undefined);
  } catch {
    // The customer's bucket refused or didn't answer: say so without detail (the team sees the code in the app).
    return text(502, "The storage for this file isn't answering");
  }
  if (!obj || !("body" in obj)) return notFound();

  let body: ReadableStream | null = obj.body;
  let contentType = route.m;
  let length = range ? range.length : route.s;
  if (preset && format) {
    const out = await transformImage(env, obj.body, presetOptions(preset)!, format, route.m);
    if (!out) return text(503, "Image transformations are unavailable right now");
    body = out.body;
    contentType = format;
    length = Number(out.headers.get("content-length") ?? 0);
  }

  const headers = new Headers(baseHeaders);
  headers.set("content-type", contentType);
  headers.set("content-disposition", dispositionFor(contentType, route.n));
  headers.set("accept-ranges", preset ? "none" : "bytes");
  if (length) headers.set("content-length", String(length));
  if (range) headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${route.s}`);
  headers.set("x-cache", "MISS");

  const status = range ? 206 : 200;
  analytics(env, request, map, route, length, preset ? "transform" : "origin", preset);
  if (request.method === "HEAD") {
    await body?.cancel();
    return new Response(null, { status, headers });
  }
  if (!isPrivate && deps.cache && status === 200 && body) {
    const [a, b] = body.tee();
    const toCache = new Response(b, { status: 200, headers });
    const put = deps.cache.put(cacheKey, toCache);
    if (deps.waitUntil) deps.waitUntil(put);
    else await put;
    return new Response(a, { status, headers });
  }
  return new Response(body, { status, headers });
}

const REPORT_CATEGORIES = new Set(["csam", "sexual", "violence", "hate", "harassment", "copyright", "malware", "spam", "other"]);

/** GET /_report?u=<path>: the form. POST /_report: send it (rate-limited per IP). */
async function handleReport(request: Request, env: Env, url: URL, now: number): Promise<Response> {
  if (request.method === "GET") {
    const u = url.searchParams.get("u") ?? "";
    return parsePath(u) ? reportForm(u) : notFound();
  }
  if (request.method !== "POST") return text(405, "Method not allowed", { allow: "GET, POST" });
  const ip = request.headers.get("cf-connecting-ip") ?? "";
  if (env.SERVE_REPORT_RL && ip) {
    const { success } = await env.SERVE_REPORT_RL.limit({ key: `report:${ip}` });
    if (!success) return text(429, "Too many reports from your address; try again in a minute", { "retry-after": "60" });
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return text(400, "Invalid form");
  }
  const u = String(form.get("u") ?? "");
  const category = String(form.get("category") ?? "");
  const details = String(form.get("details") ?? "").slice(0, 2000);
  const email = String(form.get("email") ?? "").trim().slice(0, 254);
  const p = parsePath(u);
  if (!p) return notFound();
  if (!REPORT_CATEGORIES.has(category)) return reportForm(u, "Choose what's wrong with the file.");
  if (!env.ROUTES_KV) return text(503, "Unavailable");
  const map = await loadMap(env, p.org, p.lib, now);
  if (!map) return notFound();
  const raw = await env.ROUTES_KV.get(`route:${map.l}:${await sha256Hex(p.path)}`, { cacheTtl: KV_CACHE_TTL });
  if (!raw) return notFound();
  const route = JSON.parse(raw) as RouteValue;
  if (route.st === "removed") return reportReceived(); // already taken down
  const ok = await submitReport(env, { orgId: map.o, libraryId: map.l, fileId: route.f, sha256: route.e }, { category, details, email });
  return ok ? reportReceived() : text(503, "We couldn't record your report; please try again");
}
