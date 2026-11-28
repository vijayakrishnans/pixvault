// Derived from MarSeventh/CloudFlare-ImgBed@611153e:functions/api/manage/delete/[[path]].js (MIT), modified.
// ImgBed deletes a file outright from its channel. Here a delete moves the file to trash (kept for the library's
// retention), restore brings it back, and purge removes it for good, deleting the blob only when no other file or
// version still references the same bytes.

import { DEFAULT_MEDIA_LIMITS, type PublicFile, type PublicFileVersion } from "@saas/contracts/media";
import { authorizeOnLibrary, hasAnyStanding, loadFacts } from "../access.js";
import type { Ctx } from "../ctx.js";
import { errorResponse, successResponse, validationError } from "../http.js";
import { indexFor, IndexCallError } from "../index-do/client.js";
import type { FileRow, FileType, ListFilter } from "../index-do/core.js";
import { filePublicId, libraryPublicId } from "../ids.js";
import { loadAuthorized } from "./libraries.js";
import type { Library } from "@saas/db/media";
import type { Env } from "../env.js";
import { fileUrl, signedFileUrl } from "../serving.js";
import { monthOf, normalizeFolder } from "./uploads.js";
import { kickPipeline, pipelineFor } from "./pipeline.js";
import { moveOneFile } from "./browse.js";
import { publicSharingAllowed, sharingOff } from "../sharing.js";

export function toPublicFile(f: FileRow, lib: Library, env: Env): PublicFile {
  return {
    id: filePublicId(f.id),
    libraryId: libraryPublicId(lib.id),
    path: f.path,
    name: f.name,
    folder: f.folder,
    size: f.size,
    mime: f.mime,
    sha256: f.blob_sha256,
    visibility: f.visibility,
    status: f.status,
    version: f.version,
    uploadedBy: f.uploaded_by,
    createdAt: f.created_at,
    updatedAt: f.updated_at,
    trashedAt: f.trashed_at,
    // A plain URL only for public files; private ones get a signed URL on request.
    // While public sharing is off (prod for now) there are no plain URLs; members use signed links.
    url: f.status === "public" && f.visibility === "public" && publicSharingAllowed(env) ? fileUrl(env, lib, f.path) : null,
    width: f.width ?? null,
    height: f.height ?? null,
    tags: parseTags(f.tags),
    moderation: f.moderation ?? null,
    pipelineNote: f.pipeline_note ?? null,
  };
}

function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

const nf = (ctx: Ctx) => errorResponse("not_found", "Not found", 404, ctx.requestId);

/** Read access to one file: `file.read`, or `file.read.own` for the uploader of that file. */
export async function canRead(ctx: Ctx, a: Awaited<ReturnType<typeof loadAuthorized>> & { ok: true }, f: FileRow): Promise<boolean> {
  if (await authorizeOnLibrary(ctx.env, ctx.actor, "file.read", a.lib, a.facts, ctx.requestId)) return true;
  return f.uploaded_by === ctx.actor.subjectId && (await authorizeOnLibrary(ctx.env, ctx.actor, "file.read.own", a.lib, a.facts, ctx.requestId));
}

const FILE_TYPES: ReadonlySet<string> = new Set(["image", "video", "audio", "document", "other"]);
const FILE_STATUSES: ReadonlySet<string> = new Set(["processing", "held", "public", "private", "flagged", "removed"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.]{2,15}Z)?$/;

/** The search and filter parameters of a file listing, or the fields that are wrong. */
function parseFilters(url: URL): { ok: true; f: Omit<ListFilter, "limit" | "status" | "folder" | "cursor"> } | { ok: false; fields: Record<string, string[]> } {
  const p = url.searchParams;
  const fields: Record<string, string[]> = {};
  const f: Omit<ListFilter, "limit" | "status" | "folder" | "cursor"> = {};
  const q = p.get("q");
  if (q !== null && q.trim()) {
    if (q.length > 200) fields.q = ["At most 200 characters"];
    else f.q = q;
  }
  const type = p.get("type");
  if (type !== null) {
    if (FILE_TYPES.has(type)) f.type = type as FileType;
    else fields.type = ["Must be image, video, audio, document or other"];
  }
  const tag = p.get("tag");
  if (tag !== null) {
    if (tag.length >= 1 && tag.length <= 100) f.tag = tag;
    else fields.tag = ["Must be 1 to 100 characters"];
  }
  const uploader = p.get("uploader");
  if (uploader !== null) {
    if (/^[a-z]{2,8}_[0-9a-f]{32}$/.test(uploader)) f.uploadedBy = uploader;
    else fields.uploader = ["Must be a user id"];
  }
  const status = p.get("status");
  if (status !== null) {
    if (FILE_STATUSES.has(status)) f.fileStatus = status as NonNullable<ListFilter["fileStatus"]>;
    else fields.status = ["Must be processing, held, public, private, flagged or removed"];
  }
  const visibility = p.get("visibility");
  if (visibility !== null) {
    if (visibility === "public" || visibility === "private") f.visibility = visibility;
    else fields.visibility = ["Must be public or private"];
  }
  for (const k of ["from", "to"] as const) {
    const v = p.get(k);
    if (v === null) continue;
    if (DATE_RE.test(v) && !Number.isNaN(Date.parse(v))) f[k] = new Date(v).toISOString();
    else fields[k] = ["Must be a date like 2026-11-28"];
  }
  return Object.keys(fields).length ? { ok: false, fields } : { ok: true, f };
}

/** GET …/files?folder=&q=&type=&tag=&uploader=&status=&visibility=&from=&to=&trash=1&review=1&cursor=&limit= */
export async function handleListFiles(ctx: Ctx, url: URL, orgId: string, libraryId: string): Promise<Response> {
  const a = await loadAuthorized(ctx, orgId, libraryId, "library.read");
  if (!a.ok) return a.response;
  const trash = url.searchParams.get("trash") === "1";
  const review = url.searchParams.get("review") === "1";
  let uploadedBy: string | undefined;
  if (review) {
    // The review queue: held and flagged files, for the people who decide on them.
    if (!(await authorizeOnLibrary(ctx.env, ctx.actor, "review.decide", a.lib, a.facts, ctx.requestId))) return nf(ctx);
  } else if (trash) {
    if (!(await authorizeOnLibrary(ctx.env, ctx.actor, "file.restore", a.lib, a.facts, ctx.requestId))) return nf(ctx);
  } else if (!(await authorizeOnLibrary(ctx.env, ctx.actor, "file.list", a.lib, a.facts, ctx.requestId))) {
    if (!(await authorizeOnLibrary(ctx.env, ctx.actor, "file.list.own", a.lib, a.facts, ctx.requestId))) return nf(ctx);
    uploadedBy = ctx.actor.subjectId;
  }
  const filters = parseFilters(url);
  if (!filters.ok) return validationError(ctx.requestId, filters.fields);
  // Someone who may list only their own uploads can't widen that with the uploader filter.
  if (uploadedBy) filters.f.uploadedBy = uploadedBy;
  const folderParam = url.searchParams.get("folder");
  const folder = folderParam === null ? undefined : normalizeFolder(folderParam);
  if (folder === null) return validationError(ctx.requestId, { folder: ["Invalid folder"] });
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), 200);
  const cursor = url.searchParams.get("cursor") ?? undefined;
  if (cursor !== undefined && !/^[\d\-T:.Z]{10,40}\|[0-9a-f-]{36}$/.test(cursor)) return validationError(ctx.requestId, { cursor: ["Invalid cursor"] });
  const r = await indexFor(ctx.env, { orgId, libraryId }).call<{ files: FileRow[]; nextCursor: string | null }>({
    op: "listFiles",
    ...filters.f,
    ...(folder !== undefined ? { folder } : {}),
    status: review ? "review" : trash ? "trashed" : "live",
    ...(cursor ? { cursor } : {}),
    limit,
  });
  return successResponse({ files: r.files.map((f) => toPublicFile(f, a.lib, ctx.env)), nextCursor: r.nextCursor }, ctx.requestId);
}

export async function loadFile(ctx: Ctx, orgId: string, libraryId: string, fileId: string) {
  const a = await loadAuthorized(ctx, orgId, libraryId, "library.read");
  if (!a.ok) return { ok: false as const, response: a.response };
  const idx = indexFor(ctx.env, { orgId, libraryId });
  const got = await idx.call<{ file: FileRow; objectKey: string | null } | null>({ op: "getFileWithKey", id: fileId });
  if (!got) return { ok: false as const, response: nf(ctx) };
  return { ok: true as const, a, idx, file: got.file, objectKey: got.objectKey };
}

/** GET …/files/{fil} */
export async function handleGetFile(ctx: Ctx, orgId: string, libraryId: string, fileId: string): Promise<Response> {
  const l = await loadFile(ctx, orgId, libraryId, fileId);
  if (!l.ok) return l.response;
  if (l.file.status === "trashed" && !(await authorizeOnLibrary(ctx.env, ctx.actor, "file.restore", l.a.lib, l.a.facts, ctx.requestId))) return nf(ctx);
  if (!(await canRead(ctx, l.a, l.file))) return nf(ctx);
  return successResponse({ file: toPublicFile(l.file, l.a.lib, ctx.env) }, ctx.requestId);
}

/** GET …/files/{fil}/content: the bytes, for signed-in members. Public serving is serve-worker's (PV3). */
export async function handleFileContent(ctx: Ctx, orgId: string, libraryId: string, fileId: string): Promise<Response> {
  const l = await loadFile(ctx, orgId, libraryId, fileId);
  if (!l.ok) return l.response;
  if (l.file.status === "trashed" || !(await canRead(ctx, l.a, l.file)) || !l.objectKey) return nf(ctx);
  const obj = await ctx.env.MEDIA_BUCKET!.get(l.objectKey);
  if (!obj) return nf(ctx);
  const safeName = l.file.name.replace(/["\\\r\n]/g, "_");
  return new Response(obj.body, {
    headers: {
      "content-type": l.file.mime,
      "content-length": String(obj.size),
      "content-disposition": `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(l.file.name)}`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      etag: `"${l.file.blob_sha256}"`,
      "x-request-id": ctx.requestId,
    },
  });
}

/** DELETE …/files/{fil}: to trash; with ?permanent=1 on a trashed file, purge it. */
export async function handleDeleteFile(ctx: Ctx, url: URL, orgId: string, libraryId: string, fileId: string): Promise<Response> {
  const l = await loadFile(ctx, orgId, libraryId, fileId);
  if (!l.ok) return l.response;
  if (!(await authorizeOnLibrary(ctx.env, ctx.actor, "file.delete", l.a.lib, l.a.facts, ctx.requestId))) return nf(ctx);
  const now = ctx.now();
  try {
    if (url.searchParams.get("permanent") === "1") {
      const r = await l.idx.call<{ deleteKeys: string[]; releasedBytes: number }>({ op: "purge", id: fileId });
      for (const key of r.deleteKeys) await ctx.env.MEDIA_BUCKET!.delete(key);
      if (r.releasedBytes > 0) await ctx.repo.releaseStorage(orgId, r.releasedBytes, now);
      return successResponse({ purged: true, releasedBytes: r.releasedBytes }, ctx.requestId);
    }
    const f = await l.idx.call<FileRow>({ op: "trash", id: fileId, nowIso: now.toISOString() });
    return successResponse({ file: toPublicFile(f, l.a.lib, ctx.env) }, ctx.requestId);
  } catch (e) {
    if (e instanceof IndexCallError && e.code === "not_found") return nf(ctx);
    throw e;
  }
}

/** POST …/files/{fil}/restore */
export async function handleRestoreFile(ctx: Ctx, orgId: string, libraryId: string, fileId: string): Promise<Response> {
  const l = await loadFile(ctx, orgId, libraryId, fileId);
  if (!l.ok) return l.response;
  if (!(await authorizeOnLibrary(ctx.env, ctx.actor, "file.restore", l.a.lib, l.a.facts, ctx.requestId))) return nf(ctx);
  try {
    const f = await l.idx.call<FileRow>({ op: "restore", id: fileId, nowIso: ctx.now().toISOString() });
    return successResponse({ file: toPublicFile(f, l.a.lib, ctx.env) }, ctx.requestId);
  } catch (e) {
    if (e instanceof IndexCallError && e.code === "conflict") return errorResponse("conflict", "Another file now uses this path", 409, ctx.requestId);
    if (e instanceof IndexCallError && e.code === "not_found") return nf(ctx);
    throw e;
  }
}

/** GET …/files/{fil}/versions */
export async function handleListVersions(ctx: Ctx, orgId: string, libraryId: string, fileId: string): Promise<Response> {
  const l = await loadFile(ctx, orgId, libraryId, fileId);
  if (!l.ok) return l.response;
  if (!(await canRead(ctx, l.a, l.file))) return nf(ctx);
  const vs = await l.idx.call<{ version: number; blob_sha256: string; size: number; created_by: string; created_at: string }[]>({ op: "versions", id: fileId });
  const versions: PublicFileVersion[] = vs.map((v) => ({
    version: v.version,
    size: v.size,
    sha256: v.blob_sha256,
    createdBy: v.created_by,
    createdAt: v.created_at,
    current: v.version === l.file.version,
  }));
  return successResponse({ versions }, ctx.requestId);
}

/** POST …/files/{fil}/versions/{n}/restore */
export async function handleRestoreVersion(ctx: Ctx, orgId: string, libraryId: string, fileId: string, version: number): Promise<Response> {
  const l = await loadFile(ctx, orgId, libraryId, fileId);
  if (!l.ok) return l.response;
  if (!(await authorizeOnLibrary(ctx.env, ctx.actor, "file.update", l.a.lib, l.a.facts, ctx.requestId))) return nf(ctx);
  try {
    const pipe = await pipelineFor(ctx, orgId, l.file.mime, l.file.visibility);
    const f = await l.idx.call<FileRow>({ op: "restoreVersion", id: fileId, version, actor: ctx.actor.subjectId, nowIso: ctx.now().toISOString(), processing: pipe.processing });
    await kickPipeline(ctx, orgId, libraryId, f, pipe.requireSafety, `h${ctx.now().getTime().toString(36)}`);
    return successResponse({ file: toPublicFile(f, l.a.lib, ctx.env) }, ctx.requestId);
  } catch (e) {
    if (e instanceof IndexCallError && e.code === "not_found") return nf(ctx);
    if (e instanceof IndexCallError && e.code === "forbidden") return errorResponse("conflict", e.message, 409, ctx.requestId, { reason: "taken_down" });
    throw e;
  }
}

/** GET /v1/organizations/{org}/media-usage */
export async function handleMediaUsage(ctx: Ctx, orgId: string): Promise<Response> {
  const facts = await loadFacts(ctx.env, ctx.repo, ctx.actor, orgId, ctx.requestId);
  if (!facts.ok) return errorResponse("internal_error", "Service unavailable", 503, ctx.requestId);
  if (!hasAnyStanding(facts.facts)) return nf(ctx);
  const [usage, o] = await Promise.all([ctx.repo.getUsage(orgId, monthOf(ctx.now())), ctx.repo.getLimitOverrides(orgId)]);
  if (!usage.ok || !o.ok) return errorResponse("internal_error", "Service unavailable", 503, ctx.requestId);
  return successResponse(
    {
      usage: {
        storageBytes: usage.value.storageBytes,
        storageBytesLimit: o.value?.storageBytesLimit ?? DEFAULT_MEDIA_LIMITS.storageBytesLimit,
        uploadsThisMonth: usage.value.uploadsThisMonth,
        uploadsPerMonthLimit: o.value?.uploadsPerMonthLimit ?? DEFAULT_MEDIA_LIMITS.uploadsPerMonthLimit,
        maxFileBytes: o.value?.maxFileBytes ?? DEFAULT_MEDIA_LIMITS.maxFileBytes,
      },
    },
    ctx.requestId,
  );
}

/** PATCH …/files/{fil} { visibility?, folder?, name? }: change who can see it, and/or move or rename it. */
export async function handleUpdateFile(ctx: Ctx, request: Request, orgId: string, libraryId: string, fileId: string): Promise<Response> {
  let body: { visibility?: unknown; folder?: unknown; name?: unknown } | undefined;
  try {
    body = (await request.json()) as { visibility?: unknown };
  } catch {
    body = undefined;
  }
  const keys = body && typeof body === "object" ? Object.keys(body) : [];
  if (!body || !keys.length || keys.some((k) => k !== "visibility" && k !== "folder" && k !== "name")) {
    return validationError(ctx.requestId, { body: ["Give visibility, folder or name"] });
  }
  if (body.visibility !== undefined && body.visibility !== "public" && body.visibility !== "private") {
    return validationError(ctx.requestId, { visibility: ["Must be public or private"] });
  }
  const l = await loadFile(ctx, orgId, libraryId, fileId);
  if (!l.ok) return l.response;
  if (!(await authorizeOnLibrary(ctx.env, ctx.actor, "file.update", l.a.lib, l.a.facts, ctx.requestId))) return nf(ctx);
  if (body.visibility === "public" && !publicSharingAllowed(ctx.env)) return sharingOff(ctx.requestId);
  if (body.folder !== undefined || body.name !== undefined) {
    const moved = await moveOneFile(ctx, l, body.folder, body.name);
    if (moved instanceof Response) return moved;
    if (body.visibility === undefined) return successResponse({ file: toPublicFile(moved, l.a.lib, ctx.env) }, ctx.requestId);
    l.file = moved;
  }
  if (body.visibility !== "public" && body.visibility !== "private") return nf(ctx);
  try {
    // Making a file public on a free plan puts it through the safety check first (it isn't served until it passes).
    const { requireSafety } = await pipelineFor(ctx, orgId, l.file.mime, body.visibility);
    const f = await l.idx.call<FileRow>({ op: "setVisibility", id: fileId, visibility: body.visibility, nowIso: ctx.now().toISOString(), requireSafety });
    await kickPipeline(ctx, orgId, libraryId, f, requireSafety, `v${ctx.now().getTime().toString(36)}`);
    return successResponse({ file: toPublicFile(f, l.a.lib, ctx.env) }, ctx.requestId);
  } catch (e) {
    if (e instanceof IndexCallError && e.code === "not_found") return nf(ctx);
    throw e;
  }
}

const MIN_SIGNED_TTL = 60;
const MAX_SIGNED_TTL = 7 * 24 * 3600;

/** POST …/files/{fil}/signed-url { expiresIn? }: a time-limited URL, for private files (works for public ones too). */
export async function handleSignedUrl(ctx: Ctx, request: Request, orgId: string, libraryId: string, fileId: string): Promise<Response> {
  let expiresIn = 3600;
  try {
    const b = (await request.json()) as { expiresIn?: unknown };
    if (b && b.expiresIn !== undefined) {
      if (typeof b.expiresIn !== "number" || !Number.isInteger(b.expiresIn) || b.expiresIn < MIN_SIGNED_TTL || b.expiresIn > MAX_SIGNED_TTL) {
        return validationError(ctx.requestId, { expiresIn: [`Must be whole seconds from ${MIN_SIGNED_TTL} to ${MAX_SIGNED_TTL}`] });
      }
      expiresIn = b.expiresIn;
    }
  } catch {
    /* no body: default lifetime */
  }
  const l = await loadFile(ctx, orgId, libraryId, fileId);
  if (!l.ok) return l.response;
  if (l.file.status === "trashed" || !(await canRead(ctx, l.a, l.file))) return nf(ctx);
  const signed = await signedFileUrl(ctx.env, l.a.lib, l.file.path, expiresIn, ctx.now());
  if (!signed) return errorResponse("unavailable", "Links aren't available for this library yet", 409, ctx.requestId);
  return successResponse(signed, ctx.requestId);
}

/** POST …/files/{fil}/review { decision: "approve" | "reject" } (editors and managers: review.decide) */
export async function handleReviewFile(ctx: Ctx, request: Request, orgId: string, libraryId: string, fileId: string): Promise<Response> {
  let body: { decision?: unknown } | undefined;
  try {
    body = (await request.json()) as { decision?: unknown };
  } catch {
    body = undefined;
  }
  if (!body || (body.decision !== "approve" && body.decision !== "reject")) return validationError(ctx.requestId, { decision: ["Must be approve or reject"] });
  const l = await loadFile(ctx, orgId, libraryId, fileId);
  if (!l.ok) return l.response;
  if (!(await authorizeOnLibrary(ctx.env, ctx.actor, "review.decide", l.a.lib, l.a.facts, ctx.requestId))) return nf(ctx);
  try {
    const f = await l.idx.call<FileRow>({ op: "review", id: fileId, decision: body.decision, nowIso: ctx.now().toISOString() });
    return successResponse({ file: toPublicFile(f, l.a.lib, ctx.env) }, ctx.requestId);
  } catch (e) {
    if (e instanceof IndexCallError && e.code === "not_found") return nf(ctx);
    if (e instanceof IndexCallError && e.code === "invalid_state") return errorResponse("conflict", e.message, 409, ctx.requestId);
    throw e;
  }
}
