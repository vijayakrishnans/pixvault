// media-worker: Pixvault libraries, library roles and guests (PV1). Reached only through api-edge, which resolves
// the caller and forwards x-actor-* headers. Every decision is policy-worker's (see ./access.ts); a denied or
// cross-org read is 404, never 403.

import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import { createMediaRepository } from "@saas/db/media";
import type { Ctx } from "./ctx.js";
import type { Env } from "./env.js";
import { handleHealth } from "./handlers/health.js";
import {
  handleArchiveLibrary,
  handleCreateLibrary,
  handleGetLibrary,
  handleListLibraries,
  handleUpdateLibrary,
} from "./handlers/libraries.js";
import {
  handleAcceptInvitations,
  handleCreateInvitation,
  handleListGuestLibraries,
  handleListMembers,
  handlePutMember,
  handleRemoveMember,
  handleRevokeInvitation,
} from "./handlers/members.js";
import { handleAbortUpload, handleCommitUpload, handleCreateUpload, handleGetUpload, handlePutPart } from "./handlers/uploads.js";
import {
  handleDeleteFile,
  handleFileContent,
  handleGetFile,
  handleListFiles,
  handleListVersions,
  handleMediaUsage,
  handleRestoreFile,
  handleRestoreVersion,
  handleSignedUrl,
  handleUpdateFile,
  handleReviewFile,
} from "./handlers/files.js";
import { handleListPipelineFailures, handleReprocess } from "./handlers/pipeline.js";
import { handleCreateShareLink, handleListShareLinks, handleRevokeShareLink, handleShareContent, handleShareOpen } from "./handlers/shares.js";
import { handleLiveTicket, handleBatch, handleCreateFolder, handleListFolders, handleListTags, handleMoveFolder, handleTrashFolder } from "./handlers/browse.js";
import {
  handleAbuseIntake,
  handleAdminFile,
  handleAdminPipelineFailures,
  handleDecideCase,
  handleListAbuseCases,
  handleSuspendOrg,
  parseCaseId,
} from "./handlers/abuse.js";
import { errorResponse, methodNotAllowed, notFound } from "./http.js";
import { indexStub } from "./index-do/client.js";
import { logError, routeTemplate } from "./log.js";
import {
  generateRequestId,
  isPrincipalId,
  parseFilePublicId,
  parseInvitationPublicId,
  parseLibraryPublicId,
  parseOrgPublicId,
  parseSessionPublicId,
  parseShareLinkPublicId,
} from "./ids.js";

export interface ActorContext {
  subjectId: string;
  subjectType: string;
  email: string;
}

const REQUEST_ID_RE = /^[\w-]{1,128}$/;

const LIBRARIES_RE = /^\/v1\/organizations\/([^/]+)\/libraries$/;
const LIBRARY_RE = /^\/v1\/organizations\/([^/]+)\/libraries\/([^/]+)$/;
const MEMBERS_RE = /^\/v1\/organizations\/([^/]+)\/libraries\/([^/]+)\/members$/;
const MEMBER_RE = /^\/v1\/organizations\/([^/]+)\/libraries\/([^/]+)\/members\/([^/]+)$/;
const INVITATIONS_RE = /^\/v1\/organizations\/([^/]+)\/libraries\/([^/]+)\/invitations$/;
const INVITATION_RE = /^\/v1\/organizations\/([^/]+)\/libraries\/([^/]+)\/invitations\/([^/]+)$/;
const LIB = "^\\/v1\\/organizations\\/([^/]+)\\/libraries\\/([^/]+)";
const UPLOADS_RE = new RegExp(`${LIB}\\/uploads$`);
const UPLOAD_RE = new RegExp(`${LIB}\\/uploads\\/([^/]+)$`);
const UPLOAD_PART_RE = new RegExp(`${LIB}\\/uploads\\/([^/]+)\\/parts\\/(\\d{1,5})$`);
const UPLOAD_COMMIT_RE = new RegExp(`${LIB}\\/uploads\\/([^/]+)\\/commit$`);
const FILES_RE = new RegExp(`${LIB}\\/files$`);
const FILES_BATCH_RE = new RegExp(`${LIB}\\/files:batch$`);
const FOLDERS_RE = new RegExp(`${LIB}\\/folders$`);
const FOLDERS_MOVE_RE = new RegExp(`${LIB}\\/folders\\/move$`);
const FOLDERS_TRASH_RE = new RegExp(`${LIB}\\/folders\\/trash$`);
const TAGS_RE = new RegExp(`${LIB}\\/tags$`);
const LIVE_TICKETS_RE = new RegExp(`${LIB}\\/live-tickets$`);
const SHARE_LINKS_RE = new RegExp(`${LIB}\\/share-links$`);
const SHARE_LINK_RE = new RegExp(`${LIB}\\/share-links\\/([^/]+)$`);
// Guests' share pages, from serve-worker over the service binding (api-edge doesn't forward these).
const SHARE_OPEN = "/v1/media/shares/open";
const SHARE_CONTENT = "/v1/media/shares/content";
const LIVE_RE = new RegExp(`${LIB}\\/live$`);
const FILE_RE = new RegExp(`${LIB}\\/files\\/([^/]+)$`);
const FILE_CONTENT_RE = new RegExp(`${LIB}\\/files\\/([^/]+)\\/content$`);
const FILE_RESTORE_RE = new RegExp(`${LIB}\\/files\\/([^/]+)\\/restore$`);
const FILE_SIGNED_URL_RE = new RegExp(`${LIB}\\/files\\/([^/]+)\\/signed-url$`);
const FILE_REPROCESS_RE = new RegExp(`${LIB}\\/files\\/([^/]+)\\/reprocess$`);
const FILE_REVIEW_RE = new RegExp(`${LIB}\\/files\\/([^/]+)\\/review$`);
const PIPELINE_FAILURES_RE = new RegExp(`${LIB}\\/pipeline-failures$`);
const FILE_VERSIONS_RE = new RegExp(`${LIB}\\/files\\/([^/]+)\\/versions$`);
const FILE_VERSION_RESTORE_RE = new RegExp(`${LIB}\\/files\\/([^/]+)\\/versions\\/(\\d{1,6})\\/restore$`);
const MEDIA_USAGE_RE = /^\/v1\/organizations\/([^/]+)\/media-usage$/;
const GUEST_LIBRARIES = "/v1/media/libraries";
const ACCEPT_INVITATIONS = "/v1/media/invitations/accept";
const ABUSE_INTAKE = "/v1/media/abuse-reports";
const ADMIN_CASES = "/v1/media/admin/abuse-cases";
const ADMIN_CASE_RE = /^\/v1\/media\/admin\/abuse-cases\/([^/]+)\/(takedown|dismiss)$/;
const ADMIN_FILE_RE = /^\/v1\/media\/admin\/organizations\/([^/]+)\/libraries\/([^/]+)\/files\/([^/]+)\/(takedown|reinstate)$/;
const ADMIN_ORG_RE = /^\/v1\/media\/admin\/organizations\/([^/]+)\/(suspend|unsuspend)$/;
const ADMIN_FAILURES = "/v1/media/admin/pipeline-failures";

/** Every route media-worker serves, for the edge's matcher and the tests. */
export const MEDIA_ROUTE_PATTERNS = [
  LIBRARIES_RE,
  LIBRARY_RE,
  MEMBERS_RE,
  MEMBER_RE,
  INVITATIONS_RE,
  INVITATION_RE,
] as const;

function resolveRequestId(request: Request): string {
  const header = request.headers.get("x-request-id");
  return header && REQUEST_ID_RE.test(header) ? header : generateRequestId();
}

function resolveActor(request: Request): ActorContext | null {
  const subjectId = request.headers.get("x-actor-subject-id");
  const subjectType = request.headers.get("x-actor-subject-type");
  if (!subjectId || !subjectType) return null;
  return { subjectId, subjectType, email: request.headers.get("x-actor-email") ?? "" };
}

export interface RouteDeps {
  /** Override the clock (tests). */
  now?: () => Date;
}

export async function route(request: Request, env: Env, deps?: RouteDeps): Promise<Response> {
  const url = new URL(request.url);
  const requestId = resolveRequestId(request);
  const path = url.pathname;
  const method = request.method;

  if (path === "/health" && method === "GET") return handleHealth(env, requestId);

  // Abuse reports come from serve-worker's report form, without an actor (media-worker has no public route,
  // and api-edge doesn't forward this path).
  if (path === ABUSE_INTAKE) {
    return method === "POST" ? await handleAbuseIntake(env, request, requestId, (deps?.now ?? (() => new Date()))()) : methodNotAllowed(requestId);
  }

  if (path === SHARE_OPEN || path === SHARE_CONTENT) {
    if (method !== "POST") return methodNotAllowed(requestId);
    const now = (deps?.now ?? (() => new Date()))();
    try {
      return path === SHARE_OPEN ? await handleShareOpen(env, request, requestId, now) : await handleShareContent(env, request, requestId, now);
    } catch (e) {
      logError(requestId, `POST ${path}`, e);
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }
  }

  // The live socket presents a one-use ticket instead of an actor (browsers can't set headers on a WebSocket); the
  // library's index checks it. The edge forwards the upgrade untouched.
  const live = path.match(LIVE_RE);
  if (live) {
    if (method !== "GET") return methodNotAllowed(requestId);
    const orgId = parseOrgPublicId(live[1]!);
    const libId = parseLibraryPublicId(live[2]!);
    if (!orgId || !libId || !env.LIBRARY_INDEX) return errorResponse("not_found", "Not found", 404, requestId);
    return indexStub(env, { orgId, libraryId: libId }).fetch(request);
  }

  if (!env.PLATFORM_DB || !env.MEMBERSHIP_WORKER || !env.POLICY_WORKER || !env.PROJECTS_WORKER) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
  const actor = resolveActor(request);
  if (!actor) return errorResponse("unauthenticated", "Authentication required", 401, requestId);

  const executor = createSqlExecutor(env.PLATFORM_DB);
  const ctx: Ctx = {
    env,
    repo: createMediaRepository(executor),
    events: createEventsRepository(executor),
    actor,
    requestId,
    now: deps?.now ?? (() => new Date()),
  };

  const nf = () => errorResponse("not_found", "Not found", 404, requestId);
  try {
    if (path === GUEST_LIBRARIES) {
      return method === "GET" ? await handleListGuestLibraries(ctx) : methodNotAllowed(requestId);
    }
    if (path === ACCEPT_INVITATIONS) {
      return method === "POST" ? await handleAcceptInvitations(ctx) : methodNotAllowed(requestId);
    }

    let m: RegExpMatchArray | null;

    // Platform operators only (anyone else: 404).
    if (path === ADMIN_CASES) return method === "GET" ? await handleListAbuseCases(ctx, url) : methodNotAllowed(requestId);
    if (path === ADMIN_FAILURES) return method === "GET" ? await handleAdminPipelineFailures(ctx, url) : methodNotAllowed(requestId);
    if ((m = path.match(ADMIN_CASE_RE))) {
      const caseId = parseCaseId(m[1]!);
      if (!caseId) return nf();
      return method === "POST" ? await handleDecideCase(ctx, request, caseId, m[2] as "takedown" | "dismiss") : methodNotAllowed(requestId);
    }
    if ((m = path.match(ADMIN_FILE_RE))) {
      const orgId = parseOrgPublicId(m[1]!);
      const libId = parseLibraryPublicId(m[2]!);
      const fid = parseFilePublicId(m[3]!);
      if (!orgId || !libId || !fid) return nf();
      return method === "POST" ? await handleAdminFile(ctx, request, orgId, libId, fid, m[4] as "takedown" | "reinstate") : methodNotAllowed(requestId);
    }
    if ((m = path.match(ADMIN_ORG_RE))) {
      const orgId = parseOrgPublicId(m[1]!);
      if (!orgId) return nf();
      return method === "POST" ? await handleSuspendOrg(ctx, request, orgId, m[2] === "suspend") : methodNotAllowed(requestId);
    }

    if ((m = path.match(MEDIA_USAGE_RE))) {
      const orgId = parseOrgPublicId(m[1]!);
      if (!orgId) return nf();
      return method === "GET" ? await handleMediaUsage(ctx, orgId) : methodNotAllowed(requestId);
    }

    // Files and uploads need the bucket and the index.
    const fileRoute = [SHARE_LINKS_RE, SHARE_LINK_RE, LIVE_TICKETS_RE, FILES_BATCH_RE, FOLDERS_RE, FOLDERS_MOVE_RE, FOLDERS_TRASH_RE, TAGS_RE, UPLOADS_RE, UPLOAD_RE, UPLOAD_PART_RE, UPLOAD_COMMIT_RE, FILES_RE, FILE_RE, FILE_CONTENT_RE, FILE_RESTORE_RE, FILE_SIGNED_URL_RE, FILE_REPROCESS_RE, FILE_REVIEW_RE, FILE_VERSIONS_RE, FILE_VERSION_RESTORE_RE].some((re) => re.test(path));
    if (fileRoute) {
      if (!env.MEDIA_BUCKET || !env.LIBRARY_INDEX) return errorResponse("internal_error", "Service unavailable", 503, requestId);
      const lm = path.match(new RegExp(LIB))!;
      const orgId = parseOrgPublicId(lm[1]!);
      const libId = parseLibraryPublicId(lm[2]!);
      if (!orgId || !libId) return nf();
      if ((m = path.match(UPLOADS_RE))) return method === "POST" ? await handleCreateUpload(ctx, request, orgId, libId) : methodNotAllowed(requestId);
      if ((m = path.match(UPLOAD_PART_RE))) {
        const ups = parseSessionPublicId(m[3]!);
        if (!ups) return nf();
        return method === "PUT" ? await handlePutPart(ctx, request, orgId, libId, ups, Number(m[4])) : methodNotAllowed(requestId);
      }
      if ((m = path.match(UPLOAD_COMMIT_RE))) {
        const ups = parseSessionPublicId(m[3]!);
        if (!ups) return nf();
        return method === "POST" ? await handleCommitUpload(ctx, orgId, libId, ups) : methodNotAllowed(requestId);
      }
      if ((m = path.match(UPLOAD_RE))) {
        const ups = parseSessionPublicId(m[3]!);
        if (!ups) return nf();
        if (method === "GET") return await handleGetUpload(ctx, orgId, libId, ups);
        if (method === "DELETE") return await handleAbortUpload(ctx, orgId, libId, ups);
        return methodNotAllowed(requestId);
      }
      if ((m = path.match(FILES_RE))) return method === "GET" ? await handleListFiles(ctx, url, orgId, libId) : methodNotAllowed(requestId);
      if ((m = path.match(FILES_BATCH_RE))) return method === "POST" ? await handleBatch(ctx, request, orgId, libId) : methodNotAllowed(requestId);
      if ((m = path.match(FOLDERS_RE))) {
        if (method === "GET") return await handleListFolders(ctx, orgId, libId);
        if (method === "POST") return await handleCreateFolder(ctx, request, orgId, libId);
        return methodNotAllowed(requestId);
      }
      if ((m = path.match(FOLDERS_MOVE_RE))) return method === "POST" ? await handleMoveFolder(ctx, request, orgId, libId) : methodNotAllowed(requestId);
      if ((m = path.match(FOLDERS_TRASH_RE))) return method === "POST" ? await handleTrashFolder(ctx, request, orgId, libId) : methodNotAllowed(requestId);
      if ((m = path.match(SHARE_LINKS_RE))) {
        if (method === "GET") return await handleListShareLinks(ctx, url, orgId, libId);
        if (method === "POST") return await handleCreateShareLink(ctx, request, orgId, libId);
        return methodNotAllowed(requestId);
      }
      if ((m = path.match(SHARE_LINK_RE))) {
        const shl = parseShareLinkPublicId(m[3]!);
        if (!shl) return nf();
        return method === "DELETE" ? await handleRevokeShareLink(ctx, orgId, libId, shl) : methodNotAllowed(requestId);
      }
      if ((m = path.match(LIVE_TICKETS_RE))) return method === "POST" ? await handleLiveTicket(ctx, orgId, libId, lm[1]!, lm[2]!) : methodNotAllowed(requestId);
      if ((m = path.match(TAGS_RE))) return method === "GET" ? await handleListTags(ctx, orgId, libId) : methodNotAllowed(requestId);
      const fid = (() => {
        const fm = path.match(new RegExp(`${LIB}\\/files\\/([^/]+)`));
        return fm ? parseFilePublicId(fm[3]!) : null;
      })();
      if (!fid) return nf();
      if ((m = path.match(FILE_CONTENT_RE))) return method === "GET" ? await handleFileContent(ctx, orgId, libId, fid) : methodNotAllowed(requestId);
      if ((m = path.match(FILE_RESTORE_RE))) return method === "POST" ? await handleRestoreFile(ctx, orgId, libId, fid) : methodNotAllowed(requestId);
      if ((m = path.match(FILE_SIGNED_URL_RE))) return method === "POST" ? await handleSignedUrl(ctx, request, orgId, libId, fid) : methodNotAllowed(requestId);
      if ((m = path.match(FILE_REPROCESS_RE))) return method === "POST" ? await handleReprocess(ctx, orgId, libId, fid) : methodNotAllowed(requestId);
      if ((m = path.match(FILE_REVIEW_RE))) return method === "POST" ? await handleReviewFile(ctx, request, orgId, libId, fid) : methodNotAllowed(requestId);
      if ((m = path.match(FILE_VERSIONS_RE))) return method === "GET" ? await handleListVersions(ctx, orgId, libId, fid) : methodNotAllowed(requestId);
      if ((m = path.match(FILE_VERSION_RESTORE_RE))) {
        return method === "POST" ? await handleRestoreVersion(ctx, orgId, libId, fid, Number(m[4])) : methodNotAllowed(requestId);
      }
      if ((m = path.match(FILE_RE))) {
        if (method === "GET") return await handleGetFile(ctx, orgId, libId, fid);
        if (method === "DELETE") return await handleDeleteFile(ctx, url, orgId, libId, fid);
        if (method === "PATCH") return await handleUpdateFile(ctx, request, orgId, libId, fid);
        return methodNotAllowed(requestId);
      }
      return nf();
    }

    if ((m = path.match(PIPELINE_FAILURES_RE))) {
      const orgId = parseOrgPublicId(m[1]!);
      const libId = parseLibraryPublicId(m[2]!);
      if (!orgId || !libId) return nf();
      return method === "GET" ? await handleListPipelineFailures(ctx, orgId, libId) : methodNotAllowed(requestId);
    }
    if ((m = path.match(LIBRARIES_RE))) {
      const orgId = parseOrgPublicId(m[1]!);
      if (!orgId) return nf();
      if (method === "GET") return await handleListLibraries(ctx, orgId);
      if (method === "POST") return await handleCreateLibrary(ctx, request, orgId);
      return methodNotAllowed(requestId);
    }
    if ((m = path.match(LIBRARY_RE))) {
      const orgId = parseOrgPublicId(m[1]!);
      const libId = parseLibraryPublicId(m[2]!);
      if (!orgId || !libId) return nf();
      if (method === "GET") return await handleGetLibrary(ctx, orgId, libId);
      if (method === "PATCH") return await handleUpdateLibrary(ctx, request, orgId, libId);
      if (method === "DELETE") return await handleArchiveLibrary(ctx, orgId, libId);
      return methodNotAllowed(requestId);
    }
    if ((m = path.match(MEMBERS_RE))) {
      const orgId = parseOrgPublicId(m[1]!);
      const libId = parseLibraryPublicId(m[2]!);
      if (!orgId || !libId) return nf();
      return method === "GET" ? await handleListMembers(ctx, orgId, libId) : methodNotAllowed(requestId);
    }
    if ((m = path.match(MEMBER_RE))) {
      const orgId = parseOrgPublicId(m[1]!);
      const libId = parseLibraryPublicId(m[2]!);
      const principalId = decodeURIComponent(m[3]!);
      if (!orgId || !libId || !isPrincipalId(principalId)) return nf();
      if (method === "PUT") return await handlePutMember(ctx, request, orgId, libId, principalId);
      if (method === "DELETE") return await handleRemoveMember(ctx, orgId, libId, principalId);
      return methodNotAllowed(requestId);
    }
    if ((m = path.match(INVITATIONS_RE))) {
      const orgId = parseOrgPublicId(m[1]!);
      const libId = parseLibraryPublicId(m[2]!);
      if (!orgId || !libId) return nf();
      return method === "POST" ? await handleCreateInvitation(ctx, request, orgId, libId) : methodNotAllowed(requestId);
    }
    if ((m = path.match(INVITATION_RE))) {
      const orgId = parseOrgPublicId(m[1]!);
      const libId = parseLibraryPublicId(m[2]!);
      const invId = parseInvitationPublicId(m[3]!);
      if (!orgId || !libId || !invId) return nf();
      return method === "DELETE" ? await handleRevokeInvitation(ctx, orgId, libId, invId) : methodNotAllowed(requestId);
    }
    return notFound(requestId, path);
  } catch (e) {
    logError(requestId, `${method} ${routeTemplate(path)}`, e);
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}
