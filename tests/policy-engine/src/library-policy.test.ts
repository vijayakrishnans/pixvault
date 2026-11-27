// PV1 permission matrix: org role × library role × principal kind × everyone-in-org × action.
// The expected answer is written from the design (specs/epics/pixvault-team-media/design.md §1.1), not read back
// from the engine's tables, so a drift in either shows up here.

import { authorize, effectiveLibraryRole, validateLibraryRoleAssignment } from "@saas/policy-engine";
import type { AuthorizationRequest, MembershipFact } from "@saas/contracts/policy";
import { LIBRARY_ACTIONS, type LibraryAction, type LibraryRole, type LibraryRoleFact } from "@saas/contracts/media";
import type { TenancyRole } from "@saas/contracts/tenancy";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const LIB = "33333333-3333-4333-8333-333333333333";
const OTHER_LIB = "44444444-4444-4444-8444-444444444444";
const PRJ = "55555555-5555-4555-8555-555555555555";

type OrgRole = "owner" | "admin" | "builder" | "viewer" | "billing_admin" | "none";
const ORG_ROLES: OrgRole[] = ["owner", "admin", "builder", "viewer", "billing_admin", "none"];
const LIB_ROLES: (LibraryRole | "none")[] = ["manager", "editor", "uploader", "viewer", "none"];

const orgFact = (role: string, orgId = ORG): MembershipFact => ({
  kind: "role_assignment",
  role: role as TenancyRole,
  scope: { kind: "organization", orgId },
});
const libFact = (role: LibraryRole, kind: "member" | "guest" = "member", orgId = ORG, libraryId = LIB): LibraryRoleFact => ({
  kind: "library_role",
  role,
  principalKind: kind,
  scope: { kind: "library", orgId, libraryId },
});

function req(action: string, memberships: unknown[], everyoneInOrg = false, libraryId = LIB, orgId = ORG): AuthorizationRequest {
  return {
    subject: { type: "user", id: "usr_x" },
    action,
    resource:
      action === "library.create"
        ? { kind: "organization", orgId }
        : { kind: "library", orgId, projectId: PRJ, id: libraryId },
    context: {
      memberships: memberships as AuthorizationRequest["context"]["memberships"],
      attributes: { library: { libraryId, everyoneInOrg } },
    },
  };
}

// ── The design, restated ─────────────────────────────────────
const VIEWER = new Set<LibraryAction>(["library.read", "library.member.list", "file.list", "file.read", "file.download"]);
const UPLOADER = new Set<LibraryAction>(["library.read", "file.upload", "file.list.own", "file.read.own"]);
const EDITOR = new Set<LibraryAction>([
  ...VIEWER,
  "file.list.own",
  "file.read.own",
  "file.upload",
  "file.update",
  "file.delete",
  "file.restore",
  "share.create",
  "review.decide",
]);
const MANAGER = new Set<LibraryAction>([
  ...EDITOR,
  "library.update",
  "library.delete",
  "library.member.write",
  "upload_link.manage",
  "storage.manage",
  "domain.manage",
]);
const SPEC: Record<LibraryRole, Set<LibraryAction>> = { manager: MANAGER, editor: EDITOR, uploader: UPLOADER, viewer: VIEWER };

function expected(orgRole: OrgRole, libRole: LibraryRole | "none", everyone: boolean, action: LibraryAction): boolean {
  if (action === "library.create") return orgRole === "owner" || orgRole === "admin" || orgRole === "builder";
  const roles = new Set<LibraryRole>();
  if (orgRole === "owner" || orgRole === "admin") roles.add("manager");
  if (everyone && orgRole === "builder") roles.add("editor");
  if (everyone && orgRole === "viewer") roles.add("viewer");
  if (libRole !== "none") roles.add(libRole);
  for (const r of roles) if (SPEC[r].has(action)) return true;
  return false;
}

describe("library permission matrix (org role × library role × everyone-in-org × action)", () => {
  const cases: [OrgRole, LibraryRole | "none", boolean, LibraryAction][] = [];
  for (const o of ORG_ROLES) for (const l of LIB_ROLES) for (const e of [false, true]) for (const a of LIBRARY_ACTIONS) cases.push([o, l, e, a]);

  it(`covers every combination (${cases.length})`, () => {
    expect(cases.length).toBe(ORG_ROLES.length * LIB_ROLES.length * 2 * LIBRARY_ACTIONS.length);
  });

  it.each(cases)("org=%s lib=%s everyone=%s %s", (o, l, e, a) => {
    const facts: unknown[] = [];
    if (o !== "none") facts.push(orgFact(o));
    if (l !== "none") facts.push(libFact(l));
    expect(authorize(req(a, facts, e)).allow).toBe(expected(o, l, e, a));
  });
});

describe("guests (outside the org)", () => {
  it.each(LIBRARY_ACTIONS.map((a) => [a]))("guest viewer: %s", (a) => {
    expect(authorize(req(a, [libFact("viewer", "guest")])).allow).toBe(a !== "library.create" && VIEWER.has(a));
  });
  it.each(LIBRARY_ACTIONS.map((a) => [a]))("guest uploader: %s", (a) => {
    expect(authorize(req(a, [libFact("uploader", "guest")])).allow).toBe(a !== "library.create" && UPLOADER.has(a));
  });
  it("a guest fact claiming manager or editor is ignored (deny)", () => {
    for (const r of ["manager", "editor"] as LibraryRole[]) {
      for (const a of LIBRARY_ACTIONS) expect(authorize(req(a, [libFact(r, "guest")])).allow).toBe(false);
    }
  });
  it("everyone-in-org grants nothing to a guest", () => {
    expect(authorize(req("file.list", [], true)).allow).toBe(false);
  });
});

describe("isolation: facts only apply to their own org and library", () => {
  it("an org owner of ANOTHER org gets nothing here", () => {
    for (const a of LIBRARY_ACTIONS) expect(authorize(req(a, [orgFact("owner", OTHER_ORG)])).allow).toBe(false);
  });
  it("a manager of ANOTHER library gets nothing on this one", () => {
    for (const a of LIBRARY_ACTIONS) {
      if (a === "library.create") continue;
      expect(authorize(req(a, [libFact("manager", "member", ORG, OTHER_LIB)])).allow).toBe(false);
    }
  });
  it("a library fact naming the right library but the wrong org gets nothing", () => {
    for (const a of LIBRARY_ACTIONS) {
      if (a === "library.create") continue;
      expect(authorize(req(a, [libFact("manager", "member", OTHER_ORG, LIB)])).allow).toBe(false);
    }
  });
  it("everyone-in-org attributes for a different library are ignored", () => {
    const r = req("file.list", [orgFact("builder")], false);
    r.context.attributes = { library: { libraryId: OTHER_LIB, everyoneInOrg: true } };
    expect(authorize(r).allow).toBe(false);
  });
  it("a library action without a library id is denied", () => {
    const r = req("file.list", [orgFact("owner")]);
    r.resource = { kind: "library", orgId: ORG };
    expect(authorize(r)).toMatchObject({ allow: false, reason: "invalid_scope" });
  });
  it("malformed facts deny", () => {
    const junk = [{ kind: "library_role", role: "god", principalKind: "member", scope: { kind: "library", orgId: ORG, libraryId: LIB } }, null, 7, "x"];
    for (const a of LIBRARY_ACTIONS) expect(authorize(req(a, junk)).allow).toBe(false);
  });
});

describe("existing Cirrus actions are unaffected", () => {
  it("project.create still follows org roles", () => {
    expect(authorize({ subject: { type: "user", id: "u" }, action: "project.create", resource: { kind: "project", orgId: ORG }, context: { memberships: [orgFact("builder")] } }).allow).toBe(true);
    expect(authorize({ subject: { type: "user", id: "u" }, action: "project.create", resource: { kind: "project", orgId: ORG }, context: { memberships: [libFact("manager")] as unknown as MembershipFact[] } }).allow).toBe(false);
  });
});

describe("effectiveLibraryRole and role assignment", () => {
  it("reports the strongest role", () => {
    expect(effectiveLibraryRole({ orgId: ORG, libraryId: LIB, memberships: [orgFact("admin"), libFact("viewer")], everyoneInOrg: false })).toBe("manager");
    expect(effectiveLibraryRole({ orgId: ORG, libraryId: LIB, memberships: [orgFact("builder")], everyoneInOrg: true })).toBe("editor");
    expect(effectiveLibraryRole({ orgId: ORG, libraryId: LIB, memberships: [orgFact("builder")], everyoneInOrg: false })).toBeNull();
  });
  it("guests may only be uploader or viewer", () => {
    expect(validateLibraryRoleAssignment({ role: "viewer", principalKind: "guest" })).toEqual({ valid: true });
    expect(validateLibraryRoleAssignment({ role: "editor", principalKind: "guest" })).toMatchObject({ valid: false });
    expect(validateLibraryRoleAssignment({ role: "manager", principalKind: "member" })).toEqual({ valid: true });
    expect(validateLibraryRoleAssignment({ role: "owner", principalKind: "member" })).toMatchObject({ valid: false });
  });
});
