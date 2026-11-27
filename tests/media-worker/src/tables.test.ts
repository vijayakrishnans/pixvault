// Tenancy on every PV1 table: every media_ table carries a NOT NULL org_id, and every repository method scoped to
// org A returns nothing for org B's rows.

import { createSqlExecutor } from "@saas/db/d1";
import { createMediaRepository, managedPrefix } from "@saas/db/media";
import { d1Over, migratedDatabase } from "./harness.js";

const ORG_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG_B = "bbbbbbbb-0000-4000-8000-000000000002";

describe("media control tables", () => {
  const db = migratedDatabase();
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'media_%' ORDER BY name`).all() as { name: string }[]).map(
    (t) => t.name,
  );

  it("are all created by the media migrations (200, 210)", () => {
    expect(tables).toEqual([
      "media_abuse_cases",
      "media_dav_credentials",
      "media_domains",
      "media_import_jobs",
      "media_libraries",
      "media_library_invitations",
      "media_library_members",
      "media_org_limits",
      "media_serve_routes",
      "media_share_links",
      "media_storage_backends",
      "media_upload_links",
      "media_usage",
    ]);
  });

  it.each(tables.map((t) => [t]))("%s has org_id NOT NULL", (table) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; notnull: number }[];
    expect(cols.find((c) => c.name === "org_id")).toMatchObject({ notnull: 1 });
  });

  it("a guest row can't hold manager or editor (CHECK constraint)", () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO media_library_members (org_id, library_id, principal_kind, principal_id, role, created_by) VALUES ('o', 'l', 'guest', 'u', 'editor', 'c')`,
        )
        .run(),
    ).toThrow();
  });
});

describe("media repository is org-scoped on every method", () => {
  const db = migratedDatabase();
  const repo = createMediaRepository(createSqlExecutor(d1Over(db)));
  const LIB = "cccccccc-0000-4000-8000-000000000003";
  const now = new Date("2026-11-27T10:00:00.000Z");

  beforeAll(async () => {
    const r = await repo.createLibrary({
      id: LIB,
      orgId: ORG_A,
      projectId: "dddddddd-0000-4000-8000-000000000004",
      slug: "a",
      name: "A",
      visibilityDefault: "private",
      everyoneInOrg: false,
      settingsJson: "{}",
      createdBy: "creator",
      creator: { principalId: "usr_a", email: "a@example.test" },
      storageBackendId: "eeeeeeee-0000-4000-8000-000000000005",
      createdAt: now,
    });
    expect(r.ok).toBe(true);
    await repo.createInvitation({
      id: "ffffffff-0000-4000-8000-000000000006",
      orgId: ORG_A,
      libraryId: LIB,
      emailLower: "g@example.test",
      role: "viewer",
      createdBy: "creator",
      createdAt: now,
      expiresAt: new Date(now.getTime() + 86_400_000),
    });
  });

  it("org A sees its rows", async () => {
    expect((await repo.getLibrary(ORG_A, LIB)).ok).toBe(true);
    expect(await repo.listMembers(ORG_A, LIB)).toMatchObject({ ok: true, value: [{ principalId: "usr_a", role: "manager" }] });
    expect(await repo.getStorageBackend(ORG_A, LIB)).toMatchObject({ ok: true, value: { prefix: managedPrefix(ORG_A, LIB) } });
  });

  it("org B sees none of them", async () => {
    expect(await repo.getLibrary(ORG_B, LIB)).toMatchObject({ ok: false, error: { kind: "not_found" } });
    expect(await repo.listLibraries(ORG_B)).toEqual({ ok: true, value: [] });
    expect(await repo.listMembers(ORG_B, LIB)).toEqual({ ok: true, value: [] });
    expect(await repo.listPrincipalRoles(ORG_B, "usr_a")).toEqual({ ok: true, value: [] });
    expect(await repo.listOpenInvitations(ORG_B, LIB, now)).toEqual({ ok: true, value: [] });
    expect(await repo.getStorageBackend(ORG_B, LIB)).toMatchObject({ ok: false, error: { kind: "not_found" } });
    expect(await repo.countManagers(ORG_B, LIB)).toEqual({ ok: true, value: 0 });
    expect(await repo.updateLibrary(ORG_B, LIB, { name: "x", updatedAt: now })).toMatchObject({ ok: false });
    expect(await repo.archiveLibrary(ORG_B, LIB, now)).toMatchObject({ ok: false });
    expect(await repo.removeMember(ORG_B, LIB, "usr_a")).toMatchObject({ ok: false });
    expect(await repo.revokeInvitation(ORG_B, LIB, "ffffffff-0000-4000-8000-000000000006", now)).toMatchObject({ ok: false });
    // and org A's rows are untouched
    expect(await repo.getLibrary(ORG_A, LIB)).toMatchObject({ ok: true, value: { name: "A", status: "active" } });
    expect((await repo.listMembers(ORG_A, LIB)).ok && (await repo.listMembers(ORG_A, LIB))).toMatchObject({ value: [{ principalId: "usr_a" }] });
  });
});
