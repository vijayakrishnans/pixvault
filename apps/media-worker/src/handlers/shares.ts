// Share links (PV6). Owners create, list and revoke them through the API (share.create). Guests reach them only
// through serve-worker's /_s/<token> pages, which call the two internal routes below over the service binding:
// media-worker has no public route, and api-edge doesn't forward /v1/media/shares/*.
//
// Every guest request resolves the link from D1 again, so a revoked, expired or used-up link stops at the next
// request: nothing caches the grant. A guest sees only the shared file, or the served files under the shared
// folder, never anything else in the library (OWASP A01).

import { storeFor } from "../storage/stores.js";
import type { Ctx } from "../ctx.js";
import type { Env } from "../env.js";
import { createSqlExecutor } from "@saas/db/d1";
import { createMediaRepository, type MediaRepository, type ShareLink } from "@saas/db/media";
import { errorResponse, successResponse, validationError } from "../http.js";
import { indexFor } from "../index-do/client.js";
import type { CollectionRow, FileRow, FolderRow } from "../index-do/core.js";
import { actorUuid, collectionPublicId, filePublicId, parseCollectionPublicId, parseFilePublicId, shareLinkPublicId } from "../ids.js";
import { uuidToHex } from "@saas/db/ids";
import { loadAuthorized } from "./libraries.js";
import { normalizeFolder } from "./uploads.js";
import { publicSharingAllowed, sharingOff } from "../sharing.js";
import { TOKEN_RE, hashPassword, newShareToken, tokenHash, unlockProof, verifyPassword, verifyUnlock } from "../shares/secrets.js";

const MAX_EXPIRY_S = 365 * 86400;
const MAX_FOLDER_FILES = 500;
// Shown inline only when the type can't run script; everything else downloads (the same list serving uses).
const INLINE = /^(image\/(png|jpe?g|gif|webp|avif|bmp|x-icon)|video\/[a-z0-9.+-]+|audio\/[a-z0-9.+-]+|application\/pdf|text\/plain)$/i;

export interface PublicShareLink {
  id: string;
  targetKind: ShareLink["targetKind"];
  /** fil_… for a file; the folder path for a folder. */
  target: string;
  targetLabel: string;
  mode: ShareLink["mode"];
  expiresAt: string | null;
  hasPassword: boolean;
  maxDownloads: number | null;
  downloads: number;
  opens: number;
  lastOpenedAt: string | null;
  createdBy: string;
  createdAt: string;
  revokedAt: string | null;
  status: "active" | "expired" | "revoked" | "used_up";
}

function statusOf(l: ShareLink, now: Date): PublicShareLink["status"] {
  if (l.revokedAt) return "revoked";
  if (l.expiresAt && l.expiresAt <= now.toISOString()) return "expired";
  if (l.maxDownloads !== null && l.downloads >= l.maxDownloads) return "used_up";
  return "active";
}

export function toPublicShareLink(l: ShareLink, now: Date): PublicShareLink {
  return {
    id: shareLinkPublicId(l.id),
    targetKind: l.targetKind,
    target: l.targetKind === "file" ? filePublicId(l.targetId) : l.targetKind === "collection" ? collectionPublicId(l.targetId) : l.targetId,
    targetLabel: l.targetLabel,
    mode: l.mode,
    expiresAt: l.expiresAt,
    hasPassword: l.passwordHash !== null,
    maxDownloads: l.maxDownloads,
    downloads: l.downloads,
    opens: l.opens,
    lastOpenedAt: l.lastOpenedAt,
    // Stored as the actor's UUID (as Cirrus stores actors); shown as the user id.
    createdBy: /^[0-9a-f-]{36}$/.test(l.createdBy) ? `usr_${uuidToHex(l.createdBy as never)}` : l.createdBy,
    createdAt: l.createdAt,
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

// ── owners ─────────────────────────────────────────────────

/**
 * POST …/share-links { target: { kind: "file", fileId } | { kind: "folder", path }, mode?: "view"|"download",
 * expiresIn?: seconds, password?, maxDownloads? } → 201 { shareLink, url }. The URL holds the token; it's shown
 * once and only its hash is kept.
 */
export async function handleCreateShareLink(ctx: Ctx, request: Request, orgId: string, libraryId: string): Promise<Response> {
  const b = await readJson(request);
  if (!b) return validationError(ctx.requestId, { body: ["Must be a JSON object"] });
  const fields: Record<string, string[]> = {};
  const target = (b.target ?? null) as { kind?: unknown; fileId?: unknown; path?: unknown; collectionId?: unknown } | null;
  const kind = target?.kind;
  if (kind !== "file" && kind !== "folder" && kind !== "collection") fields.target = ["Must be { kind: 'file', fileId }, { kind: 'folder', path } or { kind: 'collection', collectionId }"];
  const collectionId = kind === "collection" && typeof target?.collectionId === "string" ? parseCollectionPublicId(target.collectionId) : null;
  if (kind === "collection" && !collectionId) fields["target.collectionId"] = ["Must be a collection id"];
  const fileId = kind === "file" && typeof target?.fileId === "string" ? parseFilePublicId(target.fileId) : null;
  if (kind === "file" && !fileId) fields["target.fileId"] = ["Must be a file id"];
  const folder = kind === "folder" ? normalizeFolder(target?.path) : null;
  if (kind === "folder" && (!folder || folder === "/")) fields["target.path"] = ["Must be a folder path other than /"];
  const mode = b.mode ?? "view";
  if (mode !== "view" && mode !== "download") fields.mode = ["Must be view or download"];
  let expiresAt: Date | null = null;
  if (b.expiresIn !== undefined && b.expiresIn !== null) {
    if (typeof b.expiresIn !== "number" || !Number.isInteger(b.expiresIn) || b.expiresIn < 60 || b.expiresIn > MAX_EXPIRY_S) fields.expiresIn = [`Must be whole seconds from 60 to ${MAX_EXPIRY_S}`];
    else expiresAt = new Date(ctx.now().getTime() + b.expiresIn * 1000);
  }
  if (b.password !== undefined && b.password !== null && (typeof b.password !== "string" || b.password.length < 8 || b.password.length > 128)) {
    fields.password = ["Must be 8 to 128 characters"];
  }
  if (b.maxDownloads !== undefined && b.maxDownloads !== null && (typeof b.maxDownloads !== "number" || !Number.isInteger(b.maxDownloads) || b.maxDownloads < 1 || b.maxDownloads > 100_000)) {
    fields.maxDownloads = ["Must be a whole number from 1 to 100000"];
  }
  if (Object.keys(fields).length) return validationError(ctx.requestId, fields);

  const a = await loadAuthorized(ctx, orgId, libraryId, "share.create");
  if (!a.ok) return a.response;
  if (!publicSharingAllowed(ctx.env)) return sharingOff(ctx.requestId);
  if (!ctx.env.SERVE_BASE) return errorResponse("unavailable", "Links aren't available for this library yet", 409, ctx.requestId);

  const idx = indexFor(ctx.env, { orgId, libraryId, actor: ctx.actor.subjectId });
  let targetId: string;
  let label: string;
  if (kind === "file") {
    const f = await idx.call<FileRow | null>({ op: "getFile", id: fileId! });
    if (!f || f.status === "trashed") return nf(ctx.requestId);
    // Only what is being served can be shared: not a file still processing, held, flagged or taken down.
    if (f.status !== "public" && f.status !== "private") return errorResponse("conflict", "This file can't be shared in its current state", 409, ctx.requestId, { status: f.status });
    targetId = f.id;
    label = f.name;
  } else if (kind === "collection") {
    const c = await idx.call<CollectionRow | null>({ op: "getCollection", id: collectionId! });
    if (!c) return nf(ctx.requestId);
    targetId = c.id;
    label = c.name;
  } else {
    const folders = await idx.call<FolderRow[]>({ op: "listFolders" });
    if (!folders.some((d) => d.path === folder)) return nf(ctx.requestId);
    targetId = folder!;
    label = folder!;
  }
  const token = newShareToken();
  const created = await ctx.repo.createShareLink({
    orgId,
    libraryId,
    targetKind: kind as "file" | "folder" | "collection",
    targetId,
    targetLabel: label,
    mode: mode as "view" | "download",
    tokenHash: await tokenHash(token),
    passwordHash: typeof b.password === "string" ? await hashPassword(b.password) : null,
    expiresAt,
    maxDownloads: (b.maxDownloads as number | undefined) ?? null,
    createdBy: actorUuid(ctx.actor.subjectId),
    at: ctx.now(),
  });
  if (!created.ok) return errorResponse("internal_error", "Service unavailable", 503, ctx.requestId);
  return successResponse({ shareLink: toPublicShareLink(created.value, ctx.now()), url: `${ctx.env.SERVE_BASE}/_s/${token}` }, ctx.requestId, 201);
}

/** GET …/share-links?file=fil_…|folder=/path */
export async function handleListShareLinks(ctx: Ctx, url: URL, orgId: string, libraryId: string): Promise<Response> {
  const a = await loadAuthorized(ctx, orgId, libraryId, "share.create");
  if (!a.ok) return a.response;
  const file = url.searchParams.get("file");
  const folderParam = url.searchParams.get("folder");
  const filter: { targetKind?: "file" | "folder" | "collection"; targetId?: string; limit: number } = { limit: 200 };
  const collection = url.searchParams.get("collection");
  if (collection) {
    const id = parseCollectionPublicId(collection);
    if (!id) return validationError(ctx.requestId, { collection: ["Must be a collection id"] });
    filter.targetKind = "collection";
    filter.targetId = id;
  } else if (file) {
    const id = parseFilePublicId(file);
    if (!id) return validationError(ctx.requestId, { file: ["Must be a file id"] });
    filter.targetKind = "file";
    filter.targetId = id;
  } else if (folderParam) {
    const f = normalizeFolder(folderParam);
    if (!f) return validationError(ctx.requestId, { folder: ["Invalid folder"] });
    filter.targetKind = "folder";
    filter.targetId = f;
  }
  const r = await ctx.repo.listShareLinks(orgId, libraryId, filter);
  if (!r.ok) return errorResponse("internal_error", "Service unavailable", 503, ctx.requestId);
  const now = ctx.now();
  return successResponse({ shareLinks: r.value.map((l) => toPublicShareLink(l, now)) }, ctx.requestId);
}

/** DELETE …/share-links/{shl}: revoke. The next guest request gets 404. */
export async function handleRevokeShareLink(ctx: Ctx, orgId: string, libraryId: string, id: string): Promise<Response> {
  const a = await loadAuthorized(ctx, orgId, libraryId, "share.create");
  if (!a.ok) return a.response;
  const r = await ctx.repo.revokeShareLink(orgId, libraryId, id, ctx.now());
  if (!r.ok) return r.error.kind === "not_found" ? nf(ctx.requestId) : errorResponse("internal_error", "Service unavailable", 503, ctx.requestId);
  return successResponse({ shareLink: toPublicShareLink(r.value, ctx.now()) }, ctx.requestId);
}

// ── guests (internal, from serve-worker) ───────────────────

type Resolved =
  | { ok: true; link: ShareLink; repo: MediaRepository; proof?: { value: string; maxAge: number } }
  | { ok: false; response: Response };

/** The link behind a token, if a guest may use it now (and has unlocked it when it has a password). */
async function resolve(env: Env, requestId: string, body: Record<string, unknown>, now: Date): Promise<Resolved> {
  const token = typeof body.token === "string" ? body.token : "";
  if (!env.PLATFORM_DB || !env.LIBRARY_INDEX || !publicSharingAllowed(env) || !TOKEN_RE.test(token)) return { ok: false, response: nf(requestId) };
  const repo = createMediaRepository(createSqlExecutor(env.PLATFORM_DB));
  const got = await repo.getShareLinkByTokenHash(await tokenHash(token));
  if (!got.ok) return { ok: false, response: got.error.kind === "not_found" ? nf(requestId) : errorResponse("internal_error", "Service unavailable", 503, requestId) };
  const link = got.value;
  if (link.revokedAt) return { ok: false, response: nf(requestId) };
  if (link.expiresAt && link.expiresAt <= now.toISOString()) return { ok: false, response: errorResponse("expired", "This link has expired", 410, requestId) };
  const lib = await repo.getLibrary(link.orgId, link.libraryId);
  if (!lib.ok || lib.value.status !== "active") return { ok: false, response: nf(requestId) };
  const suspended = await repo.getOrgSuspension(link.orgId);
  if (suspended.ok && suspended.value) return { ok: false, response: errorResponse("unavailable_for_legal_reasons", "Unavailable", 451, requestId) };
  if (link.passwordHash) {
    const nowS = Math.floor(now.getTime() / 1000);
    if (await verifyUnlock(typeof body.proof === "string" ? body.proof : undefined, link.id, link.passwordHash, nowS)) return { ok: true, link, repo };
    if (typeof body.password === "string" && body.password.length <= 128 && (await verifyPassword(body.password, link.passwordHash))) {
      return { ok: true, link, repo, proof: { value: (await unlockProof(link.id, link.passwordHash, nowS)).proof, maxAge: 12 * 3600 } };
    }
    return { ok: false, response: errorResponse("password_required", typeof body.password === "string" ? "Wrong password" : "This link needs a password", 401, requestId, { wrong: typeof body.password === "string" }) };
  }
  return { ok: true, link, repo };
}

function inShare(link: ShareLink, f: FileRow): boolean {
  if (f.status !== "public" && f.status !== "private") return false;
  if (link.targetKind === "file") return f.id === link.targetId;
  if (link.targetKind === "folder") return f.folder === link.targetId || f.folder.startsWith(`${link.targetId}/`);
  // Collections are checked against the index by the caller; here only the state.
  return link.targetKind === "collection";
}

/** POST /v1/media/shares/open { token, proof?, password? }: what the landing page shows. */
export async function handleShareOpen(env: Env, request: Request, requestId: string, now: Date): Promise<Response> {
  const body = (await readJson(request)) ?? {};
  const r = await resolve(env, requestId, body, now);
  if (!r.ok) return r.response;
  const { link } = r;
  if (link.mode === "download" && link.maxDownloads !== null && link.downloads >= link.maxDownloads) {
    return errorResponse("used_up", "This link has reached its download limit", 410, requestId);
  }
  const idx = indexFor(env, { orgId: link.orgId, libraryId: link.libraryId });
  let files: FileRow[];
  if (link.targetKind === "file") {
    const f = await idx.call<FileRow | null>({ op: "getFile", id: link.targetId });
    if (f?.status === "removed") return errorResponse("unavailable_for_legal_reasons", "Unavailable", 451, requestId);
    if (!f || !inShare(link, f)) return nf(requestId);
    files = [f];
  } else if (link.targetKind === "collection") {
    files = await idx.call<FileRow[]>({ op: "collectionFiles", id: link.targetId, servedOnly: true, limit: MAX_FOLDER_FILES });
  } else {
    files = (await idx.call<{ files: FileRow[] }>({ op: "listFiles", under: link.targetId, servedOnly: true, status: "live", limit: MAX_FOLDER_FILES })).files;
  }
  if (body.password !== undefined || !body.proof) await r.repo.recordShareOpen(link.id, now);
  const root = link.targetKind === "folder" ? link.targetId : null;
  return successResponse(
    {
      share: {
        kind: link.targetKind,
        mode: link.mode,
        label: link.targetKind === "folder" ? link.targetLabel.split("/").pop() : link.targetLabel,
        expiresAt: link.expiresAt,
        downloadsLeft: link.maxDownloads === null ? null : Math.max(0, link.maxDownloads - link.downloads),
      },
      files: files.map((f) => ({
        id: filePublicId(f.id),
        name: f.name,
        size: f.size,
        mime: f.mime,
        folder: root ? f.folder.slice(root.length) || "/" : "/",
        width: f.width ?? null,
        height: f.height ?? null,
      })),
      truncated: files.length >= MAX_FOLDER_FILES,
      ...(r.proof ? { proof: r.proof } : {}),
    },
    requestId,
  );
}

/** POST /v1/media/shares/content { token, proof?, fileId, download? }: the bytes of one file in the share. */
export async function handleShareContent(env: Env, request: Request, requestId: string, now: Date): Promise<Response> {
  const body = (await readJson(request)) ?? {};
  const r = await resolve(env, requestId, body, now);
  if (!r.ok) return r.response;
  const { link } = r;
  const id = typeof body.fileId === "string" ? parseFilePublicId(body.fileId) : null;
  if (!id) return nf(requestId);
  const got = await indexFor(env, { orgId: link.orgId, libraryId: link.libraryId }).call<{ file: FileRow; objectKey: string | null } | null>({ op: "getFileWithKey", id });
  if (got?.file.status === "removed" && (link.targetKind !== "file" || got.file.id === link.targetId)) return errorResponse("unavailable_for_legal_reasons", "Unavailable", 451, requestId);
  if (!got || !got.objectKey || !inShare(link, got.file)) return nf(requestId);
  // A collection link reaches only files in that collection now (removing a file from it takes it out of the share).
  if (link.targetKind === "collection" && !(await indexFor(env, { orgId: link.orgId, libraryId: link.libraryId }).call<boolean>({ op: "inCollection", id: link.targetId, fileId: got.file.id }))) return nf(requestId);
  const f = got.file;
  const download = link.mode === "download" || body.download === true || !INLINE.test(f.mime);
  // A download counts against the link's limit; viewing inline (view mode) doesn't.
  if (download) {
    const counted = await r.repo.consumeShareDownload(link.id, now);
    if (counted.ok && !counted.value) return errorResponse("used_up", "This link has reached its download limit", 410, requestId);
  }
  const obj = await (await storeFor(env, link.orgId, link.libraryId)).get(got.objectKey);
  if (!obj) return nf(requestId);
  const safe = f.name.replace(/["\\\r\n]/g, "_");
  return new Response(obj.body, {
    headers: {
      "content-type": f.mime,
      "content-length": String(obj.size),
      "content-disposition": `${download ? "attachment" : "inline"}; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
      "referrer-policy": "no-referrer",
      etag: `"${f.blob_sha256}"`,
      "x-request-id": requestId,
    },
  });
}
