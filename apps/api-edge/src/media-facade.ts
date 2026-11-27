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
const MEDIA_LIBRARIES = "/v1/media/libraries";
const MEDIA_ACCEPT = "/v1/media/invitations/accept";

const ALLOWED: ReadonlyArray<[RegExp | string, ReadonlySet<string>]> = [
  [ORG_LIBRARIES_RE, new Set(["GET", "POST"])],
  [ORG_LIBRARY_RE, new Set(["GET", "PATCH", "DELETE"])],
  [ORG_LIBRARY_MEMBERS_RE, new Set(["GET"])],
  [ORG_LIBRARY_MEMBER_RE, new Set(["PUT", "DELETE"])],
  [ORG_LIBRARY_INVITATIONS_RE, new Set(["POST"])],
  [ORG_LIBRARY_INVITATION_RE, new Set(["DELETE"])],
  [MEDIA_LIBRARIES, new Set(["GET"])],
  [MEDIA_ACCEPT, new Set(["POST"])],
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

  return replayOrExecute(request, requestId, env, "media", async () => {
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
