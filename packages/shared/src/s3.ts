// Derived from MarSeventh/CloudFlare-ImgBed@611153e:functions/utils/storage/s3Client.js (MIT), modified.
// ImgBed built an AWS SDK S3Client from a channel's settings (endpoint, region defaulting to "auto", path style, and
// a printable-ASCII User-Agent some providers bind keys to). Here the same settings drive a small SigV4 client on
// WebCrypto, with no SDK: it signs requests, presigns URLs, and covers the object, multipart, list and CORS calls a
// customer bucket needs (PV7). A whole-object PUT signs the payload's SHA-256, so the bucket itself refuses bytes
// that don't match the hash we expect; streamed parts are UNSIGNED-PAYLOAD and the file is hashed again at commit.
//
// Credentials live in memory for one request only; nothing here logs them, and errors carry the S3 error code, never
// a URL with a signature.

export interface S3Config {
  /** https://… (or http:// for a local test server). */
  endpoint: string;
  region?: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Address the bucket in the path (https://host/bucket/key) instead of the host name. */
  pathStyle?: boolean;
  userAgent?: string;
}

export class S3Error extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`S3 ${status} ${code}`);
  }
}

const enc = new TextEncoder();
const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
async function sha256Hex(data: Uint8Array | string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", typeof data === "string" ? enc.encode(data) : (data as Uint8Array<ArrayBuffer>)));
}
async function hmac(key: Uint8Array | string, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", typeof key === "string" ? enc.encode(key) : (key as Uint8Array<ArrayBuffer>), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}

/** RFC 3986 encoding as SigV4 wants it; "/" kept in object keys. */
export function uriEncode(s: string, keepSlash = false): string {
  return Array.from(enc.encode(s), (b) => {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9\-._~]/.test(c) || (keepSlash && c === "/")) return c;
    return `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }).join("");
}

export function normalizeUserAgent(value: string | undefined): string {
  if (value == null) return "";
  if (/[^\x20-\x7e]/.test(value)) throw new Error("S3 User-Agent must contain printable ASCII characters only");
  return value.trim();
}

/** The URL for a key, path-style or virtual-hosted. */
export function objectUrl(cfg: S3Config, key: string, query: Record<string, string> = {}): URL {
  const base = new URL(cfg.endpoint);
  const path = `/${uriEncode(key, true)}`;
  const url = cfg.pathStyle ? new URL(`${base.origin}/${uriEncode(cfg.bucket)}${key ? path : ""}`) : new URL(`${base.protocol}//${cfg.bucket}.${base.host}${key ? path : "/"}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return url;
}

function canonicalQuery(url: URL): string {
  const pairs: (readonly [string, string])[] = [];
  url.searchParams.forEach((v, k) => pairs.push([uriEncode(k), uriEncode(v)] as const));
  return pairs
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

async function signingKey(secret: string, date: string, region: string): Promise<Uint8Array> {
  const kDate = await hmac(`AWS4${secret}`, date);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, "s3");
  return hmac(kService, "aws4_request");
}

const amzDate = (d: Date) => d.toISOString().replace(/[:-]|\.\d{3}/g, "");

/**
 * SigV4 headers for one request. `payloadHash` is the hex SHA-256 of the body, or "UNSIGNED-PAYLOAD".
 * Returns every header to send (host is set by fetch from the URL).
 */
export async function signHeaders(
  cfg: S3Config,
  method: string,
  url: URL,
  headers: Record<string, string>,
  payloadHash: string,
  now = new Date(),
): Promise<Record<string, string>> {
  const region = cfg.region || "auto";
  const t = amzDate(now);
  const date = t.slice(0, 8);
  const all: Record<string, string> = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v.trim()])), host: url.host, "x-amz-date": t, "x-amz-content-sha256": payloadHash };
  const names = Object.keys(all).sort();
  const canonical = [method, url.pathname, canonicalQuery(url), names.map((n) => `${n}:${all[n]}\n`).join(""), names.join(";"), payloadHash].join("\n");
  const scope = `${date}/${region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", t, scope, await sha256Hex(canonical)].join("\n");
  const sig = hex((await hmac(await signingKey(cfg.secretAccessKey, date, region), toSign)).buffer as ArrayBuffer);
  const out = { ...all, authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${sig}` };
  delete (out as Record<string, string>).host;
  return out;
}

/** A presigned URL (query-string auth), valid for `expiresIn` seconds (1 s to 7 days). */
export async function presign(cfg: S3Config, method: "GET" | "PUT" | "HEAD", key: string, expiresIn: number, now = new Date()): Promise<string> {
  const region = cfg.region || "auto";
  const t = amzDate(now);
  const date = t.slice(0, 8);
  const scope = `${date}/${region}/s3/aws4_request`;
  const url = objectUrl(cfg, key, {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${cfg.accessKeyId}/${scope}`,
    "X-Amz-Date": t,
    "X-Amz-Expires": String(Math.max(1, Math.min(604800, Math.floor(expiresIn)))),
    "X-Amz-SignedHeaders": "host",
  });
  const canonical = [method, url.pathname, canonicalQuery(url), `host:${url.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", t, scope, await sha256Hex(canonical)].join("\n");
  url.searchParams.set("X-Amz-Signature", hex((await hmac(await signingKey(cfg.secretAccessKey, date, region), toSign)).buffer as ArrayBuffer));
  return url.toString();
}

export interface S3Deps {
  fetch?: typeof fetch;
  now?: () => Date;
}

async function errorOf(res: Response): Promise<S3Error> {
  let code = `Http${res.status}`;
  try {
    const m = (await res.text()).match(/<Code>([^<]{1,64})<\/Code>/);
    if (m) code = m[1]!;
  } catch {
    /* keep the status */
  }
  return new S3Error(res.status, code);
}

/** A small S3 client for one bucket. */
export function s3Client(cfg: S3Config, deps: S3Deps = {}) {
  const f = deps.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const now = deps.now ?? (() => new Date());
  const ua = normalizeUserAgent(cfg.userAgent);

  async function send(method: string, url: URL, opts: { headers?: Record<string, string>; body?: BodyInit | null; payloadHash?: string } = {}): Promise<Response> {
    const headers = await signHeaders(cfg, method, url, { ...(ua ? { "user-agent": ua } : {}), ...(opts.headers ?? {}) }, opts.payloadHash ?? EMPTY_SHA, now());
    return f(url.toString(), { method, headers, body: opts.body ?? null, redirect: "manual" });
  }

  return {
    /** Store bytes; the bucket refuses them unless they hash to `sha256` (hex), when given. */
    async put(key: string, bytes: Uint8Array, opts: { contentType?: string; sha256?: string } = {}): Promise<void> {
      const payloadHash = opts.sha256 ?? (await sha256Hex(bytes));
      const res = await send("PUT", objectUrl(cfg, key), { headers: { "content-type": opts.contentType ?? "application/octet-stream" }, body: bytes as unknown as BodyInit, payloadHash });
      if (!res.ok) throw await errorOf(res);
    },
    /** The object's bytes (optionally a range), or null when it doesn't exist. */
    async get(key: string, range?: string): Promise<Response | null> {
      const res = await send("GET", objectUrl(cfg, key), { headers: range ? { range } : {} });
      if (res.status === 404) {
        // A missing bucket is a broken store, not a missing file.
        const e = await errorOf(res);
        if (e.code === "NoSuchBucket") throw e;
        return null;
      }
      if (!res.ok) throw await errorOf(res);
      return res;
    },
    async head(key: string): Promise<{ size: number; etag: string; contentType: string } | null> {
      const res = await send("HEAD", objectUrl(cfg, key));
      if (res.status === 404) return null;
      if (!res.ok) throw new S3Error(res.status, `Http${res.status}`);
      return { size: Number(res.headers.get("content-length") ?? 0), etag: (res.headers.get("etag") ?? "").replace(/"/g, ""), contentType: res.headers.get("content-type") ?? "" };
    },
    async delete(key: string): Promise<void> {
      const res = await send("DELETE", objectUrl(cfg, key));
      if (res.ok) return;
      const e = await errorOf(res);
      if (res.status !== 404 || e.code === "NoSuchBucket") throw e;
    },
    /** Keys under a prefix (at most `max`, up to 1000). */
    async list(prefix: string, max = 100): Promise<{ key: string; size: number }[]> {
      const res = await send("GET", objectUrl(cfg, "", { "list-type": "2", prefix, "max-keys": String(Math.min(1000, max)) }));
      if (!res.ok) throw await errorOf(res);
      const xml = await res.text();
      return [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((m) => ({
        key: decodeXml(m[1]!.match(/<Key>([\s\S]*?)<\/Key>/)?.[1] ?? ""),
        size: Number(m[1]!.match(/<Size>(\d+)<\/Size>/)?.[1] ?? 0),
      }));
    },
    async createMultipart(key: string, contentType = "application/octet-stream"): Promise<string> {
      const res = await send("POST", objectUrl(cfg, key, { uploads: "" }), { headers: { "content-type": contentType } });
      if (!res.ok) throw await errorOf(res);
      const id = (await res.text()).match(/<UploadId>([^<]+)<\/UploadId>/)?.[1];
      if (!id) throw new S3Error(502, "NoUploadId");
      return decodeXml(id);
    },
    /**
     * One part (UNSIGNED-PAYLOAD). S3 needs a Content-Length, which a Blob or byte body carries; on Workers, pass a
     * stream through a FixedLengthStream so its length is known. Content-Length isn't signed (runtimes may set it).
     */
    async uploadPart(key: string, uploadId: string, partNumber: number, body: BodyInit): Promise<{ partNumber: number; etag: string }> {
      const res = await send("PUT", objectUrl(cfg, key, { partNumber: String(partNumber), uploadId }), { body, payloadHash: "UNSIGNED-PAYLOAD" });
      if (!res.ok) throw await errorOf(res);
      return { partNumber, etag: res.headers.get("etag") ?? "" };
    },
    async completeMultipart(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<void> {
      const xml = `<CompleteMultipartUpload>${[...parts]
        .sort((a, b) => a.partNumber - b.partNumber)
        .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${escapeXml(p.etag)}</ETag></Part>`)
        .join("")}</CompleteMultipartUpload>`;
      const body = enc.encode(xml);
      const res = await send("POST", objectUrl(cfg, key, { uploadId }), { headers: { "content-type": "application/xml" }, body: body as unknown as BodyInit, payloadHash: await sha256Hex(body) });
      // S3 can answer 200 with an error document.
      const text = res.ok ? await res.text() : "";
      if (!res.ok) throw await errorOf(res);
      if (/<Error>/.test(text)) throw new S3Error(500, text.match(/<Code>([^<]{1,64})<\/Code>/)?.[1] ?? "CompleteFailed");
    },
    async abortMultipart(key: string, uploadId: string): Promise<void> {
      const res = await send("DELETE", objectUrl(cfg, key, { uploadId }));
      if (!res.ok && res.status !== 404) throw await errorOf(res);
    },
    presign: (method: "GET" | "PUT" | "HEAD", key: string, expiresIn: number) => presign(cfg, method, key, expiresIn, now()),
  };
}

export type S3Client = ReturnType<typeof s3Client>;

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
}
function decodeXml(s: string): string {
  return s.replace(/&(lt|gt|amp|apos|quot);/g, (_, e: string) => ({ lt: "<", gt: ">", amp: "&", apos: "'", quot: '"' })[e]!);
}
