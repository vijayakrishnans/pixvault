// Collections (PV6): named, ordered sets of files in a library. Editors and managers manage them (file.update);
// anyone who may list every file sees them (file.list). A collection marked as a public gallery gets a page on
// serve-worker that shows only its files that are already public, and only while public sharing is on.

import type { Ctx } from "../ctx.js";
import { errorResponse, successResponse, validationError } from "../http.js";
import { indexFor, IndexCallError } from "../index-do/client.js";
import type { CollectionRow, FileRow } from "../index-do/core.js";
import { actorUuid, collectionPublicId, filePublicId, parseFilePublicId } from "../ids.js";
import { loadAuthorized } from "./libraries.js";
import { toPublicFile } from "./files.js";
import { publicSharingAllowed, sharingOff } from "../sharing.js";
import type { Library } from "@saas/db/media";
import type { Env } from "../env.js";

export interface PublicCollection {
  id: string;
  name: string;
  description: string;
  publicGallery: boolean;
  /** The gallery's page, when it is one and public sharing is on. */
  galleryUrl: string | null;
  files: number;
  coverFileId: string | null;
  createdAt: string;
  updatedAt: string;
}

export function galleryPath(lib: Library, collectionId: string): string | null {
  if (!lib.orgSlug) return null;
  return `/${lib.orgSlug}/${lib.slug}/_gallery/${collectionPublicId(collectionId).slice(4)}`;
}

function toPublicCollection(c: CollectionRow, lib: Library, env: Env): PublicCollection {
  const path = galleryPath(lib, c.id);
  return {
    id: collectionPublicId(c.id),
    name: c.name,
    description: c.description,
    publicGallery: c.public_gallery === 1,
    galleryUrl: c.public_gallery === 1 && publicSharingAllowed(env) && env.SERVE_BASE && path ? `${env.SERVE_BASE}${path}` : null,
    files: Number(c.files),
    coverFileId: c.cover_file_id ? filePublicId(c.cover_file_id) : null,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  };
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const b = (await request.json()) as unknown;
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function fieldsOf(b: Record<string, unknown>, creating: boolean): { fields: Record<string, string[]>; patch: { name?: string; description?: string; publicGallery?: boolean } } {
  const fields: Record<string, string[]> = {};
  const patch: { name?: string; description?: string; publicGallery?: boolean } = {};
  if (b.name !== undefined || creating) {
    if (typeof b.name === "string" && b.name.trim().length >= 1 && b.name.length <= 100 && !/[\u0000-\u001f]/.test(b.name)) patch.name = b.name.trim();
    else fields.name = ["Must be 1 to 100 characters"];
  }
  if (b.description !== undefined) {
    if (typeof b.description === "string" && b.description.length <= 2000) patch.description = b.description;
    else fields.description = ["At most 2000 characters"];
  }
  if (b.publicGallery !== undefined) {
    if (typeof b.publicGallery === "boolean") patch.publicGallery = b.publicGallery;
    else fields.publicGallery = ["Must be a boolean"];
  }
  return { fields, patch };
}

function indexError(ctx: Ctx, e: unknown): Response {
  if (e instanceof IndexCallError) {
    if (e.code === "not_found") return errorResponse("not_found", "Not found", 404, ctx.requestId);
    if (e.code === "invalid_state") return validationError(ctx.requestId, { request: [e.message] });
  }
  throw e;
}

/** GET …/collections */
export async function handleListCollections(ctx: Ctx, orgId: string, libraryId: string): Promise<Response> {
  const a = await loadAuthorized(ctx, orgId, libraryId, "file.list");
  if (!a.ok) return a.response;
  const rows = await indexFor(ctx.env, { orgId, libraryId, actor: ctx.actor.subjectId }).call<CollectionRow[]>({ op: "listCollections" });
  return successResponse({ collections: rows.map((c) => toPublicCollection(c, a.lib, ctx.env)) }, ctx.requestId);
}

/** POST …/collections { name, description?, publicGallery? } */
export async function handleCreateCollection(ctx: Ctx, request: Request, orgId: string, libraryId: string): Promise<Response> {
  const b = await readJson(request);
  if (!b) return validationError(ctx.requestId, { body: ["Must be a JSON object"] });
  const { fields, patch } = fieldsOf(b, true);
  if (Object.keys(fields).length) return validationError(ctx.requestId, fields);
  const a = await loadAuthorized(ctx, orgId, libraryId, "file.update");
  if (!a.ok) return a.response;
  if (patch.publicGallery && !publicSharingAllowed(ctx.env)) return sharingOff(ctx.requestId);
  try {
    const c = await indexFor(ctx.env, { orgId, libraryId, actor: ctx.actor.subjectId }).call<CollectionRow>({
      op: "createCollection",
      input: { id: crypto.randomUUID(), name: patch.name!, description: patch.description ?? "", publicGallery: patch.publicGallery ?? false, actor: actorUuid(ctx.actor.subjectId), nowIso: ctx.now().toISOString() },
    });
    return successResponse({ collection: toPublicCollection(c, a.lib, ctx.env) }, ctx.requestId, 201);
  } catch (e) {
    return indexError(ctx, e);
  }
}

/** GET …/collections/{col}?cursor is not paged: at most 500 files, in order. */
export async function handleGetCollection(ctx: Ctx, orgId: string, libraryId: string, id: string): Promise<Response> {
  const a = await loadAuthorized(ctx, orgId, libraryId, "file.list");
  if (!a.ok) return a.response;
  const idx = indexFor(ctx.env, { orgId, libraryId, actor: ctx.actor.subjectId });
  const c = await idx.call<CollectionRow | null>({ op: "getCollection", id });
  if (!c) return errorResponse("not_found", "Not found", 404, ctx.requestId);
  const files = await idx.call<FileRow[]>({ op: "collectionFiles", id, limit: 500 });
  return successResponse({ collection: toPublicCollection(c, a.lib, ctx.env), files: files.map((f) => toPublicFile(f, a.lib, ctx.env)) }, ctx.requestId);
}

/** PATCH …/collections/{col} { name?, description?, publicGallery? } */
export async function handleUpdateCollection(ctx: Ctx, request: Request, orgId: string, libraryId: string, id: string): Promise<Response> {
  const b = await readJson(request);
  if (!b) return validationError(ctx.requestId, { body: ["Must be a JSON object"] });
  const { fields, patch } = fieldsOf(b, false);
  if (Object.keys(fields).length) return validationError(ctx.requestId, fields);
  const a = await loadAuthorized(ctx, orgId, libraryId, "file.update");
  if (!a.ok) return a.response;
  if (patch.publicGallery && !publicSharingAllowed(ctx.env)) return sharingOff(ctx.requestId);
  try {
    const c = await indexFor(ctx.env, { orgId, libraryId, actor: ctx.actor.subjectId }).call<CollectionRow>({ op: "updateCollection", id, patch, nowIso: ctx.now().toISOString() });
    return successResponse({ collection: toPublicCollection(c, a.lib, ctx.env) }, ctx.requestId);
  } catch (e) {
    return indexError(ctx, e);
  }
}

/** DELETE …/collections/{col}: the collection goes; its files stay. */
export async function handleDeleteCollection(ctx: Ctx, orgId: string, libraryId: string, id: string): Promise<Response> {
  const a = await loadAuthorized(ctx, orgId, libraryId, "file.update");
  if (!a.ok) return a.response;
  try {
    await indexFor(ctx.env, { orgId, libraryId, actor: ctx.actor.subjectId }).call({ op: "deleteCollection", id });
    return successResponse({ deleted: true }, ctx.requestId);
  } catch (e) {
    return indexError(ctx, e);
  }
}

/** POST …/collections/{col}/items { action: "add"|"remove", ids: [fil_…] } (at most 500 at a time) */
export async function handleCollectionItems(ctx: Ctx, request: Request, orgId: string, libraryId: string, id: string): Promise<Response> {
  const b = await readJson(request);
  const fields: Record<string, string[]> = {};
  if (!b || (b.action !== "add" && b.action !== "remove")) fields.action = ["Must be add or remove"];
  if (!b || !Array.isArray(b.ids) || b.ids.length < 1 || b.ids.length > 500 || b.ids.some((x) => typeof x !== "string")) fields.ids = ["Must list 1 to 500 file ids"];
  if (Object.keys(fields).length) return validationError(ctx.requestId, fields);
  const a = await loadAuthorized(ctx, orgId, libraryId, "file.update");
  if (!a.ok) return a.response;
  const ids: string[] = [];
  const bad: string[] = [];
  for (const raw of b!.ids as string[]) {
    const fid = parseFilePublicId(raw);
    if (fid) ids.push(fid);
    else bad.push(raw.slice(0, 80));
  }
  try {
    const r = await indexFor(ctx.env, { orgId, libraryId, actor: ctx.actor.subjectId }).call<{ collection: CollectionRow; changed: number; failed: string[] }>({
      op: "collectionItems",
      id,
      action: b!.action as "add" | "remove",
      fileIds: ids,
      nowIso: ctx.now().toISOString(),
    });
    return successResponse({ collection: toPublicCollection(r.collection, a.lib, ctx.env), changed: r.changed, failed: [...bad, ...r.failed.map((f) => filePublicId(f))] }, ctx.requestId);
  } catch (e) {
    return indexError(ctx, e);
  }
}
