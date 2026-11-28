// A library's storage (PV7, PV-46): see where its files live, test a customer bucket, attach one, check its health,
// and go back to managed storage. Library managers only (`storage.manage`; everyone else gets 404). Bucket keys pass
// through to storage-worker once and are never stored here, returned or logged.
//
// Changing storage is allowed only while the library holds nothing: the library's index takes a short lock, so no
// upload can start or finish meanwhile. Moving existing files is a migration (PV-47).

import type { StorageBackend } from "@saas/db/media";
import { audit, type Ctx } from "../ctx.js";
import { errorResponse, successResponse, validationError } from "../http.js";
import { IndexCallError, indexFor } from "../index-do/client.js";
import { logError } from "../log.js";
import { orgSuspended, publishLibraryMap } from "../serving.js";
import { backendKey, forgetStore, storeChoice } from "../storage/stores.js";
import { loadAuthorized } from "./libraries.js";

export const SWITCH_LOCK_MS = 60_000;
const BACKEND_PREFIX = "stb_";
const HEX32 = /^[0-9a-f]{32}$/;

export const backendPublicId = (uuid: string) => BACKEND_PREFIX + uuid.replace(/-/g, "");
export function parseBackendPublicId(s: string): string | null {
  if (!s.startsWith(BACKEND_PREFIX)) return null;
  const h = s.slice(BACKEND_PREFIX.length);
  return HEX32.test(h) ? `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}` : null;
}

/** A storage change already under way answers 409, not 503. */
async function begin<T>(ctx: Ctx, call: () => Promise<T>): Promise<T | Response> {
  try {
    return await call();
  } catch (e) {
    if (e instanceof IndexCallError && e.code === "conflict") return errorResponse("storage_changing", "A storage change is already in progress", 409, ctx.requestId);
    throw e;
  }
}

/** What a manager sees: never the sealed credentials. */
export function backendView(b: StorageBackend) {
  return {
    id: backendPublicId(b.id),
    kind: b.kind,
    ...(b.kind === "s3-compatible" ? { endpoint: b.endpoint, region: b.region, bucket: b.bucket, prefix: b.prefix, pathStyle: b.pathStyle === true } : {}),
    status: b.status,
    lastCheckAt: b.lastCheckAt ?? null,
    lastError: b.lastError ?? null,
    createdAt: b.createdAt ?? null,
  };
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const b = (await request.json()) as unknown;
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Only the fields storage-worker takes; anything else in the body is dropped. */
function bucketFields(b: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const k of ["endpoint", "region", "bucket", "prefix", "pathStyle", "accessKeyId", "secretAccessKey"]) if (k in b) out[k] = b[k];
  return out;
}

async function callStorage(ctx: Ctx, path: string, body: unknown): Promise<{ status: number; json: { data?: unknown; error?: { code: string; message: string; details?: Record<string, unknown> } } } | null> {
  if (!ctx.env.STORAGE_WORKER) return null;
  try {
    const res = await ctx.env.STORAGE_WORKER.fetch(`https://storage.internal${path}`, { method: "POST", headers: { "content-type": "application/json", "x-request-id": ctx.requestId }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as never };
  } catch {
    logError(ctx.requestId, "storage.call", "storage-worker unreachable");
    return null;
  }
}

/** storage-worker's refusal, passed on: its field errors and check steps carry no secrets. */
function relay(ctx: Ctx, r: NonNullable<Awaited<ReturnType<typeof callStorage>>>): Response {
  const e = r.json.error ?? { code: "internal_error", message: "Service unavailable" };
  if (r.status === 422) return validationError(ctx.requestId, (e.details?.fields as Record<string, string[]>) ?? {});
  if (r.status === 409) return errorResponse("bucket_check_failed", "The bucket didn't pass the check", 409, ctx.requestId, { steps: e.details?.steps ?? [] });
  return errorResponse("internal_error", "Storage is unavailable right now", 503, ctx.requestId);
}

/** GET …/libraries/{lib}/storage */
export async function handleGetStorage(ctx: Ctx, orgId: string, libraryId: string): Promise<Response> {
  const a = await loadAuthorized(ctx, orgId, libraryId, "storage.manage");
  if (!a.ok) return a.response;
  const r = await ctx.repo.listStorageBackends(orgId, libraryId);
  if (!r.ok) return errorResponse("internal_error", "Service unavailable", 503, ctx.requestId);
  const current = r.value.find((b) => b.status === "active" || b.status === "error") ?? null;
  const idx = indexFor(ctx.env, { orgId, libraryId });
  const [m, holds] = await Promise.all([
    idx.call<Record<string, unknown> | null>({ op: "migration" }),
    idx.call<{ files: number; blobs: number; uploads: number }>({ op: "storageHolds", nowIso: ctx.now().toISOString() }),
  ]);
  const migration = m ? { id: m.id, state: m.state, copied: m.copied ?? 0, missing: m.missing ?? 0, total: m.total ?? null, error: m.error ?? null, at: m.at ?? null, to: m.to === "managed" ? "managed" : backendPublicId(String(m.to)) } : null;
  return successResponse({ current: current ? backendView(current) : null, history: r.value.map(backendView), migration, holds: { files: Math.max(holds.files, holds.blobs), uploads: holds.uploads } }, ctx.requestId);
}

/** POST …/libraries/{lib}/storage/check: test a bucket without attaching it. */
export async function handleCheckBucket(ctx: Ctx, request: Request, orgId: string, libraryId: string): Promise<Response> {
  const a = await loadAuthorized(ctx, orgId, libraryId, "storage.manage");
  if (!a.ok) return a.response;
  const body = await readBody(request);
  if (!body) return validationError(ctx.requestId, { body: ["Invalid JSON"] });
  const allowed = await indexFor(ctx.env, { orgId, libraryId }).call<boolean>({ op: "noteStorageCheck", nowIso: ctx.now().toISOString() });
  if (!allowed) return errorResponse("rate_limited", "Too many bucket checks for this library; try again within the hour", 429, ctx.requestId);
  const r = await callStorage(ctx, "/v1/storage/check", bucketFields(body));
  if (!r) return errorResponse("internal_error", "Storage is unavailable right now", 503, ctx.requestId);
  if (r.status !== 200) return relay(ctx, r);
  return successResponse(r.json.data, ctx.requestId);
}

/** POST …/libraries/{lib}/storage: attach a customer bucket (tested first; library must be empty). */
export async function handleAttachBucket(ctx: Ctx, request: Request, orgId: string, libraryId: string): Promise<Response> {
  const a = await loadAuthorized(ctx, orgId, libraryId, "storage.manage");
  if (!a.ok) return a.response;
  const body = await readBody(request);
  if (!body) return validationError(ctx.requestId, { body: ["Invalid JSON"] });
  const idx = indexFor(ctx.env, { orgId, libraryId, actor: ctx.actor.subjectId });
  if (!(await idx.call<boolean>({ op: "noteStorageCheck", nowIso: ctx.now().toISOString() }))) {
    return errorResponse("rate_limited", "Too many bucket checks for this library; try again within the hour", 429, ctx.requestId);
  }
  const now = ctx.now();
  const begun = await begin(ctx, () => idx.call<{ ok: true } | { ok: false; files: number; blobs: number; uploads: number }>({
    op: "beginStorageSwitch",
    nowIso: now.toISOString(),
    untilIso: new Date(now.getTime() + SWITCH_LOCK_MS).toISOString(),
  }));
  if (begun instanceof Response) return begun;
  if (!begun.ok) {
    return errorResponse("library_not_empty", "Storage can only be changed this way while the library is empty; move its files with a migration (POST …/storage/migrations)", 409, ctx.requestId, { files: begun.files, uploads: begun.uploads });
  }
  let newBackend: string | null = null;
  try {
    const r = await callStorage(ctx, "/v1/storage/backends", { orgId, libraryId, ...bucketFields(body) });
    if (!r) return errorResponse("internal_error", "Storage is unavailable right now", 503, ctx.requestId);
    if (r.status !== 201) return relay(ctx, r);
    const created = (r.json.data as { backend: { id: string } }).backend;
    newBackend = created.id;
    const row = await ctx.repo.getStorageBackendById(orgId, libraryId, created.id);
    if (!row.ok) return errorResponse("internal_error", "Service unavailable", 503, ctx.requestId);
    // Retire older customer backends so "current" is unambiguous; the managed row stays as the fallback.
    const all = await ctx.repo.listStorageBackends(orgId, libraryId);
    if (all.ok) for (const b of all.value) if (b.kind === "s3-compatible" && b.id !== created.id && b.status !== "retired") await ctx.repo.retireStorageBackend(orgId, libraryId, b.id, now);
    return successResponse({ backend: backendView(row.value) }, ctx.requestId, 201);
  } finally {
    await idx.call({ op: "endStorageSwitch", backend: newBackend });
    if (newBackend) {
      forgetStore(orgId, libraryId);
      await publishLibraryMap(ctx.env, a.lib, await orgSuspended(ctx, orgId));
      await audit(ctx, a.lib, "library.storage_attached", `Moved library "${a.lib.name}" to a customer bucket`, { backend: backendPublicId(newBackend) });
    }
  }
}

export const MIGRATION_LOCK_MS = 30 * 60_000;

/**
 * POST …/libraries/{lib}/storage/migrations { target: "managed" } | { target: "bucket", …bucket fields }:
 * move every file to another store (PV-47). The target bucket is tested and stored pending; the copy runs in the
 * background (MigrateStorageWorkflow); uploads and purges wait until it ends.
 */
export async function handleStartMigration(ctx: Ctx, request: Request, orgId: string, libraryId: string): Promise<Response> {
  const a = await loadAuthorized(ctx, orgId, libraryId, "storage.manage");
  if (!a.ok) return a.response;
  const body = await readBody(request);
  if (!body || (body.target !== "managed" && body.target !== "bucket")) return validationError(ctx.requestId, { target: ["Must be managed or bucket"] });
  if (!ctx.env.MIGRATE_STORAGE) return errorResponse("internal_error", "Migration is unavailable right now", 503, ctx.requestId);
  const idx = indexFor(ctx.env, { orgId, libraryId, actor: ctx.actor.subjectId });
  const current = await storeChoice(ctx.env, orgId, libraryId, { fresh: true });
  const from = backendKey(current);
  if (body.target === "managed" && from === "managed") return errorResponse("conflict", "This library already uses managed storage", 409, ctx.requestId);
  if (body.target === "bucket" && !(await idx.call<boolean>({ op: "noteStorageCheck", nowIso: ctx.now().toISOString() }))) {
    return errorResponse("rate_limited", "Too many bucket checks for this library; try again within the hour", 429, ctx.requestId);
  }
  const now = ctx.now();
  const begun = await begin(ctx, () => idx.call<{ ok: true; blobs: number; bytes: number } | { ok: false; files: number; uploads: number }>({
    op: "beginStorageSwitch",
    nowIso: now.toISOString(),
    untilIso: new Date(now.getTime() + MIGRATION_LOCK_MS).toISOString(),
    allowFiles: true,
  }));
  if (begun instanceof Response) return begun;
  if (!begun.ok) return errorResponse("uploads_open", "Wait for uploads in progress to finish (or expire), then try again", 409, ctx.requestId, { uploads: begun.uploads });
  let started = false;
  try {
    let to = "managed";
    if (body.target === "bucket") {
      const r = await callStorage(ctx, "/v1/storage/backends", { orgId, libraryId, ...bucketFields(body), pending: true });
      if (!r) return errorResponse("internal_error", "Storage is unavailable right now", 503, ctx.requestId);
      if (r.status !== 201) return relay(ctx, r);
      to = (r.json.data as { backend: { id: string } }).backend.id;
    }
    const migrationId = crypto.randomUUID();
    await idx.call({ op: "setMigration", migration: { id: migrationId, from, to, state: "copying", copied: 0, missing: 0, total: begun.blobs, bytes: begun.bytes, at: now.toISOString() } });
    await ctx.env.MIGRATE_STORAGE.create({ id: `m${migrationId.replace(/-/g, "")}`, params: { migrationId, orgId, libraryId, from, to } });
    started = true;
    await audit(ctx, a.lib, "library.storage_migration_started", `Started moving library "${a.lib.name}" to ${to === "managed" ? "managed storage" : "a customer bucket"}`, { files: begun.blobs, to: to === "managed" ? "managed" : backendPublicId(to) });
    return successResponse({ migration: { id: migrationId, state: "copying", total: begun.blobs, to: to === "managed" ? "managed" : backendPublicId(to) } }, ctx.requestId, 202);
  } finally {
    if (!started) await idx.call({ op: "endStorageSwitch", backend: null });
  }
}

/** POST …/libraries/{lib}/storage/{stb}/check: run the health check again and record it. */
export async function handleRecheckBucket(ctx: Ctx, orgId: string, libraryId: string, backendPub: string): Promise<Response> {
  const a = await loadAuthorized(ctx, orgId, libraryId, "storage.manage");
  if (!a.ok) return a.response;
  const id = parseBackendPublicId(backendPub);
  if (!id) return errorResponse("not_found", "Not found", 404, ctx.requestId);
  const own = await ctx.repo.getStorageBackendById(orgId, libraryId, id);
  if (!own.ok || own.value.kind !== "s3-compatible") return errorResponse("not_found", "Not found", 404, ctx.requestId);
  if (!(await indexFor(ctx.env, { orgId, libraryId }).call<boolean>({ op: "noteStorageCheck", nowIso: ctx.now().toISOString() }))) {
    return errorResponse("rate_limited", "Too many bucket checks for this library; try again within the hour", 429, ctx.requestId);
  }
  const r = await callStorage(ctx, "/v1/storage/backends/check", { orgId, libraryId, backendId: id });
  if (!r) return errorResponse("internal_error", "Storage is unavailable right now", 503, ctx.requestId);
  if (r.status !== 200) return relay(ctx, r);
  const after = await ctx.repo.getStorageBackendById(orgId, libraryId, id);
  return successResponse({ ...(r.json.data as object), backend: after.ok ? backendView(after.value) : null }, ctx.requestId);
}

/** DELETE …/libraries/{lib}/storage/{stb}: leave a customer bucket and go back to managed storage (library empty). */
export async function handleDetachBucket(ctx: Ctx, orgId: string, libraryId: string, backendPub: string): Promise<Response> {
  const a = await loadAuthorized(ctx, orgId, libraryId, "storage.manage");
  if (!a.ok) return a.response;
  const id = parseBackendPublicId(backendPub);
  if (!id) return errorResponse("not_found", "Not found", 404, ctx.requestId);
  const own = await ctx.repo.getStorageBackendById(orgId, libraryId, id);
  if (!own.ok || own.value.kind !== "s3-compatible" || own.value.status === "retired") return errorResponse("not_found", "Not found", 404, ctx.requestId);
  const idx = indexFor(ctx.env, { orgId, libraryId, actor: ctx.actor.subjectId });
  const now = ctx.now();
  const begun = await begin(ctx, () => idx.call<{ ok: true } | { ok: false; files: number; uploads: number }>({ op: "beginStorageSwitch", nowIso: now.toISOString(), untilIso: new Date(now.getTime() + SWITCH_LOCK_MS).toISOString() }));
  if (begun instanceof Response) return begun;
  if (!begun.ok) return errorResponse("library_not_empty", "Storage can only be changed this way while the library is empty; move its files with a migration (POST …/storage/migrations)", 409, ctx.requestId, { files: begun.files, uploads: begun.uploads });
  let done = false;
  try {
    const r = await ctx.repo.retireStorageBackend(orgId, libraryId, id, now);
    if (!r.ok) return errorResponse("internal_error", "Service unavailable", 503, ctx.requestId);
    done = true;
    return successResponse({ detached: true }, ctx.requestId);
  } finally {
    await idx.call({ op: "endStorageSwitch", backend: done ? "managed" : null });
    if (done) {
      forgetStore(orgId, libraryId);
      await publishLibraryMap(ctx.env, a.lib, await orgSuspended(ctx, orgId));
      await audit(ctx, a.lib, "library.storage_detached", `Moved library "${a.lib.name}" back to managed storage`, { backend: backendPub });
    }
  }
}
