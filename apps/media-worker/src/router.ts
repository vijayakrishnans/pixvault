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
import { errorResponse, methodNotAllowed, notFound } from "./http.js";
import { generateRequestId, isPrincipalId, parseInvitationPublicId, parseLibraryPublicId, parseOrgPublicId } from "./ids.js";

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
const GUEST_LIBRARIES = "/v1/media/libraries";
const ACCEPT_INVITATIONS = "/v1/media/invitations/accept";

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

  try {
    if (path === GUEST_LIBRARIES) {
      return method === "GET" ? await handleListGuestLibraries(ctx) : methodNotAllowed(requestId);
    }
    if (path === ACCEPT_INVITATIONS) {
      return method === "POST" ? await handleAcceptInvitations(ctx) : methodNotAllowed(requestId);
    }

    let m: RegExpMatchArray | null;
    const nf = () => errorResponse("not_found", "Not found", 404, requestId);

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
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}
