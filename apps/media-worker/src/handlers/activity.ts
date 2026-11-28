// Activity (PV6): who did what to which file, newest first. The library's log needs file.list (uploader-only
// members get 404); one file's log follows the file's read access. Entries carry ids, names, folders and states,
// never contents, comment words, addresses or tokens; an operator's actions show as "operator".

import type { Ctx } from "../ctx.js";
import { successResponse, validationError } from "../http.js";
import { indexFor } from "../index-do/client.js";
import type { ActivityRow } from "../index-do/core.js";
import { filePublicId, parseFilePublicId } from "../ids.js";
import { loadAuthorized } from "./libraries.js";
import { canRead, loadFile } from "./files.js";
import { errorResponse } from "../http.js";

export interface PublicActivity {
  id: number;
  at: string;
  /** usr_… (a member), upl_… (an upload link), "pipeline", "operator" or "system". */
  actor: string;
  op: string;
  fileId: string | null;
  folder: string | null;
  detail: Record<string, unknown>;
}

function toPublic(r: ActivityRow): PublicActivity {
  let detail: Record<string, unknown> = {};
  try {
    detail = JSON.parse(r.detail) as Record<string, unknown>;
  } catch {
    /* empty */
  }
  return { id: r.seq, at: r.at, actor: r.actor, op: r.op, fileId: r.file_id ? filePublicId(r.file_id) : null, folder: r.folder, detail };
}

/** GET …/activity?file=fil_…&cursor=<id>&limit= */
export async function handleListActivity(ctx: Ctx, url: URL, orgId: string, libraryId: string): Promise<Response> {
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), 200);
  const cursorParam = url.searchParams.get("cursor");
  const before = cursorParam === null ? undefined : Number(cursorParam);
  if (before !== undefined && (!Number.isInteger(before) || before < 1)) return validationError(ctx.requestId, { cursor: ["Invalid cursor"] });
  const fileParam = url.searchParams.get("file");
  let fileId: string | undefined;
  if (fileParam !== null) {
    const id = parseFilePublicId(fileParam);
    if (!id) return validationError(ctx.requestId, { file: ["Must be a file id"] });
    const l = await loadFile(ctx, orgId, libraryId, id);
    if (!l.ok) return l.response;
    if (!(await canRead(ctx, l.a, l.file))) return errorResponse("not_found", "Not found", 404, ctx.requestId);
    fileId = id;
  } else {
    const a = await loadAuthorized(ctx, orgId, libraryId, "file.list");
    if (!a.ok) return a.response;
  }
  const r = await indexFor(ctx.env, { orgId, libraryId }).call<{ entries: ActivityRow[]; nextCursor: number | null }>({
    op: "listActivity",
    ...(fileId ? { fileId } : {}),
    ...(before ? { before } : {}),
    limit,
  });
  return successResponse({ activity: r.entries.map(toPublic), nextCursor: r.nextCursor === null ? null : String(r.nextCursor) }, ctx.requestId);
}
