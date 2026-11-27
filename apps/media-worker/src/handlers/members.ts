import type {
  CreateLibraryInvitationRequest,
  LibraryRole,
  PublicLibrary,
  PublicLibraryInvitation,
  PublicLibraryMember,
} from "@saas/contracts/media";
import { LIBRARY_ROLES } from "@saas/contracts/media";
import type { LibraryInvitation, LibraryMember } from "@saas/db/media";
import { validateLibraryRoleAssignment } from "@saas/policy-engine";
import { authorizeOnLibrary, loadFacts } from "../access.js";
import { audit, type Ctx } from "../ctx.js";
import { errorResponse, successResponse, validationError } from "../http.js";
import { actorUuid, invitationPublicId, libraryPublicId } from "../ids.js";
import { fetchAuthorizationContext } from "../membership-client.js";
import { loadAuthorized, toPublicLibrary } from "./libraries.js";

const INVITATION_TTL_DAYS = 14;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

function toPublicMember(m: LibraryMember): PublicLibraryMember {
  return {
    libraryId: libraryPublicId(m.libraryId),
    principalKind: m.principalKind,
    principalId: m.principalId,
    email: m.email,
    role: m.role,
    createdAt: m.createdAt.toISOString(),
  };
}

function toPublicInvitation(i: LibraryInvitation): PublicLibraryInvitation {
  return {
    id: invitationPublicId(i.id),
    libraryId: libraryPublicId(i.libraryId),
    email: i.emailLower,
    role: i.role,
    expiresAt: i.expiresAt.toISOString(),
    createdAt: i.createdAt.toISOString(),
  };
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

/** GET …/libraries/{lib}/members: members and open guest invitations. */
export async function handleListMembers(ctx: Ctx, orgId: string, libraryId: string): Promise<Response> {
  const a = await loadAuthorized(ctx, orgId, libraryId, "library.member.list");
  if (!a.ok) return a.response;
  const [members, invitations] = await Promise.all([
    ctx.repo.listMembers(orgId, libraryId),
    ctx.repo.listOpenInvitations(orgId, libraryId, ctx.now()),
  ]);
  if (!members.ok || !invitations.ok) return errorResponse("internal_error", "Service unavailable", 503, ctx.requestId);
  // Only managers see pending invitations (they hold email addresses of people outside the org).
  const canManage = await authorizeOnLibrary(ctx.env, ctx.actor, "library.member.write", a.lib, a.facts, ctx.requestId);
  return successResponse(
    {
      members: members.value.map(toPublicMember),
      invitations: canManage ? invitations.value.map(toPublicInvitation) : [],
    },
    ctx.requestId,
  );
}

/**
 * PUT …/libraries/{lib}/members/{principalId} { role }
 * An org member gets any library role. A principal outside the org can only be changed if they are already a
 * guest of this library (guests join by invitation), and only to a guest role.
 */
export async function handlePutMember(
  ctx: Ctx,
  request: Request,
  orgId: string,
  libraryId: string,
  principalId: string,
): Promise<Response> {
  const body = (await readJson(request)) as { role?: unknown } | undefined;
  if (!body || typeof body !== "object") return validationError(ctx.requestId, { body: ["Invalid JSON"] });
  if (typeof body.role !== "string" || !(LIBRARY_ROLES as readonly string[]).includes(body.role)) {
    return validationError(ctx.requestId, { role: ["Must be manager, editor, uploader or viewer"] });
  }
  const role = body.role as LibraryRole;

  const a = await loadAuthorized(ctx, orgId, libraryId, "library.member.write");
  if (!a.ok) return a.response;

  const target = await fetchAuthorizationContext(ctx.env.MEMBERSHIP_WORKER!, principalId, "user", orgId, ctx.requestId);
  if (!target.ok) return errorResponse("internal_error", "Service unavailable", 503, ctx.requestId);
  let principalKind: "member" | "guest";
  if (target.memberships.length > 0) {
    principalKind = "member";
  } else {
    const existing = await ctx.repo.listMembers(orgId, libraryId);
    if (!existing.ok) return errorResponse("internal_error", "Service unavailable", 503, ctx.requestId);
    if (!existing.value.some((m) => m.principalId === principalId && m.principalKind === "guest")) {
      return errorResponse("not_found", "Not found", 404, ctx.requestId);
    }
    principalKind = "guest";
  }
  const valid = validateLibraryRoleAssignment({ role, principalKind });
  if (!valid.valid) return validationError(ctx.requestId, { role: [`Not allowed: ${valid.reason}`] });

  const saved = await ctx.repo.upsertMember({
    orgId,
    libraryId,
    principalKind,
    principalId,
    email: null,
    role,
    createdBy: actorUuid(ctx.actor.subjectId),
    at: ctx.now(),
  });
  if (!saved.ok) return errorResponse("internal_error", "Service unavailable", 503, ctx.requestId);
  await audit(ctx, a.lib, "library.member.updated", `Set ${principalKind} role to ${role} in library "${a.lib.name}"`, {
    principalId,
    principalKind,
    role,
  });
  return successResponse({ member: toPublicMember(saved.value) }, ctx.requestId);
}

/** DELETE …/libraries/{lib}/members/{principalId}. Members may also remove themselves (leave). */
export async function handleRemoveMember(ctx: Ctx, orgId: string, libraryId: string, principalId: string): Promise<Response> {
  const self = principalId === ctx.actor.subjectId;
  const a = await loadAuthorized(ctx, orgId, libraryId, self ? "library.read" : "library.member.write");
  if (!a.ok) return a.response;
  const removed = await ctx.repo.removeMember(orgId, libraryId, principalId);
  if (!removed.ok) {
    return removed.error.kind === "not_found"
      ? errorResponse("not_found", "Not found", 404, ctx.requestId)
      : errorResponse("internal_error", "Service unavailable", 503, ctx.requestId);
  }
  await audit(ctx, a.lib, "library.member.removed", `Removed a member from library "${a.lib.name}"`, { principalId });
  return successResponse({ removed: true }, ctx.requestId);
}

/** POST …/libraries/{lib}/invitations { email, role }: invite a guest (uploader or viewer). */
export async function handleCreateInvitation(ctx: Ctx, request: Request, orgId: string, libraryId: string): Promise<Response> {
  const body = (await readJson(request)) as Partial<CreateLibraryInvitationRequest> | undefined;
  if (!body || typeof body !== "object") return validationError(ctx.requestId, { body: ["Invalid JSON"] });
  const fields: Record<string, string[]> = {};
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email) || email.length > 254) fields.email = ["Must be an email address"];
  if (body.role !== "uploader" && body.role !== "viewer") fields.role = ["Guests may be uploader or viewer"];
  if (Object.keys(fields).length) return validationError(ctx.requestId, fields);

  const a = await loadAuthorized(ctx, orgId, libraryId, "library.member.write");
  if (!a.ok) return a.response;
  const now = ctx.now();
  const created = await ctx.repo.createInvitation({
    id: crypto.randomUUID(),
    orgId,
    libraryId,
    emailLower: email,
    role: body.role as "uploader" | "viewer",
    createdBy: actorUuid(ctx.actor.subjectId),
    createdAt: now,
    expiresAt: new Date(now.getTime() + INVITATION_TTL_DAYS * 86_400_000),
  });
  if (!created.ok) {
    return created.error.kind === "conflict"
      ? errorResponse("conflict", "This email already has an open invitation to this library", 409, ctx.requestId)
      : errorResponse("internal_error", "Service unavailable", 503, ctx.requestId);
  }
  await audit(ctx, a.lib, "library.invitation.created", `Invited a guest to library "${a.lib.name}"`, {
    invitationId: invitationPublicId(created.value.id),
    role: created.value.role,
  });
  return successResponse({ invitation: toPublicInvitation(created.value) }, ctx.requestId, 201);
}

/** DELETE …/libraries/{lib}/invitations/{lbi} */
export async function handleRevokeInvitation(ctx: Ctx, orgId: string, libraryId: string, invitationId: string): Promise<Response> {
  const a = await loadAuthorized(ctx, orgId, libraryId, "library.member.write");
  if (!a.ok) return a.response;
  const r = await ctx.repo.revokeInvitation(orgId, libraryId, invitationId, ctx.now());
  if (!r.ok) {
    return r.error.kind === "not_found"
      ? errorResponse("not_found", "Not found", 404, ctx.requestId)
      : errorResponse("internal_error", "Service unavailable", 503, ctx.requestId);
  }
  await audit(ctx, a.lib, "library.invitation.revoked", `Revoked a guest invitation to library "${a.lib.name}"`, {
    invitationId: invitationPublicId(invitationId),
  });
  return successResponse({ revoked: true }, ctx.requestId);
}

/**
 * POST /v1/media/invitations/accept: accept every open invitation addressed to the caller's verified email.
 * A caller who is already an org member joins as a member with the invited role; anyone else joins as a guest.
 */
export async function handleAcceptInvitations(ctx: Ctx): Promise<Response> {
  if (ctx.actor.subjectType !== "user" || !ctx.actor.email) {
    return errorResponse("not_found", "Not found", 404, ctx.requestId);
  }
  const emailLower = ctx.actor.email.trim().toLowerCase();
  const open = await ctx.repo.listInvitationsForEmail(emailLower, ctx.now());
  if (!open.ok) return errorResponse("internal_error", "Service unavailable", 503, ctx.requestId);
  const joined: PublicLibrary[] = [];
  for (const inv of open.value) {
    const member = await fetchAuthorizationContext(ctx.env.MEMBERSHIP_WORKER!, ctx.actor.subjectId, "user", inv.orgId, ctx.requestId);
    if (!member.ok) continue;
    let accepted;
    if (member.memberships.length > 0) {
      accepted = await ctx.repo.acceptInvitation(inv, ctx.actor.subjectId, ctx.now());
      if (accepted.ok && accepted.value.principalKind === "guest") {
        await ctx.repo.upsertMember({
          orgId: inv.orgId,
          libraryId: inv.libraryId,
          principalKind: "member",
          principalId: ctx.actor.subjectId,
          email: emailLower,
          role: inv.role,
          createdBy: inv.createdBy,
          at: ctx.now(),
        });
      }
    } else {
      accepted = await ctx.repo.acceptInvitation(inv, ctx.actor.subjectId, ctx.now());
    }
    if (!accepted.ok) continue;
    const lib = await ctx.repo.getLibrary(inv.orgId, inv.libraryId);
    if (!lib.ok) continue;
    await audit(ctx, lib.value, "library.invitation.accepted", `A guest joined library "${lib.value.name}"`, {
      invitationId: invitationPublicId(inv.id),
      role: inv.role,
    });
    const facts = await loadFacts(ctx.env, ctx.repo, ctx.actor, inv.orgId, ctx.requestId);
    joined.push(toPublicLibrary(lib.value, facts.ok ? facts.facts : null));
  }
  return successResponse({ libraries: joined }, ctx.requestId);
}

/** GET /v1/media/libraries: libraries the caller holds as a guest, across orgs (members use the org route). */
export async function handleListGuestLibraries(ctx: Ctx): Promise<Response> {
  const guest = await ctx.repo.listGuestMemberships(ctx.actor.subjectId);
  if (!guest.ok) return errorResponse("internal_error", "Service unavailable", 503, ctx.requestId);
  const out: PublicLibrary[] = [];
  for (const m of guest.value) {
    const a = await loadAuthorized(ctx, m.orgId, m.libraryId, "library.read");
    if (a.ok) out.push(toPublicLibrary(a.lib, a.facts));
  }
  return successResponse({ libraries: out }, ctx.requestId);
}
