// Every media decision goes to policy-worker. This module gathers the facts it needs: the caller's org role
// facts (membership-worker) and library role facts (media_library_members), and the library's attributes.

import type { LibraryAction, LibraryRole, LibraryRoleFact } from "@saas/contracts/media";
import type { MembershipFact, PolicyResource } from "@saas/contracts/policy";
import type { Library, MediaRepository } from "@saas/db/media";
import { effectiveLibraryRole } from "@saas/policy-engine";
import type { Env } from "./env.js";
import { fetchAuthorizationContext } from "./membership-client.js";
import type { ActorContext } from "./router.js";

export interface AccessFacts {
  orgFacts: MembershipFact[];
  libraryFacts: LibraryRoleFact[];
}

export type FactsResult = { ok: true; facts: AccessFacts } | { ok: false };

/** Load every fact about `actor` in `orgId`. Guests have no org facts, only library facts. */
export async function loadFacts(
  env: Env,
  repo: MediaRepository,
  actor: ActorContext,
  orgId: string,
  requestId: string,
): Promise<FactsResult> {
  const [ctx, roles] = await Promise.all([
    fetchAuthorizationContext(env.MEMBERSHIP_WORKER!, actor.subjectId, actor.subjectType, orgId, requestId),
    repo.listPrincipalRoles(orgId, actor.subjectId),
  ]);
  if (!ctx.ok || !roles.ok) return { ok: false };
  const libraryFacts: LibraryRoleFact[] = roles.value.map((m) => ({
    kind: "library_role",
    role: m.role,
    principalKind: m.principalKind,
    scope: { kind: "library", orgId, libraryId: m.libraryId },
  }));
  return { ok: true, facts: { orgFacts: ctx.memberships, libraryFacts } };
}

/** True when the subject has any standing in the org: an org role or a library role. */
export function hasAnyStanding(facts: AccessFacts): boolean {
  return facts.orgFacts.length > 0 || facts.libraryFacts.length > 0;
}

interface PolicyAnswer {
  allow: boolean;
}

async function askPolicy(
  env: Env,
  actor: ActorContext,
  action: LibraryAction,
  resource: PolicyResource,
  memberships: unknown[],
  attributes: Record<string, unknown> | undefined,
  requestId: string,
): Promise<PolicyAnswer> {
  let res: Response;
  try {
    res = await env.POLICY_WORKER!.fetch("http://policy-worker/v1/internal/policy/authorize", {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": requestId },
      body: JSON.stringify({
        subject: { type: actor.subjectType, id: actor.subjectId },
        action,
        resource,
        context: attributes ? { memberships, attributes } : { memberships },
      }),
    });
  } catch {
    return { allow: false };
  }
  if (!res.ok) return { allow: false };
  try {
    const json = (await res.json()) as { data?: { allow?: unknown } };
    return { allow: json.data?.allow === true };
  } catch {
    return { allow: false };
  }
}

/** Ask policy-worker whether `actor` may do `action` on `library`. Fails closed. */
export async function authorizeOnLibrary(
  env: Env,
  actor: ActorContext,
  action: LibraryAction,
  library: Library,
  facts: AccessFacts,
  requestId: string,
): Promise<boolean> {
  const answer = await askPolicy(
    env,
    actor,
    action,
    { kind: "library", orgId: library.orgId, projectId: library.projectId, id: library.id },
    [...facts.orgFacts, ...facts.libraryFacts],
    { library: { libraryId: library.id, everyoneInOrg: library.everyoneInOrg } },
    requestId,
  );
  return answer.allow;
}

/** Ask policy-worker whether `actor` may create libraries in `orgId`. */
export async function authorizeCreate(
  env: Env,
  actor: ActorContext,
  orgId: string,
  facts: AccessFacts,
  requestId: string,
): Promise<boolean> {
  const answer = await askPolicy(
    env,
    actor,
    "library.create",
    { kind: "organization", orgId },
    facts.orgFacts,
    undefined,
    requestId,
  );
  return answer.allow;
}

/** The caller's effective role, for display (`myRole`). Decisions are still policy-worker's. */
export function displayRole(library: Library, facts: AccessFacts): LibraryRole | null {
  return effectiveLibraryRole({
    orgId: library.orgId,
    libraryId: library.id,
    memberships: [...facts.orgFacts, ...facts.libraryFacts],
    everyoneInOrg: library.everyoneInOrg,
  });
}
