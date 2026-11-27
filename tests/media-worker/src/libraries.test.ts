// PV1 acceptance for media-worker: libraries on projects, library roles, guests, and cross-org / cross-library
// isolation on every route. A denied read is 404, never 403.

import { World, pub, type User } from "./harness.js";

describe("libraries, roles and guests", () => {
  let w: World;
  let A: { id: string; pub: string };
  let B: { id: string; pub: string };
  let ownerA: User, builderA: User, viewerA: User, billingA: User, ownerB: User, guest: User, stranger: User;

  beforeEach(() => {
    w = new World();
    A = w.newOrg();
    B = w.newOrg();
    ownerA = w.newUser("owner-a");
    builderA = w.newUser("builder-a");
    viewerA = w.newUser("viewer-a");
    billingA = w.newUser("billing-a");
    ownerB = w.newUser("owner-b");
    guest = w.newUser("guest");
    stranger = w.newUser("stranger");
    w.grant(A, ownerA, "owner");
    w.grant(A, builderA, "builder");
    w.grant(A, viewerA, "viewer");
    w.grant(A, billingA, "billing_admin");
    w.grant(B, ownerB, "owner");
  });

  const libs = (org: { pub: string }) => `/v1/organizations/${org.pub}/libraries`;

  async function create(user: User, org: { pub: string }, name: string, extra: Record<string, unknown> = {}) {
    return w.call(user, "POST", libs(org), { name, ...extra });
  }

  it("an org owner creates a library on a Cirrus project, with a managed-R2 prefix scoped to it", async () => {
    const r = await create(ownerA, A, "Brand assets");
    expect(r.status).toBe(201);
    const lib = r.json.data.library;
    expect(lib).toMatchObject({ name: "Brand assets", slug: "brand-assets", orgId: A.pub, myRole: "manager", visibilityDefault: "private" });
    expect(lib.id).toMatch(/^lib_[0-9a-f]{32}$/);
    expect(lib.projectId).toMatch(/^prj_[0-9a-f]{32}$/);

    const libUuid = (w.db.prepare(`SELECT id FROM media_libraries`).get() as { id: string }).id;
    const backend = w.db.prepare(`SELECT org_id, kind, prefix FROM media_storage_backends WHERE library_id = ?`).get(libUuid) as Record<string, string>;
    expect(backend).toEqual({ org_id: A.id, kind: "managed-r2", prefix: `org/${A.id}/lib/${libUuid}/` });

    const audit = w.db.prepare(`SELECT org_id, event_type FROM events_audit_entries WHERE event_type = 'library.created'`).all();
    expect(audit).toEqual([{ org_id: A.id, event_type: "library.created" }]);
  });

  it("builders may create; viewers, billing admins, guests and outsiders may not (404)", async () => {
    expect((await create(builderA, A, "Blog images")).status).toBe(201);
    expect((await create(viewerA, A, "X1")).status).toBe(404);
    expect((await create(billingA, A, "X2")).status).toBe(404);
    expect((await create(ownerB, A, "X3")).status).toBe(404);
    expect((await create(stranger, A, "X4")).status).toBe(404);
  });

  it("slugs are unique per org but may repeat across orgs", async () => {
    expect((await create(ownerA, A, "Shots")).status).toBe(201);
    expect((await create(ownerA, A, "Shots")).status).toBe(409);
    expect((await create(ownerB, B, "Shots")).status).toBe(201);
  });

  it("validates input", async () => {
    expect((await w.call(ownerA, "POST", libs(A), { name: "" })).status).toBe(422);
    expect((await w.call(ownerA, "POST", libs(A), { name: "x", slug: "Bad Slug" })).status).toBe(422);
    expect((await w.call(ownerA, "POST", libs(A), { name: "x", visibilityDefault: "world" })).status).toBe(422);
    expect((await w.call(null, "GET", libs(A))).status).toBe(401);
  });

  it("members see only libraries they're in, or that are everyone-in-org, with the right role", async () => {
    const lib = (await create(ownerA, A, "Product shots")).json.data.library;
    const path = `${libs(A)}/${lib.id}`;

    expect((await w.call(builderA, "GET", libs(A))).json.data.libraries).toEqual([]);
    expect((await w.call(builderA, "GET", path)).status).toBe(404);

    expect((await w.call(ownerA, "PATCH", path, { everyoneInOrg: true })).status).toBe(200);
    const asBuilder = (await w.call(builderA, "GET", libs(A))).json.data.libraries;
    expect(asBuilder.map((l: { id: string; myRole: string }) => [l.id, l.myRole])).toEqual([[lib.id, "editor"]]);
    const asViewer = (await w.call(viewerA, "GET", libs(A))).json.data.libraries;
    expect(asViewer.map((l: { myRole: string }) => l.myRole)).toEqual(["viewer"]);
    expect((await w.call(billingA, "GET", libs(A))).json.data.libraries).toEqual([]);

    // editor can't change settings; a manager grant can
    expect((await w.call(builderA, "PATCH", path, { name: "Renamed" })).status).toBe(404);
    expect((await w.call(ownerA, "PUT", `${path}/members/${builderA.id}`, { role: "manager" })).status).toBe(200);
    expect((await w.call(builderA, "PATCH", path, { name: "Renamed" })).json.data.library.name).toBe("Renamed");
  });

  it("validates settings and keeps unknown fields out", async () => {
    const lib = (await create(ownerA, A, "Settings")).json.data.library;
    const path = `${libs(A)}/${lib.id}`;
    expect((await w.call(ownerA, "PATCH", path, { settings: { maxUploadBytes: -1 } })).status).toBe(422);
    expect((await w.call(ownerA, "PATCH", path, { settings: { colour: "red" } })).status).toBe(422);
    expect((await w.call(ownerA, "PATCH", path, { surprise: 1 })).status).toBe(422);
    const ok = await w.call(ownerA, "PATCH", path, { settings: { ipBlockList: ["203.0.113.7"], randomApiEnabled: true } });
    expect(ok.json.data.library.settings).toMatchObject({ ipBlockList: ["203.0.113.7"], randomApiEnabled: true, transformPresets: ["thumb", "small", "medium", "large"] });
  });

  it("guests join by email invitation as uploader or viewer and see only that library", async () => {
    const l1 = (await create(ownerA, A, "Contractor drop")).json.data.library;
    const l2 = (await create(ownerA, A, "Internal")).json.data.library;
    const inv = `${libs(A)}/${l1.id}/invitations`;

    expect((await w.call(ownerA, "POST", inv, { email: guest.email, role: "editor" })).status).toBe(422);
    expect((await w.call(builderA, "POST", inv, { email: guest.email, role: "viewer" })).status).toBe(404);
    const created = await w.call(ownerA, "POST", inv, { email: guest.email.toUpperCase(), role: "uploader" });
    expect(created.status).toBe(201);
    expect((await w.call(ownerA, "POST", inv, { email: guest.email, role: "uploader" })).status).toBe(409);

    // someone else can't accept it
    expect((await w.call(stranger, "POST", "/v1/media/invitations/accept")).json.data.libraries).toEqual([]);
    const accepted = await w.call(guest, "POST", "/v1/media/invitations/accept");
    expect(accepted.json.data.libraries.map((l: { id: string; myRole: string }) => [l.id, l.myRole])).toEqual([[l1.id, "uploader"]]);
    // single use
    expect((await w.call(guest, "POST", "/v1/media/invitations/accept")).json.data.libraries).toEqual([]);

    expect((await w.call(guest, "GET", "/v1/media/libraries")).json.data.libraries.map((l: { id: string }) => l.id)).toEqual([l1.id]);
    expect((await w.call(guest, "GET", libs(A))).json.data.libraries.map((l: { id: string }) => l.id)).toEqual([l1.id]);
    expect((await w.call(guest, "GET", `${libs(A)}/${l2.id}`)).status).toBe(404);
    expect((await w.call(guest, "POST", libs(A), { name: "Mine" })).status).toBe(404);
    expect((await w.call(guest, "GET", `${libs(A)}/${l1.id}/members`)).status).toBe(404); // uploader can't list members

    // a manager can move a guest between guest roles, never to editor
    const m = `${libs(A)}/${l1.id}/members/${guest.id}`;
    expect((await w.call(ownerA, "PUT", m, { role: "viewer" })).status).toBe(200);
    expect((await w.call(ownerA, "PUT", m, { role: "editor" })).status).toBe(422);
    expect((await w.call(guest, "GET", `${libs(A)}/${l1.id}/members`)).status).toBe(200); // viewer may list

    // a non-member who was never invited can't be added by id
    expect((await w.call(ownerA, "PUT", `${libs(A)}/${l1.id}/members/${stranger.id}`, { role: "viewer" })).status).toBe(404);

    // removing the guest takes access away immediately
    expect((await w.call(ownerA, "DELETE", m)).status).toBe(200);
    expect((await w.call(guest, "GET", `${libs(A)}/${l1.id}`)).status).toBe(404);
  });

  it("invitations: revoke, expiry, and managers-only visibility of emails", async () => {
    const l1 = (await create(ownerA, A, "Revocable")).json.data.library;
    await w.call(ownerA, "PUT", `${libs(A)}/${l1.id}/members/${builderA.id}`, { role: "viewer" });
    const inv = (await w.call(ownerA, "POST", `${libs(A)}/${l1.id}/invitations`, { email: guest.email, role: "viewer" })).json.data.invitation;
    expect((await w.call(ownerA, "GET", `${libs(A)}/${l1.id}/members`)).json.data.invitations).toHaveLength(1);
    expect((await w.call(builderA, "GET", `${libs(A)}/${l1.id}/members`)).json.data.invitations).toEqual([]);
    expect((await w.call(ownerA, "DELETE", `${libs(A)}/${l1.id}/invitations/${inv.id}`)).status).toBe(200);
    expect((await w.call(guest, "POST", "/v1/media/invitations/accept")).json.data.libraries).toEqual([]);

    await w.call(ownerA, "POST", `${libs(A)}/${l1.id}/invitations`, { email: guest.email, role: "viewer" });
    w.now = new Date(w.now.getTime() + 15 * 86_400_000);
    expect((await w.call(guest, "POST", "/v1/media/invitations/accept")).json.data.libraries).toEqual([]);
  });

  it("an org member who accepts an invitation joins as a member, never downgraded", async () => {
    const l1 = (await create(ownerA, A, "Team")).json.data.library;
    await w.call(ownerA, "PUT", `${libs(A)}/${l1.id}/members/${builderA.id}`, { role: "editor" });
    await w.call(ownerA, "POST", `${libs(A)}/${l1.id}/invitations`, { email: builderA.email, role: "viewer" });
    await w.call(builderA, "POST", "/v1/media/invitations/accept");
    const members = (await w.call(ownerA, "GET", `${libs(A)}/${l1.id}/members`)).json.data.members;
    expect(members.find((m: { principalId: string }) => m.principalId === builderA.id)).toMatchObject({ principalKind: "member", role: "editor" });
  });

  it("archiving hides the library from every route", async () => {
    const l1 = (await create(ownerA, A, "Old")).json.data.library;
    expect((await w.call(ownerA, "DELETE", `${libs(A)}/${l1.id}`)).status).toBe(200);
    expect((await w.call(ownerA, "GET", `${libs(A)}/${l1.id}`)).status).toBe(404);
    expect((await w.call(ownerA, "GET", libs(A))).json.data.libraries).toEqual([]);
  });

  describe("cross-org and cross-library isolation on every route", () => {
    let libA: { id: string };
    let libB: { id: string };
    beforeEach(async () => {
      libA = (await create(ownerA, A, "A private")).json.data.library;
      libB = (await create(ownerB, B, "B private")).json.data.library;
      await w.call(ownerA, "POST", `${libs(A)}/${libA.id}/invitations`, { email: guest.email, role: "viewer" });
      await w.call(guest, "POST", "/v1/media/invitations/accept");
    });

    const routes = (org: string, lib: string, principal: string) =>
      [
        ["GET", `/v1/organizations/${org}/libraries/${lib}`],
        ["PATCH", `/v1/organizations/${org}/libraries/${lib}`, { name: "pwned" }],
        ["DELETE", `/v1/organizations/${org}/libraries/${lib}`],
        ["GET", `/v1/organizations/${org}/libraries/${lib}/members`],
        ["PUT", `/v1/organizations/${org}/libraries/${lib}/members/${principal}`, { role: "manager" }],
        ["DELETE", `/v1/organizations/${org}/libraries/${lib}/members/${principal}`],
        ["POST", `/v1/organizations/${org}/libraries/${lib}/invitations`, { email: "x@example.test", role: "viewer" }],
        ["DELETE", `/v1/organizations/${org}/libraries/${lib}/invitations/${pub("lbi", crypto.randomUUID())}`],
      ] as [string, string, unknown?][];

    it("org B's owner gets 404 on every org-A route", async () => {
      for (const [method, path, body] of routes(A.pub, libA.id, ownerA.id)) {
        const r = await w.call(ownerB, method, path, body);
        expect([method, path, r.status]).toEqual([method, path, 404]);
      }
      expect((await w.call(ownerB, "GET", libs(A))).status).toBe(404);
      expect((await w.call(ownerB, "POST", libs(A), { name: "Sneaky" })).status).toBe(404);
    });

    it("an org-A library id under org B's path resolves nothing, even for org B's owner", async () => {
      for (const [method, path, body] of routes(B.pub, libA.id, ownerA.id)) {
        const r = await w.call(ownerB, method, path, body);
        expect([method, path, r.status]).toEqual([method, path, 404]);
      }
    });

    it("org A's owner can't reach org B's library through either path", async () => {
      for (const org of [A.pub, B.pub]) {
        for (const [method, path, body] of routes(org, libB.id, ownerB.id)) {
          const r = await w.call(ownerA, method, path, body);
          expect([method, path, r.status]).toEqual([method, path, 404]);
        }
      }
    });

    it("a guest of one library gets 404 on every other library's routes", async () => {
      const libA2 = (await create(ownerA, A, "A other")).json.data.library;
      for (const [method, path, body] of [...routes(A.pub, libA2.id, ownerA.id), ...routes(B.pub, libB.id, ownerB.id)]) {
        const r = await w.call(guest, method, path, body);
        expect([method, path, r.status]).toEqual([method, path, 404]);
      }
    });

    it("nothing was written across the boundary", () => {
      const rows = w.db.prepare(`SELECT org_id, name FROM media_libraries ORDER BY name`).all();
      expect(rows).toEqual([
        { org_id: A.id, name: "A private" },
        { org_id: B.id, name: "B private" },
      ]);
      const crossMembers = w.db
        .prepare(`SELECT COUNT(*) AS n FROM media_library_members m JOIN media_libraries l ON l.id = m.library_id WHERE l.org_id != m.org_id`)
        .get() as { n: number };
      expect(crossMembers.n).toBe(0);
    });

    it("every policy question names the library's own org and library", () => {
      for (const call of w.policyCalls) {
        if (call.resource.kind !== "library") continue;
        const lib = w.db.prepare(`SELECT org_id FROM media_libraries WHERE id = ?`).get(call.resource.id!) as { org_id: string } | undefined;
        expect(lib?.org_id).toBe(call.resource.orgId);
      }
    });
  });
});
