// Library (Pixvault media) authorization: org role ∪ library role, evaluated in one place.
//
// Rules (specs/epics/pixvault-team-media/design.md §1.1):
// - Org owners and admins are managers of every library in their org.
// - A library role fact (from media_library_members) grants that role on that one library.
// - A library marked everyone_in_org grants org builders (members) `editor` and org viewers `viewer`.
// - Guests hold only `uploader` or `viewer`, on one library, and nothing org-level.
// - `library.create` is org-level: owners, admins and builders.
// - Every fact is matched on BOTH orgId and libraryId; a fact for another org or library never applies.
//
// The engine is deny-by-default: an unknown role, a malformed fact or a missing scope denies.

import type { AuthorizationRequest, AuthorizationResponse, MembershipFact } from "@saas/contracts/policy";
import {
  GUEST_LIBRARY_ROLES,
  LIBRARY_ACTIONS,
  LIBRARY_ROLES,
  type LibraryAction,
  type LibraryPolicyAttributes,
  type LibraryRole,
  type LibraryRoleFact,
} from "@saas/contracts/media";
import { POLICY_VERSION } from "@saas/contracts/policy";

const LIBRARY_ACTION_SET: ReadonlySet<string> = new Set(LIBRARY_ACTIONS);

export function isLibraryAction(action: string): action is LibraryAction {
  return LIBRARY_ACTION_SET.has(action);
}

const VIEWER: readonly LibraryAction[] = ["library.read", "library.member.list", "file.list", "file.read", "file.download"];

const UPLOADER: readonly LibraryAction[] = ["library.read", "file.upload", "file.list.own", "file.read.own"];

const EDITOR: readonly LibraryAction[] = [
  ...VIEWER,
  "file.list.own",
  "file.read.own",
  "file.upload",
  "file.update",
  "file.delete",
  "file.restore",
  "share.create",
  "review.decide",
];

const MANAGER: readonly LibraryAction[] = [
  ...EDITOR,
  "library.update",
  "library.delete",
  "library.member.write",
  "upload_link.manage",
  "storage.manage",
  "domain.manage",
];

/** What each library role may do. `library.create` is org-level and is in no library role. */
export const LIBRARY_ROLE_ACTIONS: Readonly<Record<LibraryRole, ReadonlySet<LibraryAction>>> = {
  manager: new Set(MANAGER),
  editor: new Set(EDITOR),
  uploader: new Set(UPLOADER),
  viewer: new Set(VIEWER),
};

const ROLE_RANK: Record<LibraryRole, number> = { viewer: 1, uploader: 1, editor: 2, manager: 3 };

const ORG_CREATE_ROLES: ReadonlySet<string> = new Set(["owner", "admin", "builder"]);
const ORG_MANAGER_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function isOrgRoleFact(f: unknown, orgId: string): f is MembershipFact {
  if (!isRecord(f) || f.kind !== "role_assignment" || typeof f.role !== "string") return false;
  const scope = f.scope;
  return isRecord(scope) && scope.kind === "organization" && scope.orgId === orgId;
}

function isLibraryRoleFact(f: unknown, orgId: string, libraryId: string): f is LibraryRoleFact {
  if (!isRecord(f) || f.kind !== "library_role") return false;
  if (typeof f.role !== "string" || !(LIBRARY_ROLES as readonly string[]).includes(f.role)) return false;
  if (f.principalKind !== "member" && f.principalKind !== "guest") return false;
  if (f.principalKind === "guest" && !(GUEST_LIBRARY_ROLES as readonly string[]).includes(f.role)) return false;
  const scope = f.scope;
  return isRecord(scope) && scope.kind === "library" && scope.orgId === orgId && scope.libraryId === libraryId;
}

function libraryAttributes(input: AuthorizationRequest, libraryId: string): LibraryPolicyAttributes | null {
  const raw = input.context.attributes?.library;
  if (!isRecord(raw) || raw.libraryId !== libraryId) return null;
  return { libraryId, everyoneInOrg: raw.everyoneInOrg === true };
}

/**
 * The caller's effective role on one library, or null. Exported so media-worker can report `myRole` with the
 * exact rule policy-worker enforces (it still asks policy-worker for every decision).
 */
export function effectiveLibraryRole(input: {
  orgId: string;
  libraryId: string;
  memberships: readonly unknown[];
  everyoneInOrg: boolean;
}): LibraryRole | null {
  const { orgId, libraryId, memberships, everyoneInOrg } = input;
  let best: LibraryRole | null = null;
  const consider = (r: LibraryRole) => {
    if (best === null || ROLE_RANK[r] > ROLE_RANK[best]) best = r;
  };
  const orgRoles = memberships.filter((f) => isOrgRoleFact(f, orgId)).map((f) => (f as MembershipFact).role as string);
  if (orgRoles.some((r) => ORG_MANAGER_ROLES.has(r))) return "manager";
  if (everyoneInOrg) {
    if (orgRoles.includes("builder")) consider("editor");
    else if (orgRoles.includes("viewer")) consider("viewer");
  }
  for (const f of memberships) {
    if (isLibraryRoleFact(f, orgId, libraryId)) consider(f.role);
  }
  return best;
}

function deny(reason: string, orgId: string, projectId?: string): AuthorizationResponse {
  return { allow: false, reason, policyVersion: POLICY_VERSION, derivedScope: projectId ? { orgId, projectId } : { orgId } };
}
function allow(reason: string, orgId: string, projectId?: string): AuthorizationResponse {
  return { allow: true, reason, policyVersion: POLICY_VERSION, derivedScope: projectId ? { orgId, projectId } : { orgId } };
}

/** Authorize one media action. Resource: `{ kind: "library", orgId, projectId?, id: libraryId }`. */
export function authorizeLibrary(input: AuthorizationRequest): AuthorizationResponse {
  const { action, resource, context } = input;
  const orgId = resource.orgId;
  const projectId = typeof resource.projectId === "string" && resource.projectId ? resource.projectId : undefined;
  if (!orgId) return deny("invalid_scope", "");
  if (!isLibraryAction(action)) return deny("unknown_action", orgId, projectId);
  const memberships = Array.isArray(context.memberships) ? context.memberships : [];

  if (action === "library.create") {
    if (resource.kind !== "organization" && resource.kind !== "library") return deny("invalid_scope", orgId);
    const roles = memberships.filter((f) => isOrgRoleFact(f, orgId)).map((f) => (f as MembershipFact).role as string);
    const hit = roles.find((r) => ORG_CREATE_ROLES.has(r));
    return hit ? allow(`org_${hit}`, orgId) : deny("no_matching_role", orgId);
  }

  if (resource.kind !== "library" || typeof resource.id !== "string" || !resource.id) {
    return deny("invalid_scope", orgId, projectId);
  }
  const libraryId = resource.id;
  const attrs = libraryAttributes(input, libraryId);
  const role = effectiveLibraryRole({
    orgId,
    libraryId,
    memberships,
    everyoneInOrg: attrs?.everyoneInOrg ?? false,
  });
  if (!role) return deny("no_matching_role", orgId, projectId);
  // Uploader and viewer aren't ordered, so a principal holding both gets both action sets.
  const held = new Set<LibraryRole>([role]);
  for (const f of memberships) if (isLibraryRoleFact(f, orgId, libraryId)) held.add(f.role);
  for (const r of held) {
    if (LIBRARY_ROLE_ACTIONS[r].has(action)) return allow(`library_${r}`, orgId, projectId);
  }
  return deny("no_matching_role", orgId, projectId);
}

/** Validate a library role assignment before it is stored. */
export function validateLibraryRoleAssignment(input: {
  role: string;
  principalKind: string;
}): { valid: true } | { valid: false; reason: string } {
  if (!(LIBRARY_ROLES as readonly string[]).includes(input.role)) return { valid: false, reason: "invalid_role" };
  if (input.principalKind === "member") return { valid: true };
  if (input.principalKind === "guest") {
    return (GUEST_LIBRARY_ROLES as readonly string[]).includes(input.role)
      ? { valid: true }
      : { valid: false, reason: "guest_role_not_allowed" };
  }
  return { valid: false, reason: "invalid_principal_kind" };
}
