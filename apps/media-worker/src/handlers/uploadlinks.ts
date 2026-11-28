// Upload links (PV6), after ImgBed's guest-upload idea: someone outside the team sends files into one folder of a
// library through a link. Managers create, list and revoke links (upload_link.manage). Guests reach them only
// through serve-worker's /_u/<token> page, which calls the internal routes below over the service binding.
//
// Every guest file is checked against the link (type, size, count, total, expiry) and the team's quota; the count
// and bytes are reserved in one conditional UPDATE first, so concurrent guests can't pass the limits. Files arrive
// private, go through the safety pipeline (location data removed, moderation for images) and, unless the link
// says otherwise, wait in the review queue. Nothing a guest sends is ever served without a member's decision.

import type { Ctx } from "../ctx.js";
import type { Env } from "../env.js";
import { DEFAULT_MEDIA_LIMITS } from "@saas/contracts/media";
import { createSqlExecutor } from "@saas/db/d1";
import { createMediaRepository, managedPrefix, type MediaRepository, type UploadLink, type UploadLinkLimits } from "@saas/db/media";
import { uuidToHex } from "@saas/db/ids";
import { errorResponse, successResponse, validationError } from "../http.js";
import { indexFor, IndexCallError } from "../index-do/client.js";
import type { CommitResult, FileRow, FolderRow } from "../index-do/core.js";
import { actorUuid, uploadLinkPublicId } from "../ids.js";
import { loadAuthorized, parseSettings } from "./libraries.js";
import { mimeAllowed, monthOf, normalizeFolder, validName } from "./uploads.js";
import { publicSharingAllowed, sharingOff } from "../sharing.js";
import { TOKEN_RE, newShareToken, tokenHash } from "../shares/secrets.js";
import { startPipeline } from "../pipeline/start.js";

/** The biggest file a guest can send: serve-worker reads the form into memory, and Workers cap request bodies. */
export const GUEST_MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_FILES_CAP = 1000;
const MAX_TOTAL_CAP = 10 * 1024 ** 3;
const MAX_EXPIRY_S = 90 * 86400;
const DEFAULT_LIMITS: UploadLinkLimits = { maxFiles: 20, maxFileBytes: 25 * 1024 * 1024, maxTotalBytes: 500 * 1024 * 1024, allowedTypes: [] };
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/i;
const TYPE_PATTERN_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/(\*|[a-z0-9][a-z0-9!#$&^_.+-]{0,63})$/i;

export interface PublicUploadLink {
  id: string;
  folder: string;
  label: string;
  limits: UploadLinkLimits;
  requiresReview: boolean;
  uploads: number;
  bytes: number;
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  status: "active" | "expired" | "revoked" | "full";
}

function statusOf(l: UploadLink, now: Date): PublicUploadLink["status"] {
  if (l.revokedAt) return "revoked";
  if (l.expiresAt && l.expiresAt <= now.toISOString()) return "expired";
  if (l.uploads >= l.limits.maxFiles || l.bytes >= l.limits.maxTotalBytes) return "full";
  return "active";
}

function toPublicUploadLink(l: UploadLink, now: Date): PublicUploadLink {
  return {
    id: uploadLinkPublicId(l.id),
    folder: l.folderPath,
    label: l.label,
    limits: l.limits,
    requiresReview: l.requiresReview,
    uploads: l.uploads,
    bytes: l.bytes,
    createdBy: /^[0-9a-f-]{36}$/.test(l.createdBy) ? `usr_${uuidToHex(l.createdBy as never)}` : l.createdBy,
    createdAt: l.createdAt,
    expiresAt: l.expiresAt,
    revokedAt: l.revokedAt,
    status: statusOf(l, now),
  };
}

const nf = (requestId: string) => errorResponse("not_found", "Not found", 404, requestId);

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const b = (await request.json()) as unknown;
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const int = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

// ── managers ───────────────────────────────────────────────

/**
 * POST …/upload-links { folder, label?, expiresIn?, maxFiles?, maxFileBytes?, maxTotalBytes?, allowedTypes?,
 * requiresReview? } → 201 { uploadLink, url }. The URL holds the token; it's shown once.
 */
export async function handleCreateUploadLink(ctx: Ctx, request: Request, orgId: string, libraryId: string): Promise<Response> {
  const b = await readJson(request);
  if (!b) return validationError(ctx.requestId, { body: ["Must be a JSON object"] });
  const fields: Record<string, string[]> = {};
  const folder = normalizeFolder(b.folder);
  if (folder === null) fields.folder = ["Must be a path like /incoming without '.' or '..' segments"];
  if (b.label !== undefined && (typeof b.label !== "string" || b.label.length > 100)) fields.label = ["At most 100 characters"];
  const limits: UploadLinkLimits = { ...DEFAULT_LIMITS };
  if (b.maxFiles !== undefined) {
    if (int(b.maxFiles, 1, MAX_FILES_CAP)) limits.maxFiles = b.maxFiles as number;
    else fields.maxFiles = [`Must be 1 to ${MAX_FILES_CAP}`];
  }
  if (b.maxFileBytes !== undefined) {
    if (int(b.maxFileBytes, 1, GUEST_MAX_FILE_BYTES)) limits.maxFileBytes = b.maxFileBytes as number;
    else fields.maxFileBytes = [`Must be 1 to ${GUEST_MAX_FILE_BYTES} bytes`];
  }
  if (b.maxTotalBytes !== undefined) {
    if (int(b.maxTotalBytes, 1, MAX_TOTAL_CAP)) limits.maxTotalBytes = b.maxTotalBytes as number;
    else fields.maxTotalBytes = [`Must be 1 to ${MAX_TOTAL_CAP} bytes`];
  }
  if (b.allowedTypes !== undefined) {
    if (Array.isArray(b.allowedTypes) && b.allowedTypes.length <= 20 && b.allowedTypes.every((t) => typeof t === "string" && TYPE_PATTERN_RE.test(t))) limits.allowedTypes = b.allowedTypes as string[];
    else fields.allowedTypes = ["Up to 20 MIME types or patterns like image/*"];
  }
  if (b.requiresReview !== undefined && typeof b.requiresReview !== "boolean") fields.requiresReview = ["Must be a boolean"];
  let expiresAt: Date | null = new Date(ctx.now().getTime() + 7 * 86400_000);
  if (b.expiresIn !== undefined) {
    if (int(b.expiresIn, 60, MAX_EXPIRY_S)) expiresAt = new Date(ctx.now().getTime() + (b.expiresIn as number) * 1000);
    else fields.expiresIn = [`Must be whole seconds from 60 to ${MAX_EXPIRY_S}`];
  }
  if (Object.keys(fields).length) return validationError(ctx.requestId, fields);

  const a = await loadAuthorized(ctx, orgId, libraryId, "upload_link.manage");
  if (!a.ok) return a.response;
  if (!publicSharingAllowed(ctx.env)) return sharingOff(ctx.requestId);
  if (!ctx.env.SERVE_BASE) return errorResponse("unavailable", "Links aren't available for this library yet", 409, ctx.requestId);
  if (folder !== "/") {
    const folders = await indexFor(ctx.env, { orgId, libraryId }).call<FolderRow[]>({ op: "listFolders" });
    if (!folders.some((d) => d.path === folder)) return nf(ctx.requestId);
  }
  const token = newShareToken();
  const created = await ctx.repo.createUploadLink({
    orgId,
    libraryId,
    folderPath: folder!,
    label: typeof b.label === "string" ? b.label.trim() : "",
    tokenHash: await tokenHash(`upload:${token}`),
    limits,
    requiresReview: b.requiresReview !== false,
    expiresAt,
    createdBy: actorUuid(ctx.actor.subjectId),
    at: ctx.now(),
  });
  if (!created.ok) return errorResponse("internal_error", "Service unavailable", 503, ctx.requestId);
  return successResponse({ uploadLink: toPublicUploadLink(created.value, ctx.now()), url: `${ctx.env.SERVE_BASE}/_u/${token}` }, ctx.requestId, 201);
}

/** GET …/upload-links */
export async function handleListUploadLinks(ctx: Ctx, orgId: string, libraryId: string): Promise<Response> {
  const a = await loadAuthorized(ctx, orgId, libraryId, "upload_link.manage");
  if (!a.ok) return a.response;
  const r = await ctx.repo.listUploadLinks(orgId, libraryId, 200);
  if (!r.ok) return errorResponse("internal_error", "Service unavailable", 503, ctx.requestId);
  const now = ctx.now();
  return successResponse({ uploadLinks: r.value.map((l) => toPublicUploadLink(l, now)) }, ctx.requestId);
}

/** DELETE …/upload-links/{upl}: revoke. The next guest request gets 404. */
export async function handleRevokeUploadLink(ctx: Ctx, orgId: string, libraryId: string, id: string): Promise<Response> {
  const a = await loadAuthorized(ctx, orgId, libraryId, "upload_link.manage");
  if (!a.ok) return a.response;
  const r = await ctx.repo.revokeUploadLink(orgId, libraryId, id, ctx.now());
  if (!r.ok) return r.error.kind === "not_found" ? nf(ctx.requestId) : errorResponse("internal_error", "Service unavailable", 503, ctx.requestId);
  return successResponse({ uploadLink: toPublicUploadLink(r.value, ctx.now()) }, ctx.requestId);
}

// ── guests (internal, from serve-worker) ───────────────────

async function resolve(env: Env, requestId: string, token: string, now: Date): Promise<{ ok: true; link: UploadLink; repo: MediaRepository } | { ok: false; response: Response }> {
  if (!env.PLATFORM_DB || !env.LIBRARY_INDEX || !publicSharingAllowed(env) || !TOKEN_RE.test(token)) return { ok: false, response: nf(requestId) };
  const repo = createMediaRepository(createSqlExecutor(env.PLATFORM_DB));
  const got = await repo.getUploadLinkByTokenHash(await tokenHash(`upload:${token}`));
  if (!got.ok) return { ok: false, response: got.error.kind === "not_found" ? nf(requestId) : errorResponse("internal_error", "Service unavailable", 503, requestId) };
  const link = got.value;
  if (link.revokedAt) return { ok: false, response: nf(requestId) };
  if (link.expiresAt && link.expiresAt <= now.toISOString()) return { ok: false, response: errorResponse("expired", "This link has expired", 410, requestId) };
  const lib = await repo.getLibrary(link.orgId, link.libraryId);
  if (!lib.ok || lib.value.status !== "active") return { ok: false, response: nf(requestId) };
  const suspended = await repo.getOrgSuspension(link.orgId);
  if (suspended.ok && suspended.value) return { ok: false, response: errorResponse("unavailable_for_legal_reasons", "Unavailable", 451, requestId) };
  return { ok: true, link, repo };
}

/** POST /v1/media/upload-links/open { token }: what the guest page tells the guest. */
export async function handleUploadLinkOpen(env: Env, request: Request, requestId: string, now: Date): Promise<Response> {
  const body = (await readJson(request)) ?? {};
  const r = await resolve(env, requestId, typeof body.token === "string" ? body.token : "", now);
  if (!r.ok) return r.response;
  const { link } = r;
  return successResponse(
    {
      label: link.label,
      limits: { ...link.limits, maxFileBytes: Math.min(link.limits.maxFileBytes, GUEST_MAX_FILE_BYTES) },
      remaining: { files: Math.max(0, link.limits.maxFiles - link.uploads), bytes: Math.max(0, link.limits.maxTotalBytes - link.bytes) },
      expiresAt: link.expiresAt,
      reviewed: link.requiresReview,
    },
    requestId,
  );
}

/** A free name in the folder: the name, then "name (2).ext", … up to (50). */
async function freePath(idx: ReturnType<typeof indexFor>, folder: string, name: string): Promise<{ path: string; name: string } | null> {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 1; n <= 50; n++) {
    const candidate = n === 1 ? name : `${stem} (${n})${ext}`;
    if (candidate.length > 255) return null;
    const path = folder === "/" ? `/${candidate}` : `${folder}/${candidate}`;
    if (!(await idx.call<FileRow | null>({ op: "liveFileAt", path }))) return { path, name: candidate };
  }
  return null;
}

/**
 * POST /v1/media/upload-links/upload?token=&name=&mime= with the file as the body (Content-Length required): one
 * guest file. 201 when stored; 4xx with a code saying which limit stopped it.
 */
export async function handleUploadLinkUpload(env: Env, request: Request, url: URL, requestId: string, now: Date): Promise<Response> {
  const r = await resolve(env, requestId, url.searchParams.get("token") ?? "", now);
  if (!r.ok) return r.response;
  const { link, repo } = r;
  const name = url.searchParams.get("name") ?? "";
  const mime = (url.searchParams.get("mime") || "application/octet-stream").toLowerCase();
  const size = Number(request.headers.get("content-length") ?? "NaN");
  if (!validName(name) || name.startsWith(".")) return validationError(requestId, { name: ["Must be a file name without '/'"] });
  if (!MIME_RE.test(mime)) return validationError(requestId, { mime: ["Invalid type"] });
  if (!Number.isInteger(size) || size < 1) return errorResponse("length_required", "The file's size is needed", 411, requestId);
  const maxFile = Math.min(link.limits.maxFileBytes, GUEST_MAX_FILE_BYTES);
  if (size > maxFile) return errorResponse("too_large", "This file is larger than the link allows", 413, requestId, { max: maxFile });
  const lib = await repo.getLibrary(link.orgId, link.libraryId);
  if (!lib.ok) return nf(requestId);
  const settings = parseSettings(lib.value.settingsJson);
  if (!mimeAllowed(mime, link.limits.allowedTypes) || !mimeAllowed(mime, settings.allowedTypes)) {
    return errorResponse("unsupported_type", "This link doesn't accept this file type", 415, requestId, { allowed: link.limits.allowedTypes });
  }
  if (settings.maxUploadBytes !== null && size > settings.maxUploadBytes) return errorResponse("too_large", "This file is larger than the library allows", 413, requestId);

  // The team's quota, as for a member's upload.
  const [o, usage] = await Promise.all([repo.getLimitOverrides(link.orgId), repo.getUsage(link.orgId, monthOf(now))]);
  if (!o.ok || !usage.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
  const lim = {
    storage: o.value?.storageBytesLimit ?? DEFAULT_MEDIA_LIMITS.storageBytesLimit,
    uploads: o.value?.uploadsPerMonthLimit ?? DEFAULT_MEDIA_LIMITS.uploadsPerMonthLimit,
    file: o.value?.maxFileBytes ?? DEFAULT_MEDIA_LIMITS.maxFileBytes,
  };
  if (size > lim.file || usage.value.storageBytes + size > lim.storage || usage.value.uploadsThisMonth + 1 > lim.uploads) {
    return errorResponse("quota_exceeded", "The team that shared this link has no room for this file", 412, requestId);
  }

  // Reserve against the link's count and total first: concurrent guests can't go past them.
  const reserved = await repo.reserveUpload(link, size, now);
  if (!reserved.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
  if (!reserved.value) return errorResponse("limit_reached", "This link can't take more files", 409, requestId);

  const bucket = env.MEDIA_BUCKET!;
  const objectKey = `${managedPrefix(link.orgId, link.libraryId)}blob/${crypto.randomUUID()}`;
  let stored = false;
  try {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength !== size) {
      await repo.releaseUpload(link.id, size);
      return validationError(requestId, { body: ["The file's size didn't match"] });
    }
    const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (x) => x.toString(16).padStart(2, "0")).join("");
    await bucket.put(objectKey, bytes, { sha256: sha, httpMetadata: { contentType: mime } });
    stored = true;
    const idx = indexFor(env, { orgId: link.orgId, libraryId: link.libraryId });
    const where = await freePath(idx, link.folderPath, name);
    if (!where) throw new Error("no free name");
    const result = await idx.call<CommitResult>({
      op: "commit",
      input: {
        fileId: crypto.randomUUID(),
        path: where.path,
        name: where.name,
        folder: link.folderPath,
        size,
        sha256: sha,
        mime,
        visibility: "private",
        replace: false,
        objectKey,
        actor: uploadLinkPublicId(link.id),
        nowIso: now.toISOString(),
        // Every guest file goes through the pipeline with the safety check, and (by default) waits for review.
        processing: true,
        reviewRequired: link.requiresReview,
      },
    });
    for (const key of result.deleteKeys) await bucket.delete(key);
    await repo.recordUpload(link.orgId, monthOf(now), result.file.size, result.storedBytes, now);
    await startPipeline(env, { orgId: link.orgId, libraryId: link.libraryId, fileId: result.file.id, sha256: sha, requireSafety: true }, "u");
    return successResponse({ file: { name: where.name, size, status: result.file.status, reviewed: link.requiresReview } }, requestId, 201);
  } catch (e) {
    await repo.releaseUpload(link.id, size);
    if (stored) await bucket.delete(objectKey);
    if (e instanceof IndexCallError && e.code === "conflict") return errorResponse("conflict", "A file with this name arrived meanwhile; try again", 409, requestId);
    throw e;
  }
}
