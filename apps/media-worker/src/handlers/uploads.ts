// Derived from MarSeventh/CloudFlare-ImgBed@611153e:functions/upload/index.js (MIT), modified.
// ImgBed relays the whole file through one request into a "channel", with chunkUpload.js/chunkMerge.js for large
// files. Here an upload is a session in the library's index: the client sends the file in one part or in 32 MiB
// parts (each can be retried, and the session resumed), then commits; the bytes are verified against the
// client's SHA-256 before they become a file. Dedup, quotas and library rules apply before any byte is stored.

import {
  DEFAULT_MEDIA_LIMITS,
  UPLOAD_PART_SIZE,
  UPLOAD_SESSION_TTL_MS,
  type CreateUploadSessionRequest,
  type PublicUploadSession,
} from "@saas/contracts/media";
import { authorizeOnLibrary } from "../access.js";
import { kickPipeline, pipelineFor } from "./pipeline.js";
import type { Ctx } from "../ctx.js";
import { errorResponse, successResponse, validationError } from "../http.js";
import { logError, logInfo } from "../log.js";
import { indexFor, IndexCallError } from "../index-do/client.js";
import type { CommitResult, FileRow, SessionRow } from "../index-do/core.js";
import { libraryPublicId, sessionPublicId } from "../ids.js";
import { managedPrefix } from "@saas/db/media";
import { abortUpload, completeMultipart, createMultipart, putSingle, sha256OfObject, uploadPart } from "../storage/object-store.js";
import { loadAuthorized, parseSettings } from "./libraries.js";
import { toPublicFile } from "./files.js";

const SHA_RE = /^[0-9a-f]{64}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/i;

/** "/a/b" (no trailing slash, "/" for the root). Rejects "." and ".." segments and control characters. */
export function normalizeFolder(input: unknown): string | null {
  if (input === undefined || input === null || input === "" || input === "/") return "/";
  if (typeof input !== "string" || input.length > 1024 || CONTROL.test(input)) return null;
  const parts = input.split("/").filter((p) => p.length > 0);
  if (parts.some((p) => p === "." || p === ".." || p.length > 255)) return null;
  return parts.length ? `/${parts.join("/")}` : "/";
}

export function validName(name: unknown): name is string {
  return typeof name === "string" && name.length > 0 && name.length <= 255 && !name.includes("/") && !CONTROL.test(name) && name !== "." && name !== "..";
}

export function mimeAllowed(mime: string, patterns: string[]): boolean {
  if (!patterns.length) return true;
  return patterns.some((p) => (p.endsWith("/*") ? mime.startsWith(p.slice(0, -1)) : mime === p));
}

export const monthOf = (d: Date) => d.toISOString().slice(0, 7);

function sessionView(s: SessionRow, libraryPublicId: string): PublicUploadSession {
  const parts = Object.keys(JSON.parse(s.parts_json) as Record<string, string>)
    .map(Number)
    .sort((a, b) => a - b);
  return {
    id: sessionPublicId(s.id),
    libraryId: libraryPublicId,
    path: s.path,
    size: s.size,
    sha256: s.sha256,
    mode: s.mode,
    partSize: s.part_size,
    partCount: s.part_count,
    uploadedParts: parts,
    expiresAt: s.expires_at,
  };
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

const nf = (ctx: Ctx) => errorResponse("not_found", "Not found", 404, ctx.requestId);
const unavailable = (ctx: Ctx) => errorResponse("internal_error", "Service unavailable", 503, ctx.requestId);

async function limitsFor(ctx: Ctx, orgId: string) {
  const o = await ctx.repo.getLimitOverrides(orgId);
  if (!o.ok) return null;
  return {
    storageBytesLimit: o.value?.storageBytesLimit ?? DEFAULT_MEDIA_LIMITS.storageBytesLimit,
    uploadsPerMonthLimit: o.value?.uploadsPerMonthLimit ?? DEFAULT_MEDIA_LIMITS.uploadsPerMonthLimit,
    maxFileBytes: o.value?.maxFileBytes ?? DEFAULT_MEDIA_LIMITS.maxFileBytes,
  };
}

/** After a commit: delete unreferenced objects and count the upload. */
async function settle(ctx: Ctx, orgId: string, result: CommitResult): Promise<void> {
  const bucket = ctx.env.MEDIA_BUCKET!;
  for (const key of result.deleteKeys) await bucket.delete(key);
  const now = ctx.now();
  await ctx.repo.recordUpload(orgId, monthOf(now), result.file.size, result.storedBytes, now);
  if (result.releasedBytes > 0) await ctx.repo.releaseStorage(orgId, result.releasedBytes, now);
}

/** POST …/libraries/{lib}/uploads */
export async function handleCreateUpload(ctx: Ctx, request: Request, orgId: string, libraryId: string): Promise<Response> {
  const body = (await readJson(request)) as Partial<CreateUploadSessionRequest> | undefined;
  if (!body || typeof body !== "object") return validationError(ctx.requestId, { body: ["Invalid JSON"] });
  const fields: Record<string, string[]> = {};
  if (!validName(body.name)) fields.name = ["Must be 1-255 characters, without '/' or control characters"];
  const folder = normalizeFolder(body.folder);
  if (folder === null) fields.folder = ["Must be a path like /photos/2026 without '.' or '..' segments"];
  if (typeof body.size !== "number" || !Number.isSafeInteger(body.size) || body.size < 0) fields.size = ["Must be a whole number of bytes"];
  if (typeof body.sha256 !== "string" || !SHA_RE.test(body.sha256)) fields.sha256 = ["Must be the lowercase hex SHA-256 of the file"];
  const mime = body.mime === undefined || body.mime === "" ? "application/octet-stream" : String(body.mime).toLowerCase();
  if (!MIME_RE.test(mime)) fields.mime = ["Must be a MIME type like image/png"];
  if (body.visibility !== undefined && body.visibility !== "public" && body.visibility !== "private") fields.visibility = ["Must be public or private"];
  if (Object.keys(fields).length) return validationError(ctx.requestId, fields);
  const size = body.size as number;
  const sha256 = body.sha256 as string;
  const name = body.name as string;
  const path = folder === "/" ? `/${name}` : `${folder}/${name}`;
  // Names beginning with "_" at a library's root are reserved for the system (e.g. /_random; design §2.5).
  const top = path.split("/")[1] ?? "";
  if (top.startsWith("_")) return validationError(ctx.requestId, { name: ["Names starting with '_' are reserved at the top of a library"] });

  const a = await loadAuthorized(ctx, orgId, libraryId, "file.upload");
  if (!a.ok) return a.response;
  if (body.replace === true && !(await authorizeOnLibrary(ctx.env, ctx.actor, "file.update", a.lib, a.facts, ctx.requestId))) {
    return errorResponse("not_found", "Not found", 404, ctx.requestId);
  }

  const settings = parseSettings(a.lib.settingsJson);
  if (!mimeAllowed(mime, settings.allowedTypes)) {
    return errorResponse("unsupported_type", "This library doesn't accept this file type", 415, ctx.requestId, { allowed: settings.allowedTypes });
  }
  if (settings.maxUploadBytes !== null && size > settings.maxUploadBytes) {
    return errorResponse("too_large", "This file is larger than the library allows", 413, ctx.requestId, { max: settings.maxUploadBytes });
  }

  const idx = indexFor(ctx.env, { orgId, libraryId });
  const [limits, usage, blob] = await Promise.all([
    limitsFor(ctx, orgId),
    ctx.repo.getUsage(orgId, monthOf(ctx.now())),
    idx.call<{ object_key: string } | null>({ op: "findBlob", sha256 }),
  ]);
  if (!limits || !usage.ok) {
    logError(ctx.requestId, "createUpload.usage", usage.ok ? "limits unavailable" : usage.error.kind);
    return unavailable(ctx);
  }
  const newBytes = blob ? 0 : size;
  if (usage.value.storageBytes + newBytes > limits.storageBytesLimit) {
    return errorResponse("quota_exceeded", "Your team's storage is full", 412, ctx.requestId, {
      reason: "storage",
      used: usage.value.storageBytes,
      limit: limits.storageBytesLimit,
    });
  }
  if (usage.value.uploadsThisMonth + 1 > limits.uploadsPerMonthLimit) {
    return errorResponse("quota_exceeded", "Your team has used this month's uploads", 412, ctx.requestId, {
      reason: "uploads",
      used: usage.value.uploadsThisMonth,
      limit: limits.uploadsPerMonthLimit,
    });
  }
  if (size > limits.maxFileBytes) {
    return errorResponse("too_large", "This file is larger than your plan allows", 413, ctx.requestId, { max: limits.maxFileBytes });
  }

  const existing = await idx.call<FileRow | null>({ op: "liveFileAt", path });
  if (existing && body.replace !== true) {
    return errorResponse("conflict", "A file already exists at this path", 409, ctx.requestId, { fileId: toPublicFile(existing, a.lib, ctx.env).id });
  }

  const visibility = body.visibility ?? a.lib.visibilityDefault;
  const now = ctx.now();
  if (existing?.status === "removed") {
    return errorResponse("conflict", "This file was taken down and can't be replaced", 409, ctx.requestId, { reason: "taken_down" });
  }

  // Dedup without sending bytes, only for callers who could read the existing file anyway: otherwise knowing a
  // hash would be enough to obtain the bytes behind it.
  if (blob && (await authorizeOnLibrary(ctx.env, ctx.actor, "file.read", a.lib, a.facts, ctx.requestId))) {
    try {
      const pipe = await pipelineFor(ctx, orgId, mime, visibility);
      const result = await idx.call<CommitResult>({
        op: "commit",
        input: { fileId: crypto.randomUUID(), path, name, folder: folder!, size, sha256, mime, visibility, replace: body.replace === true, objectKey: null, actor: ctx.actor.subjectId, nowIso: now.toISOString(), processing: pipe.processing },
      });
      await settle(ctx, orgId, result);
      await kickPipeline(ctx, orgId, libraryId, result.file, pipe.requireSafety);
      return successResponse({ file: toPublicFile(result.file, a.lib, ctx.env), deduplicated: true }, ctx.requestId, 200);
    } catch (e) {
      if (e instanceof IndexCallError && e.code === "conflict") return errorResponse("conflict", "A file already exists at this path", 409, ctx.requestId);
      throw e;
    }
  }

  const sessionId = crypto.randomUUID();
  const objectKey = `${managedPrefix(orgId, libraryId)}blob/${sessionId}`;
  const mode = size > UPLOAD_PART_SIZE ? "multipart" : "single";
  const partCount = mode === "single" ? 1 : Math.ceil(size / UPLOAD_PART_SIZE);
  const uploadId = mode === "multipart" ? await createMultipart(ctx.env.MEDIA_BUCKET!, objectKey, mime) : null;
  const session = await idx.call<SessionRow>({
    op: "openSession",
    session: {
      id: sessionId,
      path,
      name,
      folder: folder!,
      size,
      sha256,
      mime,
      visibility,
      replace: body.replace === true ? 1 : 0,
      mode,
      object_key: objectKey,
      multipart_upload_id: uploadId,
      part_size: UPLOAD_PART_SIZE,
      part_count: partCount,
      created_by: ctx.actor.subjectId,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + UPLOAD_SESSION_TTL_MS).toISOString(),
    },
  });
  return successResponse({ session: sessionView(session, libraryPublicId(libraryId)) }, ctx.requestId, 201);
}

/** Load the caller's own open session in this library. */
async function ownSession(ctx: Ctx, orgId: string, libraryId: string, sessionId: string) {
  const a = await loadAuthorized(ctx, orgId, libraryId, "file.upload");
  if (!a.ok) return { ok: false as const, response: a.response };
  const idx = indexFor(ctx.env, { orgId, libraryId });
  const s = await idx.call<SessionRow | null>({ op: "getSession", id: sessionId });
  if (!s || s.created_by !== ctx.actor.subjectId) return { ok: false as const, response: nf(ctx) };
  return { ok: true as const, a, idx, s };
}

function sessionUsable(ctx: Ctx, s: SessionRow): Response | null {
  if (s.state !== "open") return errorResponse("invalid_state", `This upload is ${s.state}`, 409, ctx.requestId);
  if (s.expires_at <= ctx.now().toISOString()) return errorResponse("expired", "This upload session has expired; start a new one", 410, ctx.requestId);
  return null;
}

/** GET …/uploads/{ups}: where to resume. */
export async function handleGetUpload(ctx: Ctx, orgId: string, libraryId: string, sessionId: string): Promise<Response> {
  const o = await ownSession(ctx, orgId, libraryId, sessionId);
  if (!o.ok) return o.response;
  return successResponse({ session: sessionView(o.s, libraryPublicId(libraryId)) }, ctx.requestId);
}

/** PUT …/uploads/{ups}/parts/{n}: the part's bytes as the raw body. */
export async function handlePutPart(ctx: Ctx, request: Request, orgId: string, libraryId: string, sessionId: string, partNumber: number): Promise<Response> {
  const o = await ownSession(ctx, orgId, libraryId, sessionId);
  if (!o.ok) return o.response;
  const bad = sessionUsable(ctx, o.s);
  if (bad) return bad;
  const s = o.s;
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > s.part_count) {
    return validationError(ctx.requestId, { partNumber: [`Must be from 1 to ${s.part_count}`] });
  }
  if (!request.body && s.size > 0) return validationError(ctx.requestId, { body: ["The part's bytes are required"] });
  const expected = partNumber < s.part_count ? s.part_size : s.size - s.part_size * (s.part_count - 1);
  const body = request.body ?? new Response(new Uint8Array(0)).body!;
  const bucket = ctx.env.MEDIA_BUCKET!;
  try {
    if (s.mode === "single") {
      const r = await putSingle(bucket, s.object_key, body, expected, s.sha256, s.mime);
      if (r === "hash_mismatch") {
        await o.idx.call({ op: "closeSession", id: s.id, state: "aborted" });
        return errorResponse("hash_mismatch", "The bytes don't match the declared SHA-256; start a new upload", 422, ctx.requestId);
      }
      const updated = await o.idx.call<SessionRow>({ op: "recordPart", id: s.id, partNumber: 1, etag: "single" });
      return successResponse({ session: sessionView(updated, libraryPublicId(libraryId)) }, ctx.requestId);
    }
    const receipt = await uploadPart(bucket, s.object_key, s.multipart_upload_id!, partNumber, body, expected);
    const updated = await o.idx.call<SessionRow>({ op: "recordPart", id: s.id, partNumber, etag: receipt.etag });
    return successResponse({ session: sessionView(updated, libraryPublicId(libraryId)) }, ctx.requestId);
  } catch (e) {
    if (/length|size|bytes/i.test(String((e as Error)?.message))) {
      return errorResponse("part_size_mismatch", `Part ${partNumber} must be exactly ${expected} bytes`, 422, ctx.requestId, { expected });
    }
    throw e;
  }
}

/** POST …/uploads/{ups}/commit: verify size and SHA-256, then make the file. */
export async function handleCommitUpload(ctx: Ctx, orgId: string, libraryId: string, sessionId: string): Promise<Response> {
  const o = await ownSession(ctx, orgId, libraryId, sessionId);
  if (!o.ok) return o.response;
  const bad = sessionUsable(ctx, o.s);
  if (bad) return bad;
  const s = o.s;
  const bucket = ctx.env.MEDIA_BUCKET!;
  const parts = JSON.parse(s.parts_json) as Record<string, string>;
  const missing: number[] = [];
  for (let n = 1; n <= s.part_count; n++) if (!parts[String(n)]) missing.push(n);
  if (missing.length) return errorResponse("incomplete", "Some parts haven't been uploaded", 409, ctx.requestId, { missing: missing.slice(0, 50) });

  const t0 = Date.now();
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      logError(ctx.requestId, `commit.${name}`, e, { session: s.id, size: s.size, parts: s.part_count, mode: s.mode, ms: Date.now() - t0 });
      throw e;
    }
  };
  logInfo(ctx.requestId, "commit.start", { session: s.id, size: s.size, parts: s.part_count, mode: s.mode });
  if (s.mode === "multipart") {
    await step("complete_multipart", () =>
      completeMultipart(bucket, s.object_key, s.multipart_upload_id!, Object.entries(parts).map(([n, etag]) => ({ partNumber: Number(n), etag }))),
    );
  }
  // Verify what is stored, not what was declared. (A single PUT was already checked by R2 against the SHA-256.)
  const tHash = Date.now();
  const stored = await step("verify", () => (s.mode === "multipart" ? sha256OfObject(bucket, s.object_key) : headAsDigest(bucket, s.object_key)));
  logInfo(ctx.requestId, "commit.verified", { session: s.id, size: s.size, hashMs: Date.now() - tHash, match: !!stored && stored.size === s.size && stored.sha256 === s.sha256 });
  if (!stored || stored.size !== s.size || stored.sha256 !== s.sha256) {
    await bucket.delete(s.object_key);
    await o.idx.call({ op: "closeSession", id: s.id, state: "aborted" });
    return errorResponse("hash_mismatch", "The stored bytes don't match the declared size and SHA-256; start a new upload", 422, ctx.requestId);
  }
  const pipe = await pipelineFor(ctx, orgId, s.mime, s.visibility);
  try {
    const result = await step("index", () => o.idx.call<CommitResult>({
      op: "commit",
      input: {
        sessionId: s.id,
        fileId: crypto.randomUUID(),
        path: s.path,
        name: s.name,
        folder: s.folder,
        size: s.size,
        sha256: s.sha256,
        mime: s.mime,
        visibility: s.visibility,
        replace: s.replace === 1,
        objectKey: s.object_key,
        actor: ctx.actor.subjectId,
        nowIso: ctx.now().toISOString(),
        processing: pipe.processing,
      },
    }));
    await step("settle", () => settle(ctx, orgId, result));
    await kickPipeline(ctx, orgId, libraryId, result.file, pipe.requireSafety);
    logInfo(ctx.requestId, "commit.done", { session: s.id, size: s.size, deduplicated: result.deduplicated, ms: Date.now() - t0 });
    return successResponse({ file: toPublicFile(result.file, o.a.lib, ctx.env), deduplicated: result.deduplicated }, ctx.requestId);
  } catch (e) {
    if (e instanceof IndexCallError && e.code === "conflict") {
      await bucket.delete(s.object_key);
      await o.idx.call({ op: "closeSession", id: s.id, state: "aborted" });
      return errorResponse("conflict", "A file was created at this path meanwhile", 409, ctx.requestId);
    }
    throw e;
  }
}

async function headAsDigest(bucket: R2Bucket, key: string): Promise<{ sha256: string; size: number } | null> {
  const head = await bucket.head(key);
  if (!head) return null;
  const sum = head.checksums?.sha256;
  const hex = sum ? Array.from(new Uint8Array(sum), (b) => b.toString(16).padStart(2, "0")).join("") : null;
  // R2 refused the PUT unless its SHA-256 matched; if the checksum isn't reported, fall back to hashing.
  if (hex) return { sha256: hex, size: head.size };
  return sha256OfObject(bucket, key);
}

/** DELETE …/uploads/{ups}: abandon an upload. */
export async function handleAbortUpload(ctx: Ctx, orgId: string, libraryId: string, sessionId: string): Promise<Response> {
  const o = await ownSession(ctx, orgId, libraryId, sessionId);
  if (!o.ok) return o.response;
  if (o.s.state === "open") {
    await abortUpload(ctx.env.MEDIA_BUCKET!, o.s.object_key, o.s.mode, o.s.multipart_upload_id);
    await o.idx.call({ op: "closeSession", id: o.s.id, state: "aborted" });
  }
  return successResponse({ aborted: true }, ctx.requestId);
}
