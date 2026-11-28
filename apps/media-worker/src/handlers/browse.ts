// Derived from MarSeventh/CloudFlare-ImgBed@611153e:functions/api/manage/{move,rename}/[[path]].js (MIT), modified.
// ImgBed moves a file by copying its KV record to a new key and deleting the old one, one file per request, with no
// transaction. Here the library's index moves files and folders in one SQLite transaction that also queues the
// serving routes to drop and add, and batches act on up to 1,000 files at once.

import type { Ctx } from "../ctx.js";
import { authorizeOnLibrary } from "../access.js";
import { errorResponse, successResponse, validationError } from "../http.js";
import { indexFor, IndexCallError } from "../index-do/client.js";
import { MAX_BATCH, type BatchResult, type FileRow, type FolderRow, type LiveScope } from "../index-do/core.js";
import { filePublicId, parseFilePublicId } from "../ids.js";
import { loadAuthorized } from "./libraries.js";
import { loadFile, toPublicFile } from "./files.js";
import { normalizeFolder, validName } from "./uploads.js";
import { kickPipeline } from "./pipeline.js";
import { publicSharingAllowed, sharingOff } from "../sharing.js";

const nf = (ctx: Ctx) => errorResponse("not_found", "Not found", 404, ctx.requestId);

/** Names beginning with "_" at a library's root are reserved for the system (e.g. /_random). */
export const reservedTop = (path: string) => (path.split("/")[1] ?? "").startsWith("_");

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const b = (await request.json()) as unknown;
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function indexError(ctx: Ctx, e: unknown): Response {
  if (e instanceof IndexCallError) {
    if (e.code === "not_found") return nf(ctx);
    if (e.code === "conflict") return errorResponse("conflict", e.message, 409, ctx.requestId);
    if (e.code === "forbidden") return errorResponse("conflict", e.message, 409, ctx.requestId, { reason: "taken_down" });
    if (e.code === "invalid_state") return validationError(ctx.requestId, { request: [e.message] });
  }
  throw e;
}

/** Move and/or rename one file (PATCH …/files/{fil} with folder and/or name). Needs file.update. */
export async function moveOneFile(ctx: Ctx, l: Extract<Awaited<ReturnType<typeof loadFile>>, { ok: true }>, folderIn: unknown, nameIn: unknown): Promise<FileRow | Response> {
  const fields: Record<string, string[]> = {};
  const folder = folderIn === undefined ? undefined : normalizeFolder(folderIn);
  if (folder === null) fields.folder = ["Must be a path like /photos/2026 without '.' or '..' segments"];
  if (nameIn !== undefined && !validName(nameIn)) fields.name = ["Must be 1 to 255 characters, without '/'"];
  if (Object.keys(fields).length) return validationError(ctx.requestId, fields);
  const name = (nameIn as string | undefined) ?? l.file.name;
  const target = folder ?? l.file.folder;
  if (reservedTop(target === "/" ? `/${name}` : target)) return validationError(ctx.requestId, { name: ["Names starting with '_' are reserved at the top of a library"] });
  try {
    return await l.idx.call<FileRow>({
      op: "moveFile",
      id: l.file.id,
      ...(folder ? { folder } : {}),
      ...(nameIn !== undefined ? { name } : {}),
      actor: ctx.actor.subjectId,
      nowIso: ctx.now().toISOString(),
    });
  } catch (e) {
    return indexError(ctx, e);
  }
}

/** GET …/folders: the library's folder tree (every folder, with its direct file count); for uploader-only members, only the folders holding their files. */
export async function handleListFolders(ctx: Ctx, orgId: string, libraryId: string): Promise<Response> {
  const a = await loadAuthorized(ctx, orgId, libraryId, "library.read");
  if (!a.ok) return a.response;
  let own = false;
  if (!(await authorizeOnLibrary(ctx.env, ctx.actor, "file.list", a.lib, a.facts, ctx.requestId))) {
    if (!(await authorizeOnLibrary(ctx.env, ctx.actor, "file.list.own", a.lib, a.facts, ctx.requestId))) return nf(ctx);
    own = true; // only the folders holding their own uploads
  }
  const folders = await indexFor(ctx.env, { orgId, libraryId, actor: ctx.actor.subjectId }).call<FolderRow[]>({ op: "listFolders", ...(own ? { uploadedBy: ctx.actor.subjectId } : {}) });
  return successResponse({ folders }, ctx.requestId);
}

/** GET …/tags: tags on live files, most used first (for the filter). */
export async function handleListTags(ctx: Ctx, orgId: string, libraryId: string): Promise<Response> {
  const a = await loadAuthorized(ctx, orgId, libraryId, "file.list");
  if (!a.ok) return a.response;
  const tags = await indexFor(ctx.env, { orgId, libraryId, actor: ctx.actor.subjectId }).call<{ tag: string; files: number }[]>({ op: "listTags" });
  return successResponse({ tags }, ctx.requestId);
}

/** POST …/folders { path }: an empty folder (anyone who can upload). */
export async function handleCreateFolder(ctx: Ctx, request: Request, orgId: string, libraryId: string): Promise<Response> {
  const b = await readJson(request);
  const path = b ? normalizeFolder(b.path) : null;
  if (!path || path === "/") return validationError(ctx.requestId, { path: ["Must be a folder path like /photos/2026"] });
  if (reservedTop(path)) return validationError(ctx.requestId, { path: ["Names starting with '_' are reserved at the top of a library"] });
  const a = await loadAuthorized(ctx, orgId, libraryId, "file.upload");
  if (!a.ok) return a.response;
  try {
    const folder = await indexFor(ctx.env, { orgId, libraryId, actor: ctx.actor.subjectId }).call<FolderRow>({ op: "createFolder", folder: path, actor: ctx.actor.subjectId, nowIso: ctx.now().toISOString() });
    return successResponse({ folder }, ctx.requestId, 201);
  } catch (e) {
    return indexError(ctx, e);
  }
}

/** POST …/folders/move { from, to }: move or rename a folder with everything in it. `to` must not exist. */
export async function handleMoveFolder(ctx: Ctx, request: Request, orgId: string, libraryId: string): Promise<Response> {
  const b = await readJson(request);
  const from = b ? normalizeFolder(b.from) : null;
  const to = b ? normalizeFolder(b.to) : null;
  const fields: Record<string, string[]> = {};
  if (!from || from === "/") fields.from = ["Must be a folder path other than /"];
  if (!to || to === "/") fields.to = ["Must be a folder path other than /"];
  else if (reservedTop(to)) fields.to = ["Names starting with '_' are reserved at the top of a library"];
  if (Object.keys(fields).length) return validationError(ctx.requestId, fields);
  const a = await loadAuthorized(ctx, orgId, libraryId, "file.update");
  if (!a.ok) return a.response;
  try {
    const r = await indexFor(ctx.env, { orgId, libraryId, actor: ctx.actor.subjectId }).call<{ folder: FolderRow; moved: number }>({
      op: "moveFolder",
      from: from!,
      to: to!,
      actor: ctx.actor.subjectId,
      nowIso: ctx.now().toISOString(),
    });
    return successResponse(r, ctx.requestId);
  } catch (e) {
    return indexError(ctx, e);
  }
}

/** POST …/folders/trash { path }: every file under the folder goes to the trash; the folder goes away. */
export async function handleTrashFolder(ctx: Ctx, request: Request, orgId: string, libraryId: string): Promise<Response> {
  const b = await readJson(request);
  const path = b ? normalizeFolder(b.path) : null;
  if (!path || path === "/") return validationError(ctx.requestId, { path: ["Must be a folder path other than /"] });
  const a = await loadAuthorized(ctx, orgId, libraryId, "file.delete");
  if (!a.ok) return a.response;
  try {
    const r = await indexFor(ctx.env, { orgId, libraryId, actor: ctx.actor.subjectId }).call<{ trashed: number }>({ op: "trashFolder", folder: path, nowIso: ctx.now().toISOString() });
    return successResponse(r, ctx.requestId);
  } catch (e) {
    return indexError(ctx, e);
  }
}

const ACTION_PERMISSION = { move: "file.update", visibility: "file.update", trash: "file.delete", restore: "file.restore" } as const;
// Pipelines started directly by one batch; any further files are started by the index's sweep.
const MAX_BATCH_KICKS = 200;

/** POST …/files:batch { action: move|visibility|trash|restore, ids: [fil_…], folder?, visibility? } */
export async function handleBatch(ctx: Ctx, request: Request, orgId: string, libraryId: string): Promise<Response> {
  const b = await readJson(request);
  if (!b) return validationError(ctx.requestId, { body: ["Must be a JSON object"] });
  const action = b.action;
  const fields: Record<string, string[]> = {};
  if (action !== "move" && action !== "visibility" && action !== "trash" && action !== "restore") fields.action = ["Must be move, visibility, trash or restore"];
  if (!Array.isArray(b.ids) || b.ids.length === 0 || b.ids.length > MAX_BATCH || b.ids.some((i) => typeof i !== "string")) {
    fields.ids = [`Must list 1 to ${MAX_BATCH} file ids`];
  }
  const folder = action === "move" ? normalizeFolder(b.folder) : undefined;
  if (action === "move" && folder === null) fields.folder = ["Must be a path like /photos/2026 without '.' or '..' segments"];
  if (action === "move" && folder && folder !== "/" && reservedTop(folder)) fields.folder = ["Names starting with '_' are reserved at the top of a library"];
  if (action === "visibility" && b.visibility !== "public" && b.visibility !== "private") fields.visibility = ["Must be public or private"];
  if (Object.keys(fields).length) return validationError(ctx.requestId, fields);

  const a = await loadAuthorized(ctx, orgId, libraryId, "library.read");
  if (!a.ok) return a.response;
  const act = action as keyof typeof ACTION_PERMISSION;
  if (!(await authorizeOnLibrary(ctx.env, ctx.actor, ACTION_PERMISSION[act], a.lib, a.facts, ctx.requestId))) return nf(ctx);
  if (act === "visibility" && b.visibility === "public" && !publicSharingAllowed(ctx.env)) return sharingOff(ctx.requestId);

  const ids: string[] = [];
  const failed: { id: string; code: string }[] = [];
  for (const raw of b.ids as string[]) {
    const id = parseFilePublicId(raw);
    if (id) ids.push(id);
    else failed.push({ id: raw.slice(0, 80), code: "not_found" });
  }
  let requireSafety = false;
  if (act === "visibility" && b.visibility === "public") {
    const r = await ctx.repo.orgIsOnFreePlan(orgId);
    requireSafety = r.ok ? r.value : true;
  }
  const idx = indexFor(ctx.env, { orgId, libraryId, actor: ctx.actor.subjectId });
  const r = await idx.call<BatchResult>({
    op: "batch",
    ids,
    act:
      act === "move"
        ? { action: "move", folder: folder! }
        : act === "visibility"
          ? { action: "visibility", visibility: b.visibility as "public" | "private", requireSafety }
          : { action: act },
    actor: ctx.actor.subjectId,
    nowIso: ctx.now().toISOString(),
  });
  if (act === "visibility") {
    const attempt = `b${ctx.now().getTime().toString(36)}`;
    for (const f of r.done.filter((x) => x.status === "processing").slice(0, MAX_BATCH_KICKS)) await kickPipeline(ctx, orgId, libraryId, f, requireSafety, attempt);
  }
  const small = r.done.length <= 200;
  return successResponse(
    {
      done: r.done.length,
      failed: [...failed, ...r.failed.map((x) => ({ id: filePublicId(x.id), code: x.code }))],
      ...(small ? { files: r.done.map((f) => toPublicFile(f, a.lib, ctx.env)) } : {}),
    },
    ctx.requestId,
  );
}

/**
 * POST …/live-tickets: a one-use ticket (valid 60 s) for opening the library's live socket at `path?ticket=…`.
 * Someone who may list every file hears about every file; someone who may list only their own uploads, only those.
 */
export async function handleLiveTicket(ctx: Ctx, orgId: string, libraryId: string, orgPub: string, libPub: string): Promise<Response> {
  const a = await loadAuthorized(ctx, orgId, libraryId, "library.read");
  if (!a.ok) return a.response;
  let scope: LiveScope;
  if (await authorizeOnLibrary(ctx.env, ctx.actor, "file.list", a.lib, a.facts, ctx.requestId)) scope = "all";
  else if (await authorizeOnLibrary(ctx.env, ctx.actor, "file.list.own", a.lib, a.facts, ctx.requestId)) scope = "own";
  else return nf(ctx);
  const t = await indexFor(ctx.env, { orgId, libraryId, actor: ctx.actor.subjectId }).call<{ ticket: string; expiresAt: string }>({
    op: "issueTicket",
    subject: ctx.actor.subjectId,
    scope,
    nowIso: ctx.now().toISOString(),
  });
  return successResponse({ ...t, scope, path: `/v1/organizations/${orgPub}/libraries/${libPub}/live` }, ctx.requestId, 201);
}
