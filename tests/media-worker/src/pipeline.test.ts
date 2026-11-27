// PV-22: ProcessFileWorkflow over the real index, D1 and fakes for R2, Images and Workflows. Synthetic bytes only.
import { randomBytes } from "node:crypto";
import { jpegHasGps } from "@media-worker/pipeline/metadata";
import { FakeDigestStream, World, sha256hex, type User } from "./harness.js";
import { jpegWithGps } from "./fixtures.js";

beforeAll(() => {
  (globalThis as unknown as { crypto: { DigestStream?: unknown } }).crypto.DigestStream = FakeDigestStream;
});

const uuidOf = (pub: string) => {
  const h = pub.split("_")[1]!;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

describe("file pipeline", () => {
  let w: World;
  let A: { id: string; pub: string; slug: string };
  let owner: User;
  let base: string;

  beforeEach(async () => {
    w = new World();
    A = w.newOrg();
    owner = w.newUser("owner");
    w.grant(A, owner, "owner");
    const lib = (await w.call(owner, "POST", `/v1/organizations/${A.pub}/libraries`, { name: "Photos" })).json.data.library;
    base = `/v1/organizations/${A.pub}/libraries/${lib.id}`;
  });

  async function upload(name: string, bytes: Uint8Array, mime: string, extra: Record<string, unknown> = {}) {
    const r = await w.call(owner, "POST", `${base}/uploads`, { name, size: bytes.length, sha256: sha256hex(bytes), mime, ...extra });
    if (r.status === 200) return r.json.data.file; // deduplicated: committed without bytes
    const s = r.json.data.session;
    await w.put(owner, `${base}/uploads/${s.id}/parts/1`, bytes);
    return (await w.call(owner, "POST", `${base}/uploads/${s.id}/commit`)).json.data.file;
  }
  const getFile = async (id: string) => (await w.call(owner, "GET", `${base}/files/${id}`)).json.data.file;
  const storedBytesOf = (sha: string) => [...w.bucket.objects.entries()].find(([k]) => k.endsWith(`s-${sha}`))?.[1].bytes;

  it("an image is processing until its run finishes, then its location data is gone from storage", async () => {
    const src = jpegWithGps();
    const f = await upload("beach.jpg", src, "image/jpeg", { visibility: "private" });
    expect(f.status).toBe("processing");
    expect(w.workflows).toHaveLength(1);
    expect(w.workflows[0]!.params).toMatchObject({ fileId: uuidOf(f.id), sha256: sha256hex(src), requireSafety: false });

    expect(await w.runPipelines()).toEqual(["private"]);
    const done = await getFile(f.id);
    expect(done).toMatchObject({ status: "private", width: 32, height: 24, pipelineNote: "removed:exif.gps,xmp.gps" });
    expect(done.sha256).not.toBe(sha256hex(src));
    const stored = storedBytesOf(done.sha256)!;
    expect(jpegHasGps(stored)).toBe(false);
    // The original object is gone (no other file shared it); only the cleaned copy remains.
    expect([...w.bucket.objects.values()].some((o) => jpegHasGps(o.bytes))).toBe(false);
    // Download serves the cleaned bytes.
    const dl = await w.bytes(owner, `${base}/files/${f.id}/content`);
    expect(dl.status).toBe(200);
    expect(jpegHasGps(dl.bytes)).toBe(false);
  });

  it("the route is published only when processing ends", async () => {
    const f = await upload("p.jpg", jpegWithGps(), "image/jpeg", { visibility: "public" });
    await w.drain();
    const routeOf = () => [...w.kv.entries()].find(([k]) => k.startsWith("route:"))?.[1];
    expect(JSON.parse(routeOf()!)).toMatchObject({ st: "processing" }); // serve-worker 404s anything not public/private
    await w.runPipelines();
    await w.drain();
    expect(JSON.parse(routeOf()!)).toMatchObject({ st: "public", e: (await getFile(f.id)).sha256 });
  });

  it("files that need no processing are served at once", async () => {
    // A private PDF on a free plan: not an image, not public.
    const f = await upload("notes.pdf", new Uint8Array(randomBytes(300)), "application/pdf", { visibility: "private" });
    expect(f.status).toBe("private");
    expect(w.workflows).toHaveLength(0);
  });

  it("a public upload on a free plan goes through the pipeline even when it isn't an image; a paid org's doesn't", async () => {
    const f = await upload("deck.pdf", new Uint8Array(randomBytes(300)), "application/pdf", { visibility: "public" });
    expect(f.status).toBe("processing");
    expect(w.workflows.at(-1)!.params.requireSafety).toBe(true);
    await w.runPipelines();
    expect((await getFile(f.id)).status).toBe("public");

    w.db.exec(`INSERT INTO billing_plans (id, code, name, price_amount_cents) VALUES ('pln_pro', 'pro', 'Pro', 1900)`);
    w.db.prepare(`INSERT INTO billing_subscriptions (id, org_id, billing_customer_id, plan_id, status) VALUES ('sub_1', ?, 'cus_1', 'pln_pro', 'active')`).run(A.id);
    const g = await upload("deck2.pdf", new Uint8Array(randomBytes(300)), "application/pdf", { visibility: "public" });
    expect(g.status).toBe("public");
  });

  it("a shared original is kept while another file still uses it", async () => {
    const src = jpegWithGps();
    const a = await upload("a.jpg", src, "image/jpeg", { visibility: "private" });
    const b = await upload("b.jpg", src, "image/jpeg", { visibility: "private" }); // deduplicated against a
    expect(b.status).toBe("processing");
    // Run only a's pipeline: b still points at the original, which must survive.
    const one = w.workflows.splice(1);
    await w.runPipelines();
    expect((await getFile(a.id)).sha256).not.toBe(sha256hex(src));
    expect((await getFile(b.id)).sha256).toBe(sha256hex(src));
    expect([...w.bucket.objects.values()].some((o) => jpegHasGps(o.bytes))).toBe(true);
    w.workflows.push(...one);
    await w.runPipelines();
    // Both now share the one cleaned blob, and the original is gone.
    expect((await getFile(b.id)).sha256).toBe((await getFile(a.id)).sha256);
    expect([...w.bucket.objects.values()].some((o) => jpegHasGps(o.bytes))).toBe(false);
  });

  it("storage usage follows the swap", async () => {
    const src = jpegWithGps();
    await upload("u.jpg", src, "image/jpeg", { visibility: "private" });
    const usage = async () => (await w.call(owner, "GET", `/v1/organizations/${A.pub}/media-usage`)).json.data.usage.storageBytes;
    expect(await usage()).toBe(src.length);
    await w.runPipelines();
    const cleaned = [...w.bucket.objects.values()][0]!.bytes.length;
    expect(cleaned).toBeLessThan(src.length);
    expect(await usage()).toBe(cleaned);
  });

  it("a run that keeps failing holds the file and records the failure; a replay runs it again", async () => {
    const f = await upload("x.jpg", jpegWithGps(), "image/jpeg", { visibility: "public" });
    const realGet = w.bucket.get.bind(w.bucket);
    w.bucket.get = async () => {
      throw new Error("R2 unavailable");
    };
    expect(await w.runPipelines()).toEqual(["failed"]);
    w.bucket.get = realGet;
    const held = await getFile(f.id);
    expect(held).toMatchObject({ status: "held", pipelineNote: "failed:strip", url: null });
    const failures = (await w.call(owner, "GET", `${base}/pipeline-failures`)).json.data.failures;
    expect(failures).toEqual([expect.objectContaining({ fileId: f.id, step: "strip" })]);
    expect(JSON.stringify(failures)).not.toMatch(/R2 unavailable|https?:/); // ids and step names only

    const r = await w.call(owner, "POST", `${base}/files/${f.id}/reprocess`);
    expect(r.status).toBe(200);
    expect(r.json.data.file.status).toBe("processing");
    expect(await w.runPipelines()).toEqual(["public"]);
    expect((await w.call(owner, "GET", `${base}/pipeline-failures`)).json.data.failures).toEqual([]);
    expect((await w.call(owner, "POST", `${base}/files/${f.id}/reprocess`)).status).toBe(409); // not held any more
  });

  it("a run for bytes that were replaced meanwhile does nothing", async () => {
    await upload("r.jpg", jpegWithGps(), "image/jpeg", { visibility: "private" });
    const v2 = jpegWithGps({ scan: new Uint8Array([9, 9, 9]) });
    await upload("r.jpg", v2, "image/jpeg", { visibility: "private", replace: true });
    expect(await w.runPipelines()).toEqual(["stale", "private"]);
  });

  it("making a private file public on a free plan checks it first", async () => {
    const f = await upload("doc.pdf", new Uint8Array(randomBytes(100)), "application/pdf", { visibility: "private" });
    const r = await w.call(owner, "PATCH", `${base}/files/${f.id}`, { visibility: "public" });
    expect(r.json.data.file).toMatchObject({ status: "processing", url: null });
    expect(await w.runPipelines()).toEqual(["public"]);
  });

  it("a lost start leaves the file unserved; it is never served unchecked", async () => {
    w.failWorkflowStarts = true;
    const f = await upload("lost.jpg", jpegWithGps(), "image/jpeg", { visibility: "public" });
    expect(f.status).toBe("processing");
    expect(w.workflows).toHaveLength(0);
    expect((await getFile(f.id)).url).toBeNull();
  });
});
