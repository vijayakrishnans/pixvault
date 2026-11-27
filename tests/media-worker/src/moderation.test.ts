// PV-23: held until safe, moderation outcomes, tags and the review queue. Synthetic bytes; the models are fakes.
import { randomBytes } from "node:crypto";
import { parseVerdict } from "@media-worker/pipeline/ai";
import { FakeDigestStream, World, sha256hex, type User } from "./harness.js";
import { jpegWithGps } from "./fixtures.js";

beforeAll(() => {
  (globalThis as unknown as { crypto: { DigestStream?: unknown } }).crypto.DigestStream = FakeDigestStream;
});

describe("parseVerdict", () => {
  it("reads fenced JSON, and anything unclear is never a pass", () => {
    expect(parseVerdict('```json\n{"verdict":"safe","categories":[]}\n```')).toEqual({ outcome: "pass", categories: [] });
    expect(parseVerdict('{"verdict":"unsafe","categories":["nudity","made_up"]}')).toEqual({ outcome: "fail", categories: ["nudity"] });
    expect(parseVerdict('{"verdict":"safe","categories":["violence_graphic"]}')).toEqual({ outcome: "fail", categories: ["violence_graphic"] });
    for (const t of ['{"verdict":"maybe"}', "I think it is fine", "{not json}", "", 42, null, undefined]) {
      expect(parseVerdict(t).outcome).toBe("error");
    }
  });
});

describe("moderation and review", () => {
  let w: World;
  let A: { id: string; pub: string; slug: string };
  let owner: User, editor: User, uploader: User, viewer: User;
  let base: string;

  beforeEach(async () => {
    w = new World();
    A = w.newOrg();
    owner = w.newUser("owner");
    w.grant(A, owner, "owner");
    const lib = (await w.call(owner, "POST", `/v1/organizations/${A.pub}/libraries`, { name: "Public" })).json.data.library;
    base = `/v1/organizations/${A.pub}/libraries/${lib.id}`;
    editor = w.newUser("editor");
    uploader = w.newUser("uploader");
    viewer = w.newUser("viewer");
    // Editors are org members with a library role; guests can only be uploaders or viewers.
    w.grant(A, editor, "builder");
    await w.call(owner, "PUT", `${base}/members/${editor.id}`, { role: "editor" });
    for (const [u, role] of [[uploader, "uploader"], [viewer, "viewer"]] as const) {
      await w.call(owner, "POST", `${base}/invitations`, { email: u.email, role });
      await w.call(u, "POST", "/v1/media/invitations/accept");
    }
  });

  async function upload(name: string, bytes: Uint8Array, mime: string, visibility: "public" | "private", who: User = owner) {
    const r = await w.call(who, "POST", `${base}/uploads`, { name, size: bytes.length, sha256: sha256hex(bytes), mime, visibility });
    if (r.status === 200) return r.json.data.file;
    const s = r.json.data.session;
    await w.put(who, `${base}/uploads/${s.id}/parts/1`, bytes);
    return (await w.call(who, "POST", `${base}/uploads/${s.id}/commit`)).json.data.file;
  }
  const get = async (id: string) => (await w.call(owner, "GET", `${base}/files/${id}`)).json.data.file;
  const routeOf = (fileId: string) => [...w.kv.values()].map((v) => JSON.parse(v)).find((r) => r.f && `fil_${r.f.replace(/-/g, "")}` === fileId);
  const moderationCalls = () => w.aiCalls.filter((c) => c.model === "@cf/test/moderation").length;

  it("a free-plan public image is served only after moderation passes, with tags", async () => {
    const f = await upload("ok.jpg", jpegWithGps(), "image/jpeg", "public");
    expect(f.url).toBeNull();
    await w.drain();
    expect(routeOf(f.id)).toMatchObject({ st: "processing" }); // serve-worker 404s this
    expect(await w.runPipelines()).toEqual(["public"]);
    const done = await get(f.id);
    expect(done).toMatchObject({ status: "public", moderation: "pass", tags: ["tabby cat", "lynx"] });
    expect(done.url).not.toBeNull();
    await w.drain();
    expect(routeOf(f.id)).toMatchObject({ st: "public" });
    expect(moderationCalls()).toBe(1);
  });

  it("an unsafe verdict flags the file; it isn't served and waits for review", async () => {
    w.aiVerdict = '{"verdict":"unsafe","categories":["sexual"]}';
    const f = await upload("bad.jpg", jpegWithGps(), "image/jpeg", "public");
    expect(await w.runPipelines()).toEqual(["flagged"]);
    const flagged = await get(f.id);
    expect(flagged).toMatchObject({ status: "flagged", moderation: "fail", pipelineNote: "flagged:sexual", url: null });
    await w.drain();
    expect(routeOf(f.id)).toMatchObject({ st: "flagged" });
    // It's in the review queue for editors and managers, and nobody else can see the queue.
    const q = await w.call(editor, "GET", `${base}/files?review=1`);
    expect(q.json.data.files.map((x: { id: string }) => x.id)).toEqual([f.id]);
    expect((await w.call(uploader, "GET", `${base}/files?review=1`)).status).toBe(404);
    expect((await w.call(viewer, "GET", `${base}/files?review=1`)).status).toBe(404);
    expect((await w.call(viewer, "POST", `${base}/files/${f.id}/review`, { decision: "approve" })).status).toBe(404);
  });

  it("approve serves it as its visibility says; reject moves it to the trash", async () => {
    w.aiVerdict = '{"verdict":"unsafe","categories":["violence_graphic"]}';
    const a = await upload("a.jpg", jpegWithGps(), "image/jpeg", "public");
    const b = await upload("b.jpg", jpegWithGps({ scan: new Uint8Array([7, 7]) }), "image/jpeg", "public");
    await w.runPipelines();
    const ok = await w.call(editor, "POST", `${base}/files/${a.id}/review`, { decision: "approve" });
    expect(ok.json.data.file).toMatchObject({ status: "public", moderation: "manual" });
    await w.drain();
    expect(routeOf(a.id)).toMatchObject({ st: "public" });
    const no = await w.call(editor, "POST", `${base}/files/${b.id}/review`, { decision: "reject" });
    expect(no.json.data.file.status).toBe("trashed");
    expect((await w.call(editor, "GET", `${base}/files?review=1`)).json.data.files).toEqual([]);
    expect((await w.call(editor, "POST", `${base}/files/${a.id}/review`, { decision: "approve" })).status).toBe(409);
    expect((await w.call(editor, "POST", `${base}/files/${a.id}/review`, { decision: "maybe" })).status).toBe(422);
  });

  it("an unreadable answer holds the file; a model that keeps failing holds it as failed, which must be replayed", async () => {
    w.aiVerdict = "Looks fine to me!";
    const f = await upload("u.jpg", jpegWithGps(), "image/jpeg", "public");
    expect(await w.runPipelines()).toEqual(["held"]);
    expect(await get(f.id)).toMatchObject({ status: "held", moderation: "error", pipelineNote: "moderation_unavailable" });
    expect(JSON.stringify(await get(f.id))).not.toContain("Looks fine"); // the model's text is never stored

    w.aiVerdict = new Error("AI capacity");
    const g = await upload("g.jpg", jpegWithGps({ scan: new Uint8Array([5]) }), "image/jpeg", "public");
    expect(await w.runPipelines()).toEqual(["failed"]);
    expect(await get(g.id)).toMatchObject({ status: "held", pipelineNote: "failed:moderate" });
    expect((await w.call(editor, "POST", `${base}/files/${g.id}/review`, { decision: "approve" })).status).toBe(409);
    w.aiVerdict = '{"verdict":"safe","categories":[]}';
    await w.call(editor, "POST", `${base}/files/${g.id}/reprocess`);
    expect(await w.runPipelines()).toEqual(["public"]);
  });

  it("private files and paid orgs aren't moderated; images are still tagged", async () => {
    const p = await upload("p.jpg", jpegWithGps(), "image/jpeg", "private");
    await w.runPipelines();
    expect(await get(p.id)).toMatchObject({ status: "private", moderation: "skipped", tags: ["tabby cat", "lynx"] });
    w.db.exec(`INSERT INTO billing_plans (id, code, name, price_amount_cents) VALUES ('pln_pro', 'pro', 'Pro', 1900)`);
    w.db.prepare(`INSERT INTO billing_subscriptions (id, org_id, billing_customer_id, plan_id, status) VALUES ('sub_1', ?, 'cus_1', 'pln_pro', 'active')`).run(A.id);
    const q = await upload("q.jpg", jpegWithGps({ scan: new Uint8Array([3]) }), "image/jpeg", "public");
    await w.runPipelines();
    expect(await get(q.id)).toMatchObject({ status: "public", moderation: "skipped" });
    expect(moderationCalls()).toBe(0);
  });

  it("a free-plan public non-image isn't moderated (not applicable) and is served after the run", async () => {
    const d = await upload("d.pdf", new Uint8Array(randomBytes(200)), "application/pdf", "public");
    expect(await w.runPipelines()).toEqual(["public"]);
    expect(await get(d.id)).toMatchObject({ moderation: "not_applicable", tags: [] });
  });

  it("switching an approved file private and public again doesn't moderate it twice", async () => {
    const f = await upload("s.jpg", jpegWithGps(), "image/jpeg", "public");
    await w.runPipelines();
    await w.call(owner, "PATCH", `${base}/files/${f.id}`, { visibility: "private" });
    const again = await w.call(owner, "PATCH", `${base}/files/${f.id}`, { visibility: "public" });
    expect(again.json.data.file.status).toBe("public");
    expect(moderationCalls()).toBe(1);
  });
});
