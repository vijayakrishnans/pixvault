// Abuse reports, takedown and org suspension (design §4.9).
//
// Reports arrive from serve-worker's report form (service binding, no actor): one open case per file, repeats raise
// its count. Everything else is for platform operators only (platform_media_operators, filled by hand); anyone else
// gets 404, as for every denied request. Taken-down files answer 451 from serve-worker; a suspended org's libraries
// answer 451 and it can't upload.

import { ABUSE_CATEGORIES, type AbuseCase, type AbuseCategory } from "@saas/db/media";
import { audit, type Ctx } from "../ctx.js";
import type { Env } from "../env.js";
import { errorResponse, successResponse, validationError } from "../http.js";
import { filePublicId, libraryPublicId, orgPublicId } from "../ids.js";
import { indexFor, IndexCallError } from "../index-do/client.js";
import type { FileRow } from "../index-do/core.js";
import { createSqlExecutor } from "@saas/db/d1";
import { createMediaRepository } from "@saas/db/media";
import { publishLibraryMap, signedFileUrl } from "../serving.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const EMAIL_RE = /^[^\s@<>]{1,64}@[^\s@<>]{1,190}\.[a-z]{2,24}$/i;

const clean = (s: string, max: number) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max);

/** POST /v1/media/abuse-reports (from serve-worker only; media-worker has no public route). */
export async function handleAbuseIntake(env: Env, request: Request, requestId: string, now: Date): Promise<Response> {
  let b: Record<string, unknown>;
  try {
    b = (await request.json()) as Record<string, unknown>;
  } catch {
    return validationError(requestId, { body: ["Invalid JSON"] });
  }
  const fields: Record<string, string[]> = {};
  for (const k of ["orgId", "libraryId", "fileId"]) if (typeof b[k] !== "string" || !UUID_RE.test(b[k] as string)) fields[k] = ["Invalid id"];
  if (typeof b.sha256 !== "string" || !SHA_RE.test(b.sha256)) fields.sha256 = ["Invalid hash"];
  if (typeof b.category !== "string" || !(ABUSE_CATEGORIES as readonly string[]).includes(b.category)) fields.category = ["Unknown category"];
  if (b.details !== undefined && b.details !== null && typeof b.details !== "string") fields.details = ["Must be text"];
  if (b.email !== undefined && b.email !== null && b.email !== "" && (typeof b.email !== "string" || !EMAIL_RE.test(b.email))) fields.email = ["Invalid email"];
  if (Object.keys(fields).length) return validationError(requestId, fields);
  if (!env.PLATFORM_DB || !env.LIBRARY_INDEX) return errorResponse("internal_error", "Service unavailable", 503, requestId);

  const orgId = b.orgId as string;
  const libraryId = b.libraryId as string;
  const fileId = b.fileId as string;
  // The file must exist in that library with those bytes: a report can't name a file it never saw.
  const f = await indexFor(env, { orgId, libraryId }).call<FileRow | null>({ op: "getFile", id: fileId });
  if (!f || f.blob_sha256 !== b.sha256) return errorResponse("not_found", "Not found", 404, requestId);

  const repo = createMediaRepository(createSqlExecutor(env.PLATFORM_DB));
  const details = typeof b.details === "string" ? clean(b.details, 2000) || null : null;
  const email = typeof b.email === "string" && b.email ? b.email.trim().toLowerCase() : null;
  const r = await repo.reportAbuse({ orgId, libraryId, fileId, sha256: f.blob_sha256, category: b.category as AbuseCategory, details, reporterEmail: email, at: now });
  if (!r.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
  console.warn(JSON.stringify({ level: "warn", msg: "abuse_report", requestId, category: b.category, newCase: r.value.created }));
  return successResponse({ received: true }, requestId, 202);
}

async function requireOperator(ctx: Ctx): Promise<Response | null> {
  const r = await ctx.repo.isPlatformOperator(ctx.actor.subjectId);
  if (!r.ok) return errorResponse("internal_error", "Service unavailable", 503, ctx.requestId);
  return r.value ? null : errorResponse("not_found", "Not found", 404, ctx.requestId);
}

const CATEGORY_ORDER: Record<string, number> = { csam: 0, violence: 1, sexual: 2, hate: 3, harassment: 4, malware: 5, copyright: 6, spam: 7, other: 8 };

async function publicCase(ctx: Ctx, c: AbuseCase) {
  const lib = await ctx.repo.getLibrary(c.orgId, c.libraryId);
  let file: FileRow | null = null;
  try {
    file = await indexFor(ctx.env, { orgId: c.orgId, libraryId: c.libraryId }).call<FileRow | null>({ op: "getFile", id: c.fileId });
  } catch {
    file = null;
  }
  // A 10-minute signed link lets the operator see what was reported (it won't work once the file is taken down).
  const view = lib.ok && file && file.status !== "trashed" ? await signedFileUrl(ctx.env, lib.value, file.path, 600, ctx.now()) : null;
  return {
    id: `abc_${c.id.replace(/-/g, "")}`,
    orgId: orgPublicId(c.orgId),
    libraryId: libraryPublicId(c.libraryId),
    fileId: filePublicId(c.fileId),
    category: c.category,
    details: c.details,
    reporterEmail: c.reporterEmail,
    reportCount: c.reportCount,
    status: c.status,
    fileStatus: file?.status ?? null,
    fileName: file?.name ?? null,
    viewUrl: view?.url ?? null,
    decisionNote: c.decisionNote,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

export function parseCaseId(pub: string): string | null {
  const m = /^abc_([0-9a-f]{32})$/.exec(pub);
  if (!m) return null;
  const h = m[1]!;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** GET /v1/media/admin/abuse-cases?status=open|actioned|dismissed */
export async function handleListAbuseCases(ctx: Ctx, url: URL): Promise<Response> {
  const denied = await requireOperator(ctx);
  if (denied) return denied;
  const status = url.searchParams.get("status") ?? "open";
  if (!["open", "actioned", "dismissed"].includes(status)) return validationError(ctx.requestId, { status: ["Unknown status"] });
  const r = await ctx.repo.listAbuseCases({ status: status as AbuseCase["status"], limit: 100 });
  if (!r.ok) return errorResponse("internal_error", "Service unavailable", 503, ctx.requestId);
  const cases = [...r.value].sort((a, b) => (CATEGORY_ORDER[a.category] ?? 9) - (CATEGORY_ORDER[b.category] ?? 9) || b.createdAt.localeCompare(a.createdAt));
  return successResponse({ cases: await Promise.all(cases.map((c) => publicCase(ctx, c))) }, ctx.requestId);
}

async function readNote(request: Request): Promise<string | null> {
  try {
    const b = (await request.json()) as { note?: unknown; reason?: unknown };
    const n = typeof b.note === "string" ? b.note : typeof b.reason === "string" ? b.reason : null;
    return n ? clean(n, 500) || null : null;
  } catch {
    return null;
  }
}

/** Take one file down. Shared by the case action and the direct admin route. */
async function takeDown(ctx: Ctx, orgId: string, libraryId: string, fileId: string, note: string): Promise<FileRow | null> {
  try {
    const f = await indexFor(ctx.env, { orgId, libraryId }).call<FileRow>({ op: "takedown", id: fileId, note, nowIso: ctx.now().toISOString() });
    const lib = await ctx.repo.getLibrary(orgId, libraryId);
    if (lib.ok) await audit(ctx, lib.value, "file.taken_down", `Took down a file in "${lib.value.name}"`, { fileId: filePublicId(fileId), note });
    return f;
  } catch (e) {
    if (e instanceof IndexCallError && e.code === "not_found") return null;
    throw e;
  }
}

/** POST /v1/media/admin/abuse-cases/{abc}/(takedown|dismiss) { note? } */
export async function handleDecideCase(ctx: Ctx, request: Request, caseId: string, decision: "takedown" | "dismiss"): Promise<Response> {
  const denied = await requireOperator(ctx);
  if (denied) return denied;
  const c = await ctx.repo.getAbuseCase(caseId);
  if (!c.ok) return errorResponse("not_found", "Not found", 404, ctx.requestId);
  if (c.value.status !== "open") return errorResponse("conflict", "This case is already decided", 409, ctx.requestId);
  const note = await readNote(request);
  if (decision === "takedown") {
    const f = await takeDown(ctx, c.value.orgId, c.value.libraryId, c.value.fileId, `takedown:${caseId.slice(0, 8)}`);
    if (!f) return errorResponse("not_found", "The reported file no longer exists", 404, ctx.requestId);
  }
  const d = await ctx.repo.decideAbuseCase(caseId, decision === "takedown" ? "actioned" : "dismissed", ctx.actor.subjectId, note, ctx.now());
  if (!d.ok) return errorResponse("internal_error", "Service unavailable", 503, ctx.requestId);
  return successResponse({ case: await publicCase(ctx, d.value) }, ctx.requestId);
}

/** POST /v1/media/admin/organizations/{org}/libraries/{lib}/files/{fil}/(takedown|reinstate) { note? } */
export async function handleAdminFile(ctx: Ctx, request: Request, orgId: string, libraryId: string, fileId: string, action: "takedown" | "reinstate"): Promise<Response> {
  const denied = await requireOperator(ctx);
  if (denied) return denied;
  const note = await readNote(request);
  if (action === "takedown") {
    const f = await takeDown(ctx, orgId, libraryId, fileId, "takedown:direct");
    if (!f) return errorResponse("not_found", "Not found", 404, ctx.requestId);
    return successResponse({ fileId: filePublicId(fileId), status: f.status }, ctx.requestId);
  }
  try {
    const f = await indexFor(ctx.env, { orgId, libraryId }).call<FileRow>({ op: "reinstate", id: fileId, nowIso: ctx.now().toISOString() });
    const lib = await ctx.repo.getLibrary(orgId, libraryId);
    if (lib.ok) await audit(ctx, lib.value, "file.reinstated", `Reinstated a file in "${lib.value.name}"`, { fileId: filePublicId(fileId), note });
    return successResponse({ fileId: filePublicId(fileId), status: f.status }, ctx.requestId);
  } catch (e) {
    if (e instanceof IndexCallError && e.code === "invalid_state") return errorResponse("conflict", e.message, 409, ctx.requestId);
    throw e;
  }
}

/** POST /v1/media/admin/organizations/{org}/(suspend|unsuspend) { reason? } */
export async function handleSuspendOrg(ctx: Ctx, request: Request, orgId: string, suspend: boolean): Promise<Response> {
  const denied = await requireOperator(ctx);
  if (denied) return denied;
  const reason = await readNote(request);
  const r = await ctx.repo.setOrgSuspension(orgId, suspend, reason, ctx.actor.subjectId, ctx.now());
  if (!r.ok) return errorResponse("internal_error", "Service unavailable", 503, ctx.requestId);
  // Every library's serving map carries the flag, so serve-worker answers 451 within one map read.
  const libs = await ctx.repo.listLibraries(orgId);
  let republished = 0;
  if (libs.ok) {
    for (const lib of libs.value) {
      if (lib.status !== "active") continue;
      await publishLibraryMap(ctx.env, lib, suspend);
      await audit(ctx, lib, suspend ? "org.media_suspended" : "org.media_unsuspended", suspend ? "Suspended the team's media" : "Lifted the team's media suspension", { reason });
      republished++;
    }
  }
  return successResponse({ orgId: orgPublicId(orgId), suspended: suspend, libraries: republished }, ctx.requestId);
}

/** GET /v1/media/admin/pipeline-failures?status=open: failed runs across every org (operators). */
export async function handleAdminPipelineFailures(ctx: Ctx, url: URL): Promise<Response> {
  const denied = await requireOperator(ctx);
  if (denied) return denied;
  const status = (url.searchParams.get("status") ?? "open") as "open" | "replayed" | "resolved";
  if (!["open", "replayed", "resolved"].includes(status)) return validationError(ctx.requestId, { status: ["Unknown status"] });
  const r = await ctx.repo.listPipelineFailures({ status, limit: 200 });
  if (!r.ok) return errorResponse("internal_error", "Service unavailable", 503, ctx.requestId);
  return successResponse(
    {
      failures: r.value.map((f) => ({
        orgId: orgPublicId(f.orgId),
        libraryId: libraryPublicId(f.libraryId),
        fileId: filePublicId(f.fileId),
        step: f.step,
        error: f.errorName,
        createdAt: f.createdAt,
      })),
    },
    ctx.requestId,
  );
}
