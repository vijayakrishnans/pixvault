// Pixvault media facade: libraries, library members and guest invitations (PV1), forwarded to media-worker as
// the resolved actor. The same shape as project-facade: resolve the bearer, rate-limit and replay by
// Idempotency-Key, forward x-actor-* headers, stream the response back.

import type { Env } from "./env.js";
import { errorResponse, withEdgeTimings } from "./http.js";
import { replayOrExecute } from "./idempotency.js";
import { resolveActor } from "./resolve-actor.js";
import { createTimings } from "@saas/contracts/timing";

const ORG_LIBRARIES_RE = /^\/v1\/organizations\/[^/]+\/libraries$/;
const ORG_LIBRARY_RE = /^\/v1\/organizations\/[^/]+\/libraries\/[^/]+$/;
const ORG_LIBRARY_MEMBERS_RE = /^\/v1\/organizations\/[^/]+\/libraries\/[^/]+\/members$/;
const ORG_LIBRARY_MEMBER_RE = /^\/v1\/organizations\/[^/]+\/libraries\/[^/]+\/members\/[^/]+$/;
const ORG_LIBRARY_INVITATIONS_RE = /^\/v1\/organizations\/[^/]+\/libraries\/[^/]+\/invitations$/;
const ORG_LIBRARY_INVITATION_RE = /^\/v1\/organizations\/[^/]+\/libraries\/[^/]+\/invitations\/[^/]+$/;
const L = "^\\/v1\\/organizations\\/[^/]+\\/libraries\\/[^/]+";
const ORG_LIBRARY_UPLOADS_RE = new RegExp(`${L}\\/uploads$`);
const ORG_LIBRARY_UPLOAD_RE = new RegExp(`${L}\\/uploads\\/[^/]+$`);
const ORG_LIBRARY_UPLOAD_PART_RE = new RegExp(`${L}\\/uploads\\/[^/]+\\/parts\\/\\d{1,5}$`);
const ORG_LIBRARY_UPLOAD_COMMIT_RE = new RegExp(`${L}\\/uploads\\/[^/]+\\/commit$`);
const ORG_LIBRARY_FILES_RE = new RegExp(`${L}\\/files$`);
const ORG_LIBRARY_FILES_BATCH_RE = new RegExp(`${L}\\/files:batch$`);
const ORG_LIBRARY_FOLDERS_RE = new RegExp(`${L}\\/folders$`);
const ORG_LIBRARY_FOLDERS_ACTION_RE = new RegExp(`${L}\\/folders\\/(move|trash)$`);
const ORG_LIBRARY_TAGS_RE = new RegExp(`${L}\\/tags$`);
const ORG_LIBRARY_LIVE_TICKETS_RE = new RegExp(`${L}\\/live-tickets$`);
const ORG_LIBRARY_SHARE_LINKS_RE = new RegExp(`${L}\\/share-links$`);
const ORG_LIBRARY_UPLOAD_LINKS_RE = new RegExp(`${L}\\/upload-links$`);
const ORG_LIBRARY_UPLOAD_LINK_RE = new RegExp(`${L}\\/upload-links\\/[^/]+$`);
const ORG_LIBRARY_SHARE_LINK_RE = new RegExp(`${L}\\/share-links\\/[^/]+$`);
// The live socket: authenticated by a one-use ticket that media-worker's index checks, not by the bearer, and
// forwarded as is (an upgrade can't be replayed, rate-limited per key or re-wrapped).
const ORG_LIBRARY_LIVE_RE = new RegExp(`${L}\\/live$`);
const ORG_LIBRARY_FILE_RE = new RegExp(`${L}\\/files\\/[^/]+$`);
const ORG_LIBRARY_FILE_CONTENT_RE = new RegExp(`${L}\\/files\\/[^/]+\\/content$`);
const ORG_LIBRARY_FILE_RESTORE_RE = new RegExp(`${L}\\/files\\/[^/]+\\/restore$`);
const ORG_LIBRARY_FILE_SIGNED_URL_RE = new RegExp(`${L}\\/files\\/[^/]+\\/signed-url$`);
const ORG_LIBRARY_FILE_REPROCESS_RE = new RegExp(`${L}\\/files\\/[^/]+\\/reprocess$`);
const ORG_LIBRARY_FILE_REVIEW_RE = new RegExp(`${L}\\/files\\/[^/]+\\/review$`);
const ORG_LIBRARY_PIPELINE_FAILURES_RE = new RegExp(`${L}\\/pipeline-failures$`);
const ORG_LIBRARY_FILE_VERSIONS_RE = new RegExp(`${L}\\/files\\/[^/]+\\/versions$`);
const ORG_LIBRARY_FILE_VERSION_RESTORE_RE = new RegExp(`${L}\\/files\\/[^/]+\\/versions\\/\\d{1,6}\\/restore$`);
const ORG_MEDIA_USAGE_RE = /^\/v1\/organizations\/[^/]+\/media-usage$/;
const MEDIA_LIBRARIES = "/v1/media/libraries";
const MEDIA_ACCEPT = "/v1/media/invitations/accept";
// Platform operators (media-worker checks media_platform_operators; anyone else gets 404). The abuse intake
// (/v1/media/abuse-reports) is deliberately absent: only serve-worker reaches it.
const MEDIA_ADMIN_CASES = "/v1/media/admin/abuse-cases";
const MEDIA_ADMIN_CASE_RE = /^\/v1\/media\/admin\/abuse-cases\/[^/]+\/(takedown|dismiss)$/;
const MEDIA_ADMIN_FILE_RE = /^\/v1\/media\/admin\/organizations\/[^/]+\/libraries\/[^/]+\/files\/[^/]+\/(takedown|reinstate)$/;
const MEDIA_ADMIN_ORG_RE = /^\/v1\/media\/admin\/organizations\/[^/]+\/(suspend|unsuspend)$/;
const MEDIA_ADMIN_FAILURES = "/v1/media/admin/pipeline-failures";

const ALLOWED: ReadonlyArray<[RegExp | string, ReadonlySet<string>]> = [
  [ORG_LIBRARIES_RE, new Set(["GET", "POST"])],
  [ORG_LIBRARY_RE, new Set(["GET", "PATCH", "DELETE"])],
  [ORG_LIBRARY_MEMBERS_RE, new Set(["GET"])],
  [ORG_LIBRARY_MEMBER_RE, new Set(["PUT", "DELETE"])],
  [ORG_LIBRARY_INVITATIONS_RE, new Set(["POST"])],
  [ORG_LIBRARY_INVITATION_RE, new Set(["DELETE"])],
  [ORG_LIBRARY_UPLOADS_RE, new Set(["POST"])],
  [ORG_LIBRARY_UPLOAD_RE, new Set(["GET", "DELETE"])],
  [ORG_LIBRARY_UPLOAD_PART_RE, new Set(["PUT"])],
  [ORG_LIBRARY_UPLOAD_COMMIT_RE, new Set(["POST"])],
  [ORG_LIBRARY_FILES_RE, new Set(["GET"])],
  [ORG_LIBRARY_FILES_BATCH_RE, new Set(["POST"])],
  [ORG_LIBRARY_FOLDERS_RE, new Set(["GET", "POST"])],
  [ORG_LIBRARY_FOLDERS_ACTION_RE, new Set(["POST"])],
  [ORG_LIBRARY_TAGS_RE, new Set(["GET"])],
  [ORG_LIBRARY_LIVE_TICKETS_RE, new Set(["POST"])],
  [ORG_LIBRARY_SHARE_LINKS_RE, new Set(["GET", "POST"])],
  [ORG_LIBRARY_UPLOAD_LINKS_RE, new Set(["GET", "POST"])],
  [ORG_LIBRARY_UPLOAD_LINK_RE, new Set(["DELETE"])],
  [ORG_LIBRARY_SHARE_LINK_RE, new Set(["DELETE"])],
  [ORG_LIBRARY_LIVE_RE, new Set(["GET"])],
  [ORG_LIBRARY_FILE_RE, new Set(["GET", "DELETE", "PATCH"])],
  [ORG_LIBRARY_FILE_SIGNED_URL_RE, new Set(["POST"])],
  [ORG_LIBRARY_FILE_REPROCESS_RE, new Set(["POST"])],
  [ORG_LIBRARY_FILE_REVIEW_RE, new Set(["POST"])],
  [ORG_LIBRARY_PIPELINE_FAILURES_RE, new Set(["GET"])],
  [ORG_LIBRARY_FILE_CONTENT_RE, new Set(["GET"])],
  [ORG_LIBRARY_FILE_RESTORE_RE, new Set(["POST"])],
  [ORG_LIBRARY_FILE_VERSIONS_RE, new Set(["GET"])],
  [ORG_LIBRARY_FILE_VERSION_RESTORE_RE, new Set(["POST"])],
  [ORG_MEDIA_USAGE_RE, new Set(["GET"])],
  [MEDIA_LIBRARIES, new Set(["GET"])],
  [MEDIA_ACCEPT, new Set(["POST"])],
  [MEDIA_ADMIN_CASES, new Set(["GET"])],
  [MEDIA_ADMIN_CASE_RE, new Set(["POST"])],
  [MEDIA_ADMIN_FILE_RE, new Set(["POST"])],
  [MEDIA_ADMIN_ORG_RE, new Set(["POST"])],
  [MEDIA_ADMIN_FAILURES, new Set(["GET"])],
];

const FORWARDED_HEADERS = ["content-type", "traceparent", "idempotency-key"];
const BODY_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH"]);

function allowedMethods(pathname: string): ReadonlySet<string> | null {
  for (const [pattern, methods] of ALLOWED) {
    if (typeof pattern === "string" ? pattern === pathname : pattern.test(pathname)) return methods;
  }
  return null;
}

export function isMediaRoute(pathname: string): boolean {
  return allowedMethods(pathname) !== null;
}

export async function handleMediaRoute(
  request: Request,
  env: Env,
  requestId: string,
  pathname: string,
): Promise<Response> {
  const methods = allowedMethods(pathname);
  if (!methods || !methods.has(request.method)) {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }

  if (ORG_LIBRARY_LIVE_RE.test(pathname)) {
    if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
      return errorResponse("unsupported", "Expected a WebSocket upgrade", 426, requestId);
    }
    if (!env.MEDIA_WORKER) return errorResponse("internal_error", "Media service unavailable", 503, requestId);
    const url = new URL(request.url);
    const headers = new Headers();
    for (const name of ["upgrade", "connection", "sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions"]) {
      const v = request.headers.get(name);
      if (v) headers.set(name, v);
    }
    headers.set("x-request-id", requestId);
    return env.MEDIA_WORKER.fetch(new URL(pathname + url.search, "https://media.internal").toString(), { method: "GET", headers });
  }

  // Upload traffic (sessions, parts, commits) has its own budget: a 2 GB file is 60 part requests.
  const family = /\/uploads(\/|$)/.test(pathname) ? "media_upload" : "media";
  return replayOrExecute(request, requestId, env, family, async () => {
    if (!env.IDENTITY_WORKER) {
      return errorResponse("internal_error", "Authentication service unavailable", 503, requestId);
    }
    if (!env.MEDIA_WORKER) {
      return errorResponse("internal_error", "Media service unavailable", 503, requestId);
    }

    const timings = createTimings();
    const endTotal = timings.start("edge_total");
    const sessionResult = await timings.measure("edge_auth", () => resolveActor(request, env, requestId));
    if ("error" in sessionResult) return sessionResult.error;

    const headers = new Headers();
    headers.set("x-request-id", requestId);
    headers.set("x-actor-subject-id", sessionResult.subjectId);
    headers.set("x-actor-subject-type", sessionResult.subjectType);
    headers.set("x-actor-email", sessionResult.email);
    for (const name of FORWARDED_HEADERS) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }

    const url = new URL(request.url);
    const target = new URL(pathname + url.search, "https://media.internal");
    const init: RequestInit = { method: request.method, headers };
    if (BODY_METHODS.has(request.method)) init.body = request.body;

    try {
      const downstream = await timings.measure("edge_downstream", () => env.MEDIA_WORKER!.fetch(target.toString(), init));
      const res = new Response(downstream.body, { status: downstream.status, headers: downstream.headers });
      endTotal();
      return withEdgeTimings(res, requestId, "edge.media", timings);
    } catch {
      return errorResponse("internal_error", "Media service unavailable", 503, requestId);
    }
  });
}
