// storage-worker (PV7): the only place a customer bucket's credentials are opened (design §4.4, the brief's rule).
// It has no public route (workers_dev off); media-worker and serve-worker reach it over service bindings, after
// they have authorised the caller. It tests a bucket, stores its credentials sealed (envelope.ts), checks its
// health, and runs object operations on it for one (org, library) at a time: every call names the backend, org and
// library, and every key must sit under the backend's prefix. Errors carry S3 codes, never URLs, keys or secrets.

import { createSqlExecutor } from "@saas/db/d1";
import { createMediaRepository, type StorageBackend } from "@saas/db/media";
import { S3Error, s3Client, type S3Config } from "@saas/shared/s3";
import { aadFor, open, parseKek, seal, type BucketSecret } from "./envelope.js";
import { validateBucket, validateSecret, type BucketInput } from "./endpoint.js";

export interface Env {
  ENVIRONMENT?: string;
  PLATFORM_DB?: D1Database;
  /** 64 hex characters; generated in CI on first deploy and never logged (component.yaml). */
  STORAGE_KEK?: string;
  /** "true" only in tests: allows http and local endpoints. */
  ALLOW_TEST_ENDPOINTS?: string;
}

export interface Deps {
  fetch?: typeof fetch;
  now?: () => Date;
  /** Overrides the deadline (tests). */
  timeoutMs?: number;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(status < 400 ? { data } : { error: data }), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const fail = (status: number, code: string, message: string, details: Record<string, unknown> = {}) => json({ code, message, details }, status);
const codeOf = (e: unknown) => (e instanceof S3Error ? e.code : ["AbortError", "TimeoutError"].includes((e as { name?: string } | null)?.name ?? "") ? "Timeout" : "Unreachable");

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const b = (await request.json()) as unknown;
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function configOf(b: BucketInput, s: BucketSecret): S3Config {
  return { endpoint: b.endpoint, region: b.region, bucket: b.bucket, pathStyle: b.pathStyle, accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey };
}

/**
 * Prove a bucket works: write a small object under the prefix, read its size and bytes back, find it in a listing,
 * delete it. Each step is reported; the first failure stops the run.
 */
export async function checkBucket(cfg: S3Config, prefix: string, deps: Deps = {}): Promise<{ ok: boolean; steps: { step: string; ok: boolean; code?: string }[] }> {
  const c = s3Client(cfg, deps);
  const key = `${prefix}.pixvault-check/${crypto.randomUUID()}`;
  const bytes = crypto.getRandomValues(new Uint8Array(64));
  const steps: { step: string; ok: boolean; code?: string }[] = [];
  const run = async (step: string, fn: () => Promise<boolean>) => {
    if (steps.some((s) => !s.ok)) return;
    try {
      const ok = await fn();
      steps.push(ok ? { step, ok } : { step, ok, code: "Mismatch" });
    } catch (e) {
      steps.push({ step, ok: false, code: codeOf(e) });
    }
  };
  await run("put", async () => (await c.put(key, bytes, { contentType: "application/octet-stream" }), true));
  await run("head", async () => (await c.head(key))?.size === 64);
  await run("get", async () => {
    const r = await c.get(key);
    const got = new Uint8Array(await r!.arrayBuffer());
    return got.length === 64 && got.every((b, i) => b === bytes[i]);
  });
  await run("list", async () => (await c.list(`${prefix}.pixvault-check/`, 1000)).some((o) => o.key === key));
  await run("delete", async () => (await c.delete(key), (await c.head(key)) === null));
  return { ok: steps.length === 5 && steps.every((s) => s.ok), steps };
}

// Sealed rows (never opened credentials) are kept for a minute per isolate, so object calls don't each wait on D1.
const ROW_TTL_MS = 60_000;
const rows = new Map<string, { at: number; row: StorageBackend }>();

async function backendFor(env: Env, orgId: string, libraryId: string, backendId: string): Promise<StorageBackend | null> {
  const k = `${orgId}:${libraryId}:${backendId}`;
  const hit = rows.get(k);
  if (hit && Date.now() - hit.at < ROW_TTL_MS) return hit.row;
  const r = await createMediaRepository(createSqlExecutor(env.PLATFORM_DB!)).getStorageBackendById(orgId, libraryId, backendId);
  if (!r.ok) return null;
  rows.set(k, { at: Date.now(), row: r.value });
  return r.value;
}

/** For tests. */
export function clearRowCache(): void {
  rows.clear();
}

/** A client for a stored backend, its credentials opened for this request only. */
async function clientFor(env: Env, kek: Uint8Array, b: StorageBackend, deps: Deps) {
  if (b.kind !== "s3-compatible" || b.status === "retired" || !b.credentialRef || !b.endpoint || !b.bucket) return null;
  const secret = await open(kek, b.credentialRef, aadFor(b.orgId, b.libraryId, b.id));
  if (!secret) return null;
  return s3Client({ endpoint: b.endpoint, region: b.region ?? "auto", bucket: b.bucket, pathStyle: b.pathStyle === true, ...secret }, deps);
}

/** Every request to a customer's endpoint has a deadline, so a slow or hostile server can't hold a request open. */
export const CHECK_TIMEOUT_MS = 15_000;
export const OBJECT_TIMEOUT_MS = 120_000;
function withDeadline(deps: Deps, ms: number): Deps {
  const f = deps.fetch ?? fetch;
  const timed = ((input: RequestInfo | URL, init?: RequestInit) => f(input, { ...init, signal: AbortSignal.timeout(deps.timeoutMs ?? ms) })) as typeof fetch;
  return { ...deps, fetch: timed };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function handle(request: Request, env: Env, baseDeps: Deps = {}): Promise<Response> {
  const url = new URL(request.url);
  const deps = withDeadline(baseDeps, url.pathname === "/v1/storage/objects" ? OBJECT_TIMEOUT_MS : CHECK_TIMEOUT_MS);
  const now = deps.now ?? (() => new Date());
  const kek = parseKek(env.STORAGE_KEK);
  if (url.pathname === "/health") return Response.json({ status: kek ? "ok" : "degraded", service: "storage-worker", kek: !!kek });
  if (!env.PLATFORM_DB) return fail(503, "unavailable", "Storage unavailable");
  const allowTest = env.ALLOW_TEST_ENDPOINTS === "true";

  // POST /v1/storage/check { endpoint, region, bucket, prefix, pathStyle, accessKeyId, secretAccessKey }
  if (url.pathname === "/v1/storage/check" && request.method === "POST") {
    const body = await readJson(request);
    const b = validateBucket(body, allowTest);
    const s = validateSecret(body);
    if (!b.ok || !s.ok) return fail(422, "validation_error", "Check the bucket settings", { fields: { ...(b.ok ? {} : b.fields), ...(s.ok ? {} : s.fields) } });
    return json(await checkBucket(configOf(b.value, s.value), b.value.prefix, deps));
  }

  // POST /v1/storage/backends { orgId, libraryId, …bucket, …secret }: test, then store sealed.
  if (url.pathname === "/v1/storage/backends" && request.method === "POST") {
    if (!kek) return fail(503, "unavailable", "Storage isn't ready yet");
    const body = await readJson(request);
    const orgId = String(body.orgId ?? "");
    const libraryId = String(body.libraryId ?? "");
    if (!UUID.test(orgId) || !UUID.test(libraryId)) return fail(422, "validation_error", "Bad scope");
    const b = validateBucket(body, allowTest);
    const s = validateSecret(body);
    if (!b.ok || !s.ok) return fail(422, "validation_error", "Check the bucket settings", { fields: { ...(b.ok ? {} : b.fields), ...(s.ok ? {} : s.fields) } });
    const check = await checkBucket(configOf(b.value, s.value), b.value.prefix, deps);
    if (!check.ok) return fail(409, "bucket_check_failed", "The bucket didn't pass the check", { steps: check.steps });
    const id = crypto.randomUUID();
    const sealed = await seal(kek, s.value, aadFor(orgId, libraryId, id));
    const repo = createMediaRepository(createSqlExecutor(env.PLATFORM_DB));
    const r = await repo.createStorageBackend({ id, orgId, libraryId, ...b.value, credentialRef: sealed, status: "active", at: now() });
    if (!r.ok) return fail(503, "unavailable", "Storage unavailable");
    return json({ backend: publicBackend(r.value), steps: check.steps }, 201);
  }

  // POST /v1/storage/backends/check { orgId, libraryId, backendId }: health check, recorded.
  if (url.pathname === "/v1/storage/backends/check" && request.method === "POST") {
    if (!kek) return fail(503, "unavailable", "Storage isn't ready yet");
    const body = await readJson(request);
    const [orgId, libraryId, backendId] = [String(body.orgId ?? ""), String(body.libraryId ?? ""), String(body.backendId ?? "")];
    if (![orgId, libraryId, backendId].every((x) => UUID.test(x))) return fail(422, "validation_error", "Bad scope");
    clearRowCache();
    const b = await backendFor(env, orgId, libraryId, backendId);
    if (!b || b.kind !== "s3-compatible" || !b.credentialRef) return fail(404, "not_found", "Not found");
    const secret = await open(kek, b.credentialRef, aadFor(orgId, libraryId, backendId));
    const result = secret
      ? await checkBucket({ endpoint: b.endpoint!, region: b.region ?? "auto", bucket: b.bucket!, pathStyle: b.pathStyle === true, ...secret }, b.prefix, deps)
      : { ok: false, steps: [{ step: "open", ok: false, code: "CredentialsUnreadable" }] };
    const code = result.ok ? null : (result.steps.find((x) => !x.ok)?.code ?? "Failed");
    await createMediaRepository(createSqlExecutor(env.PLATFORM_DB)).recordStorageCheck(backendId, result.ok, code, now());
    clearRowCache();
    return json({ ok: result.ok, steps: result.steps });
  }

  // Object operations: /v1/storage/objects?orgId=&libraryId=&backendId=&key=[&op=…]
  if (url.pathname === "/v1/storage/objects") {
    if (!kek) return fail(503, "unavailable", "Storage isn't ready yet");
    const q = url.searchParams;
    const [orgId, libraryId, backendId] = [q.get("orgId") ?? "", q.get("libraryId") ?? "", q.get("backendId") ?? ""];
    const key = q.get("key") ?? "";
    if (![orgId, libraryId, backendId].every((x) => UUID.test(x)) || !key || key.length > 1024) return fail(422, "validation_error", "Bad request");
    const b = await backendFor(env, orgId, libraryId, backendId);
    if (!b) return fail(404, "not_found", "Not found");
    // Tenancy: a key outside the backend's prefix, or one walking out of it, is never touched.
    if (!key.startsWith(b.prefix) || key.split("/").some((p) => p === ".." || p === ".")) return fail(404, "not_found", "Not found");
    const c = await clientFor(env, kek, b, deps);
    if (!c) return fail(409, "backend_unavailable", "This storage isn't usable right now");
    const op = q.get("op") ?? (request.method === "PUT" ? "put" : request.method === "DELETE" ? "delete" : request.method === "HEAD" ? "head" : "get");
    try {
      switch (op) {
        case "get": {
          const r = await c.get(key, request.headers.get("range") ?? undefined);
          if (!r) return fail(404, "not_found", "Not found");
          const headers = new Headers();
          for (const h of ["content-type", "content-length", "content-range", "etag", "last-modified"]) {
            const v = r.headers.get(h);
            if (v) headers.set(h, v);
          }
          return new Response(r.body, { status: r.status, headers });
        }
        case "head": {
          const h = await c.head(key);
          return h ? json(h) : fail(404, "not_found", "Not found");
        }
        case "put": {
          const sha = q.get("sha256") ?? undefined;
          if (sha !== undefined && !/^[0-9a-f]{64}$/.test(sha)) return fail(422, "validation_error", "Bad sha256");
          const bytes = new Uint8Array(await request.arrayBuffer());
          // Checked here too: not every S3-compatible server compares the signed payload hash with the body.
          if (sha) {
            const got = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((x) => x.toString(16).padStart(2, "0")).join("");
            if (got !== sha) return fail(422, "checksum_mismatch", "The bytes don't match their checksum");
          }
          await c.put(key, bytes, { contentType: q.get("contentType") ?? "application/octet-stream", ...(sha ? { sha256: sha } : {}) });
          return json({ stored: true, size: bytes.length });
        }
        case "delete":
          await c.delete(key);
          return json({ deleted: true });
        case "createMultipart":
          return json({ uploadId: await c.createMultipart(key, q.get("contentType") ?? "application/octet-stream") });
        case "uploadPart": {
          const n = Number(q.get("partNumber"));
          const uploadId = q.get("uploadId") ?? "";
          if (!Number.isInteger(n) || n < 1 || n > 10000 || !uploadId) return fail(422, "validation_error", "Bad part");
          return json(await c.uploadPart(key, uploadId, n, new Uint8Array(await request.arrayBuffer())));
        }
        case "completeMultipart": {
          const body = await readJson(request);
          const parts = Array.isArray(body.parts) ? (body.parts as { partNumber: number; etag: string }[]) : [];
          if (!parts.length || parts.length > 10000) return fail(422, "validation_error", "Bad parts");
          await c.completeMultipart(key, String(body.uploadId ?? ""), parts);
          return json({ completed: true });
        }
        case "abortMultipart":
          await c.abortMultipart(key, q.get("uploadId") ?? "");
          return json({ aborted: true });
        default:
          return fail(422, "validation_error", "Unknown operation");
      }
    } catch (e) {
      return fail(502, "storage_error", "The storage refused the request", { code: codeOf(e) });
    }
  }
  return fail(404, "not_found", "Not found");
}

function publicBackend(b: StorageBackend) {
  // Never the sealed credentials.
  return { id: b.id, kind: b.kind, endpoint: b.endpoint, region: b.region, bucket: b.bucket, prefix: b.prefix, pathStyle: b.pathStyle, status: b.status, lastCheckAt: b.lastCheckAt, lastError: b.lastError };
}

export default {
  fetch: (request: Request, env: Env) => handle(request, env),
} satisfies ExportedHandler<Env>;
