// PV-25: abuse reports, takedown, reinstate, org suspension, operators only. Synthetic bytes.
import { randomBytes } from "node:crypto";
import { FakeDigestStream, World, sha256hex, type User } from "./harness.js";

beforeAll(() => {
  (globalThis as unknown as { crypto: { DigestStream?: unknown } }).crypto.DigestStream = FakeDigestStream;
});

const uuidOf = (pub: string) => {
  const h = pub.split("_")[1]!;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

describe("abuse handling", () => {
  let w: World;
  let A: { id: string; pub: string; slug: string };
  let owner: User, operator: User;
  let lib: { id: string; slug: string };
  let base: string;
  let file: { id: string; sha256: string };

  beforeEach(async () => {
    w = new World();
    A = w.newOrg();
    owner = w.newUser("owner");
    operator = w.newUser("operator");
    w.grant(A, owner, "owner");
    lib = (await w.call(owner, "POST", `/v1/organizations/${A.pub}/libraries`, { name: "Public stuff" })).json.data.library;
    base = `/v1/organizations/${A.pub}/libraries/${lib.id}`;
    file = await upload("thing.bin", new Uint8Array(randomBytes(400)));
  });

  async function upload(name: string, bytes: Uint8Array) {
    const s = (await w.call(owner, "POST", `${base}/uploads`, { name, size: bytes.length, sha256: sha256hex(bytes), mime: "application/octet-stream", visibility: "public" })).json.data.session;
    await w.put(owner, `${base}/uploads/${s.id}/parts/1`, bytes);
    const f = (await w.call(owner, "POST", `${base}/uploads/${s.id}/commit`)).json.data.file;
    await w.runPipelines(); // public on a free plan: checked first
    return (await w.call(owner, "GET", `${base}/files/${f.id}`)).json.data.file;
  }
  const report = (overrides: Record<string, unknown> = {}) =>
    w.call(null, "POST", "/v1/media/abuse-reports", {
      orgId: A.id,
      libraryId: uuidOf(lib.id),
      fileId: uuidOf(file.id),
      sha256: file.sha256,
      category: "copyright",
      details: "This is my photo",
      email: "Reporter@Example.test",
      ...overrides,
    });
  const makeOperator = () => w.db.prepare(`INSERT INTO platform_media_operators (subject_id) VALUES (?)`).run(operator.id);
  const route = () => [...w.kv.entries()].filter(([k]) => k.startsWith("route:")).map(([, v]) => JSON.parse(v)).find((r) => r.f === uuidOf(file.id));
  const map = () => JSON.parse(w.kv.get(`lib:${A.slug}/${lib.slug}`) ?? "null");

  it("a report opens one case per file; repeats add to its count", async () => {
    expect((await report()).status).toBe(202);
    expect((await report({ category: "spam", email: null })).status).toBe(202);
    const rows = w.db.prepare(`SELECT report_count, reason AS category, reporter_email FROM media_abuse_cases`).all() as { report_count: number; category: string; reporter_email: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ report_count: 2, category: "copyright", reporter_email: "reporter@example.test" });
  });

  it("a report must name a real file in that library with its bytes", async () => {
    expect((await report({ sha256: "0".repeat(64) })).status).toBe(404);
    expect((await report({ fileId: "11111111-1111-4111-8111-111111111111" })).status).toBe(404);
    expect((await report({ libraryId: "22222222-2222-4222-8222-222222222222" })).status).toBe(404);
    expect((await report({ category: "boring" })).status).toBe(422);
    expect((await report({ email: "not an email" })).status).toBe(422);
  });

  it("admin routes are 404 for everyone who isn't a platform operator, the org's owner included", async () => {
    await report();
    for (const u of [owner, operator]) {
      expect((await w.call(u, "GET", "/v1/media/admin/abuse-cases")).status).toBe(404);
      expect((await w.call(u, "POST", `/v1/media/admin/organizations/${A.pub}/suspend`, {})).status).toBe(404);
      expect((await w.call(u, "POST", `/v1/media/admin/organizations/${A.pub}/libraries/${lib.id}/files/${file.id}/takedown`, {})).status).toBe(404);
      expect((await w.call(u, "GET", "/v1/media/admin/pipeline-failures")).status).toBe(404);
    }
    expect(w.db.prepare(`SELECT status FROM media_abuse_cases`).get()).toMatchObject({ status: "open" });
  });

  it("operators see cases, CSAM first, with a short-lived link to the file", async () => {
    makeOperator();
    await report();
    const other = await upload("other.bin", new Uint8Array(randomBytes(300)));
    await w.call(null, "POST", "/v1/media/abuse-reports", { orgId: A.id, libraryId: uuidOf(lib.id), fileId: uuidOf(other.id), sha256: other.sha256, category: "csam" });
    const cases = (await w.call(operator, "GET", "/v1/media/admin/abuse-cases")).json.data.cases;
    expect(cases.map((c: { category: string }) => c.category)).toEqual(["csam", "copyright"]);
    expect(cases[1]).toMatchObject({ fileId: file.id, fileName: "thing.bin", reportCount: 1, status: "open", fileStatus: "public" });
    expect(cases[1].viewUrl).toMatch(/\?exp=\d+&sig=/);
  });

  it("taking down a case's file makes serving answer 451, blocks replacing it, and can be undone", async () => {
    makeOperator();
    await report();
    const caseId = (await w.call(operator, "GET", "/v1/media/admin/abuse-cases")).json.data.cases[0].id;
    const r = await w.call(operator, "POST", `/v1/media/admin/abuse-cases/${caseId}/takedown`, { note: "valid claim" });
    expect(r.json.data.case).toMatchObject({ status: "actioned", fileStatus: "removed", decisionNote: "valid claim" });
    await w.drain();
    expect(route()).toMatchObject({ st: "removed" });
    expect((await w.call(owner, "GET", `${base}/files/${file.id}`)).json.data.file).toMatchObject({ status: "removed", url: null });
    // The owner can't put new bytes at the same path, nor restore an old version over it.
    const again = await w.call(owner, "POST", `${base}/uploads`, { name: "thing.bin", size: 3, sha256: sha256hex(new Uint8Array([1, 2, 3])), replace: true, mime: "application/octet-stream" });
    expect(again.json.error?.details?.reason ?? again.json.error?.reason).toBe("taken_down");
    expect((await w.call(operator, "POST", `/v1/media/admin/abuse-cases/${caseId}/dismiss`, {})).status).toBe(409);
    const events = w.db.prepare(`SELECT type FROM events_event_log WHERE type LIKE 'file.%'`).all() as { type: string }[];
    expect(events.map((e) => e.type)).toContain("file.taken_down");

    const back = await w.call(operator, "POST", `/v1/media/admin/organizations/${A.pub}/libraries/${lib.id}/files/${file.id}/reinstate`, {});
    expect(back.json.data.status).toBe("public");
    await w.drain();
    expect(route()).toMatchObject({ st: "public" });
  });

  it("a dismissed case leaves the file alone", async () => {
    makeOperator();
    await report();
    const caseId = (await w.call(operator, "GET", "/v1/media/admin/abuse-cases")).json.data.cases[0].id;
    expect((await w.call(operator, "POST", `/v1/media/admin/abuse-cases/${caseId}/dismiss`, {})).json.data.case.status).toBe("dismissed");
    expect((await w.call(owner, "GET", `${base}/files/${file.id}`)).json.data.file.status).toBe("public");
  });

  it("suspending an org marks every library's serving map and stops uploads; lifting it restores both", async () => {
    makeOperator();
    const r = await w.call(operator, "POST", `/v1/media/admin/organizations/${A.pub}/suspend`, { reason: "repeated abuse" });
    expect(r.json.data).toMatchObject({ suspended: true, libraries: 1 });
    expect(map()).toMatchObject({ s: "suspended" });
    const up = await w.call(owner, "POST", `${base}/uploads`, { name: "n.bin", size: 1, sha256: sha256hex(new Uint8Array([1])) });
    expect(up.status).toBe(423);
    // A settings change while suspended doesn't lift it from serving.
    await w.call(owner, "PATCH", base, { settings: { randomApiEnabled: true } });
    expect(map()).toMatchObject({ s: "suspended", rnd: true });
    await w.call(operator, "POST", `/v1/media/admin/organizations/${A.pub}/unsuspend`, {});
    expect(map().s).toBeUndefined();
    expect((await w.call(owner, "POST", `${base}/uploads`, { name: "n.bin", size: 1, sha256: sha256hex(new Uint8Array([1])) })).status).toBe(201);
  });
});
