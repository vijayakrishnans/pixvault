// Comments on files (PV6), kept in the library's index. Anyone who may read a file may read and write its comments
// (an uploader-only member, on their own files). Authors edit their own; authors and editors or managers
// (file.update) resolve or delete. A comment may mention up to 10 library members who can read the file; each is
// emailed once through notifications-worker, best effort: the comment never fails because an email couldn't go.

import { buildIdempotencyKey, enqueueNotification } from "@saas/notifications-client";
import { uuidFromPublicId, uuidToHex } from "@saas/db/ids";
import type { LibraryMember } from "@saas/db/media";
import type { Ctx } from "../ctx.js";
import { authorizeOnLibrary } from "../access.js";
import { errorResponse, successResponse, validationError } from "../http.js";
import { IndexCallError } from "../index-do/client.js";
import type { CommentRow, FileRow } from "../index-do/core.js";
import { actorUuid, commentPublicId, filePublicId, libraryPublicId, orgPublicId } from "../ids.js";
import { canRead, loadFile } from "./files.js";
import { logError } from "../log.js";

const MAX_BODY = 4000;
const MAX_MENTIONS = 10;
const BODY_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const SUBJECT_RE = /^usr_[0-9a-f]{32}$/;

export interface PublicComment {
  id: string;
  fileId: string;
  author: string;
  body: string;
  mentions: string[];
  createdAt: string;
  editedAt: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

const userId = (stored: string | null) => (stored && /^[0-9a-f-]{36}$/.test(stored) ? `usr_${uuidToHex(stored as never)}` : stored);

function toPublicComment(c: CommentRow): PublicComment {
  let mentions: string[] = [];
  try {
    const v = JSON.parse(c.mentions_json) as unknown;
    mentions = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    /* none */
  }
  return {
    id: commentPublicId(c.id),
    fileId: filePublicId(c.file_id),
    author: userId(c.author)!,
    body: c.body,
    mentions,
    createdAt: c.created_at,
    editedAt: c.edited_at,
    resolvedAt: c.resolved_at,
    resolvedBy: userId(c.resolved_by),
  };
}

const nf = (ctx: Ctx) => errorResponse("not_found", "Not found", 404, ctx.requestId);

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const b = (await request.json()) as unknown;
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function validBody(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.length <= MAX_BODY && !BODY_CONTROL.test(v);
}

/** The file, if the caller may read it (comments follow the file's access). */
async function readable(ctx: Ctx, orgId: string, libraryId: string, fileId: string) {
  const l = await loadFile(ctx, orgId, libraryId, fileId);
  if (!l.ok) return l;
  if (l.file.status === "trashed" || !(await canRead(ctx, l.a, l.file))) return { ok: false as const, response: nf(ctx) };
  return l;
}

/** GET …/files/{fil}/comments */
export async function handleListComments(ctx: Ctx, orgId: string, libraryId: string, fileId: string): Promise<Response> {
  const l = await readable(ctx, orgId, libraryId, fileId);
  if (!l.ok) return l.response;
  const rows = await l.idx.call<CommentRow[]>({ op: "listComments", fileId });
  return successResponse({ comments: rows.map(toPublicComment) }, ctx.requestId);
}

/** Members who may be mentioned on this file: library members who can read it, not the author. */
function mentionable(members: LibraryMember[], f: FileRow, author: string): Map<string, LibraryMember> {
  const out = new Map<string, LibraryMember>();
  for (const m of members) {
    if (m.principalId === author) continue;
    // An uploader-only member sees only their own uploads.
    if (m.role === "uploader" && f.uploaded_by !== m.principalId) continue;
    out.set(m.principalId, m);
  }
  return out;
}

/** POST …/files/{fil}/comments { body, mentions?: [usr_…] } */
export async function handleAddComment(ctx: Ctx, request: Request, orgId: string, libraryId: string, fileId: string): Promise<Response> {
  const b = await readJson(request);
  const fields: Record<string, string[]> = {};
  if (!b || !validBody(b.body)) fields.body = [`Must be 1 to ${MAX_BODY} characters`];
  const asked = b?.mentions ?? [];
  if (!Array.isArray(asked) || asked.length > MAX_MENTIONS || asked.some((m) => typeof m !== "string" || !SUBJECT_RE.test(m))) fields.mentions = [`Up to ${MAX_MENTIONS} user ids`];
  if (Object.keys(fields).length) return validationError(ctx.requestId, fields);
  const l = await readable(ctx, orgId, libraryId, fileId);
  if (!l.ok) return l.response;

  // Keep only mentions of people who can see the file; others are dropped silently (no hint who exists).
  let targets: LibraryMember[] = [];
  if ((asked as string[]).length) {
    const members = await ctx.repo.listMembers(orgId, libraryId);
    if (members.ok) {
      const allowed = mentionable(members.value, l.file, ctx.actor.subjectId);
      targets = [...new Set(asked as string[])].map((m) => allowed.get(m)).filter((m): m is LibraryMember => !!m);
      // Org members' memberships carry no email (guests' do): look theirs up in the platform's users.
      const missing = targets.filter((m) => !m.email).map((m) => uuidFromPublicId(m.principalId)).filter((u): u is NonNullable<typeof u> => !!u);
      if (missing.length) {
        const emails = await ctx.repo.userEmails(missing);
        if (emails.ok) targets = targets.map((m) => (m.email ? m : { ...m, email: emails.value.get(uuidFromPublicId(m.principalId) ?? "") ?? null }));
      }
      targets = targets.filter((m) => !!m.email);
    }
  }
  const now = ctx.now();
  let c: CommentRow;
  try {
    c = await l.idx.call<CommentRow>({
      op: "addComment",
      input: { id: crypto.randomUUID(), fileId, author: actorUuid(ctx.actor.subjectId), body: (b!.body as string).trim(), mentions: targets.map((m) => m.principalId), nowIso: now.toISOString() },
    });
  } catch (e) {
    if (e instanceof IndexCallError && e.code === "not_found") return nf(ctx);
    if (e instanceof IndexCallError && e.code === "invalid_state") return validationError(ctx.requestId, { body: [e.message] });
    throw e;
  }

  // Mention emails: best effort, one per person per comment (idempotent).
  const link = ctx.env.APP_BASE ? `${ctx.env.APP_BASE}/o/${orgPublicId(orgId)}/l/${libraryPublicId(libraryId)}` : "";
  const excerpt = c.body.length > 140 ? `${c.body.slice(0, 139)}…` : c.body;
  for (const m of targets) {
    const r = await enqueueNotification(
      ctx.env,
      { internalActor: "media-worker", actorSubjectType: ctx.actor.subjectType, actorSubjectId: ctx.actor.subjectId, requestId: ctx.requestId },
      {
        orgId,
        category: "product",
        templateKey: "media.comment_mention",
        templateData: { actorName: ctx.actor.email || "A teammate", fileName: l.file.name, libraryName: l.a.lib.name, excerpt, link },
        recipient: { channel: "email", address: m.email!, subjectKind: "user", subjectId: m.principalId },
        idempotencyKey: buildIdempotencyKey("media.comment_mention", c.id, m.principalId),
      },
    );
    if (!r.ok && r.reason !== "no_binding") logError(ctx.requestId, "comment.mention", r.reason);
  }
  return successResponse({ comment: toPublicComment(c), mentioned: targets.length }, ctx.requestId, 201);
}

/** PATCH …/files/{fil}/comments/{cmt} { body } (author) | { resolved } (author, editors, managers) */
export async function handleUpdateComment(ctx: Ctx, request: Request, orgId: string, libraryId: string, fileId: string, commentId: string): Promise<Response> {
  const b = await readJson(request);
  if (!b || (b.body === undefined && b.resolved === undefined)) return validationError(ctx.requestId, { body: ["Give body or resolved"] });
  if (b.body !== undefined && !validBody(b.body)) return validationError(ctx.requestId, { body: [`Must be 1 to ${MAX_BODY} characters`] });
  if (b.resolved !== undefined && typeof b.resolved !== "boolean") return validationError(ctx.requestId, { resolved: ["Must be a boolean"] });
  const l = await readable(ctx, orgId, libraryId, fileId);
  if (!l.ok) return l.response;
  const c = await l.idx.call<CommentRow | null>({ op: "getComment", id: commentId });
  if (!c || c.file_id !== fileId) return nf(ctx);
  const mine = c.author === actorUuid(ctx.actor.subjectId);
  const moderator = await authorizeOnLibrary(ctx.env, ctx.actor, "file.update", l.a.lib, l.a.facts, ctx.requestId);
  const now = ctx.now().toISOString();
  let out = c;
  if (b.body !== undefined) {
    if (!mine) return nf(ctx); // only the author edits words
    out = await l.idx.call<CommentRow>({ op: "editComment", id: commentId, fileId, body: (b.body as string).trim(), nowIso: now });
  }
  if (b.resolved !== undefined) {
    if (!mine && !moderator) return nf(ctx);
    out = await l.idx.call<CommentRow>({ op: "resolveComment", id: commentId, fileId, resolved: b.resolved as boolean, by: actorUuid(ctx.actor.subjectId), nowIso: now });
  }
  return successResponse({ comment: toPublicComment(out) }, ctx.requestId);
}

/** DELETE …/files/{fil}/comments/{cmt} (author, editors, managers) */
export async function handleDeleteComment(ctx: Ctx, orgId: string, libraryId: string, fileId: string, commentId: string): Promise<Response> {
  const l = await readable(ctx, orgId, libraryId, fileId);
  if (!l.ok) return l.response;
  const c = await l.idx.call<CommentRow | null>({ op: "getComment", id: commentId });
  if (!c || c.file_id !== fileId) return nf(ctx);
  const mine = c.author === actorUuid(ctx.actor.subjectId);
  if (!mine && !(await authorizeOnLibrary(ctx.env, ctx.actor, "file.update", l.a.lib, l.a.facts, ctx.requestId))) return nf(ctx);
  await l.idx.call({ op: "deleteComment", id: commentId, fileId });
  return successResponse({ deleted: true }, ctx.requestId);
}
