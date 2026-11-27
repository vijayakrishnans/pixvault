// The pipeline's entry points in the API: deciding whether an upload must be processed before it is served,
// starting runs, replaying a held file, and the library's list of failed runs.

import type { Ctx } from "../ctx.js";
import type { FileRow } from "../index-do/core.js";
import { IndexCallError } from "../index-do/client.js";
import { needsPipeline, startPipeline } from "../pipeline/start.js";
import { errorResponse, successResponse } from "../http.js";
import { authorizeOnLibrary } from "../access.js";
import { filePublicId } from "../ids.js";
import { loadAuthorized } from "./libraries.js";
import { loadFile, toPublicFile } from "./files.js";

/** Does an upload of `mime` with `visibility` go through the pipeline, and must it pass the safety check? */
export async function pipelineFor(ctx: Ctx, orgId: string, mime: string, visibility: "public" | "private"): Promise<{ processing: boolean; requireSafety: boolean }> {
  // Only public files can need the safety check, so only they cost a plan lookup.
  let free = false;
  if (visibility === "public") {
    const r = await ctx.repo.orgIsOnFreePlan(orgId);
    free = r.ok ? r.value : true; // can't tell: treat as free (the safer side)
  }
  return { processing: needsPipeline(mime, visibility, free), requireSafety: visibility === "public" && free };
}

/** Start the run for a file the index just put in `processing`. */
export async function kickPipeline(ctx: Ctx, orgId: string, libraryId: string, f: FileRow, requireSafety: boolean, attempt = "a"): Promise<void> {
  if (f.status !== "processing") return;
  // If this fails the index's sweep starts it later; the file isn't served meanwhile.
  await startPipeline(ctx.env, { orgId, libraryId, fileId: f.id, sha256: f.blob_sha256, requireSafety }, attempt);
}

/** POST …/files/{fil}/reprocess: run a held file through the pipeline again (editors and managers). */
export async function handleReprocess(ctx: Ctx, orgId: string, libraryId: string, fileId: string): Promise<Response> {
  const l = await loadFile(ctx, orgId, libraryId, fileId);
  if (!l.ok) return l.response;
  if (!(await authorizeOnLibrary(ctx.env, ctx.actor, "file.update", l.a.lib, l.a.facts, ctx.requestId))) {
    return errorResponse("not_found", "Not found", 404, ctx.requestId);
  }
  try {
    const f = await l.idx.call<FileRow>({ op: "reprocess", id: fileId, nowIso: ctx.now().toISOString() });
    const { requireSafety } = await pipelineFor(ctx, orgId, f.mime, f.visibility);
    await kickPipeline(ctx, orgId, libraryId, f, requireSafety, `r${ctx.now().getTime().toString(36)}`);
    await ctx.repo.settlePipelineFailures(orgId, libraryId, fileId, "replayed", ctx.now());
    return successResponse({ file: toPublicFile(f, l.a.lib, ctx.env) }, ctx.requestId);
  } catch (e) {
    if (e instanceof IndexCallError && e.code === "not_found") return errorResponse("not_found", "Not found", 404, ctx.requestId);
    if (e instanceof IndexCallError && e.code === "invalid_state") return errorResponse("conflict", e.message, 409, ctx.requestId);
    throw e;
  }
}

/** GET …/libraries/{lib}/pipeline-failures: failed runs in this library (editors and managers). */
export async function handleListPipelineFailures(ctx: Ctx, orgId: string, libraryId: string): Promise<Response> {
  const a = await loadAuthorized(ctx, orgId, libraryId, "file.update");
  if (!a.ok) return a.response;
  const r = await ctx.repo.listPipelineFailures({ orgId, libraryId, status: "open", limit: 100 });
  if (!r.ok) return errorResponse("internal_error", "Service unavailable", 503, ctx.requestId);
  return successResponse(
    { failures: r.value.map((f) => ({ fileId: filePublicId(f.fileId), step: f.step, error: f.errorName, createdAt: f.createdAt })) },
    ctx.requestId,
  );
}
