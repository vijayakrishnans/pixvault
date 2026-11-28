// PV7 (PV-46): a library's storage API, over the real router, the real storage-worker handler as the STORAGE_WORKER
// binding, and s3rver. Managers see, test, attach, re-check and detach a customer bucket; nobody else can; secrets
// never come back; storage changes only while the library is empty, under a lock no upload can slip past.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { jest } from "@jest/globals";
import { clearRowCache, handle as storageHandle, type Env as StorageEnv } from "@storage-worker/index";
import { forgetStore } from "@media-worker/storage/stores";
import { indexFor } from "@media-worker/index-do/client";
import { FakeDigestStream, World, sha256hex, type User } from "./harness.js";

jest.setTimeout(30_000);
beforeAll(() => {
  (globalThis as unknown as { crypto: { DigestStream?: unknown } }).crypto.DigestStream = FakeDigestStream;
});

describe("library storage API", () => {
  let server: { run(): Promise<{ port: number }>; close(): Promise<void> };
  let dir: string;
  let endpoint: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "pv-sapi-"));
    const S3rver = (await import("s3rver")).default as unknown as new (o: Record<string, unknown>) => typeof server;
    server = new S3rver({ port: 0, address: "127.0.0.1", silent: true, directory: dir, configureBuckets: [{ name: "team-bucket" }] });
    endpoint = `http://127.0.0.1:${(await server.run()).port}`;
  });
  afterAll(async () => {
    await server?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  let w: World;
  let owner: User, editor: User, outsider: User;
  let A: { id: string; pub: string; slug: string };
  let lib: { id: string; slug: string };
  let libId: string;
  let base: string;

  beforeEach(async () => {
    w = new World();
    A = w.newOrg();
    owner = w.newUser("owner");
    editor = w.newUser("editor");
    outsider = w.newUser("outsider");
    w.grant(A, owner, "owner");
    w.grant(A, editor, "builder");
    lib = (await w.call(owner, "POST", `/v1/organizations/${A.pub}/libraries`, { name: "Shots" })).json.data.library;
    base = `/v1/organizations/${A.pub}/libraries/${lib.id}`;
    await w.call(owner, "PUT", `${base}/members/${editor.id}`, { role: "editor" });
    const hex = lib.id.replace(/^lib_/, "");
    libId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    const sw: StorageEnv = { ENVIRONMENT: "test", PLATFORM_DB: w.env.PLATFORM_DB!, STORAGE_KEK: "d".repeat(64), ALLOW_TEST_ENDPOINTS: "true" };
    clearRowCache();
    forgetStore();
    w.env.STORAGE_WORKER = { fetch: (input: RequestInfo | URL, init?: RequestInit) => storageHandle(new Request(String(input), init), sw) } as unknown as Fetcher;
  });

  const bucket = (extra: Record<string, unknown> = {}) => ({ endpoint, region: "us-east-1", bucket: "team-bucket", prefix: "px", pathStyle: true, accessKeyId: "S3RVER", secretAccessKey: "S3RVER", ...extra });

  async function upload(user: User, name: string, bytes: Uint8Array) {
    const created = await w.call(user, "POST", `${base}/uploads`, { name, size: bytes.length, sha256: sha256hex(bytes), mime: "application/octet-stream" });
    if (created.status !== 201) return created;
    const s = created.json.data.session;
    await w.put(user, `${base}/uploads/${s.id}/parts/1`, bytes);
    return w.call(user, "POST", `${base}/uploads/${s.id}/commit`);
  }

  it("managers see managed storage; editors and outsiders get 404", async () => {
    const r = await w.call(owner, "GET", `${base}/storage`);
    expect(r.status).toBe(200);
    expect(r.json.data.current).toMatchObject({ kind: "managed-r2", status: "active" });
    expect(r.json.data.current.id).toMatch(/^stb_[0-9a-f]{32}$/);
    expect((await w.call(editor, "GET", `${base}/storage`)).status).toBe(404);
    expect((await w.call(outsider, "GET", `${base}/storage`)).status).toBe(404);
    expect((await w.call(editor, "POST", `${base}/storage`, bucket())).status).toBe(404);
  });

  it("a check reports each step; a non-public endpoint is refused as a field error; checks are limited per hour", async () => {
    const ok = await w.call(owner, "POST", `${base}/storage/check`, bucket());
    expect(ok.status).toBe(200);
    expect(ok.json.data.ok).toBe(true);
    expect(ok.json.data.steps).toHaveLength(5);
    const missing = await w.call(owner, "POST", `${base}/storage/check`, bucket({ bucket: "nope-bucket" }));
    expect(missing.json.data).toMatchObject({ ok: false, steps: [{ step: "put", code: "NoSuchBucket" }] });

    // Without the test switch, storage-worker refuses local addresses.
    w.env.STORAGE_WORKER = { fetch: (i: RequestInfo | URL, init?: RequestInit) => storageHandle(new Request(String(i), init), { ENVIRONMENT: "test", PLATFORM_DB: w.env.PLATFORM_DB!, STORAGE_KEK: "d".repeat(64) }) } as unknown as Fetcher;
    const ssrf = await w.call(owner, "POST", `${base}/storage/check`, bucket({ endpoint: "https://169.254.169.254" }));
    expect(ssrf.status).toBe(422);
    expect(ssrf.json.error.details.fields.endpoint).toBeDefined();
    for (let i = 3; i < 10; i++) await w.call(owner, "POST", `${base}/storage/check`, bucket({ endpoint: "https://127.0.0.1" }));
    expect((await w.call(owner, "POST", `${base}/storage/check`, bucket())).status).toBe(429);
  });

  it("attaching an empty library: files go to the bucket, nothing secret comes back, serving is told", async () => {
    const r = await w.call(owner, "POST", `${base}/storage`, bucket());
    expect(r.status).toBe(201);
    expect(r.json.data.backend).toMatchObject({ kind: "s3-compatible", bucket: "team-bucket", prefix: "px/", status: "active" });
    expect(JSON.stringify(r.json)).not.toContain("S3RVER");
    const view = await w.call(owner, "GET", `${base}/storage`);
    expect(view.json.data.current.id).toBe(r.json.data.backend.id);
    expect(JSON.stringify(view.json)).not.toMatch(/S3RVER|credential/);
    const map = JSON.parse(w.kv.get(`lib:${A.slug}/${lib.slug}`)!);
    expect(map.b.p).toBe("px/");

    const bytes = randomBytes(1200);
    const commit = await upload(editor, "a.bin", bytes);
    expect(commit.status).toBe(200);
    expect(w.bucket.objects.size).toBe(0);
    const got = await w.bytes(editor, `${base}/files/${commit.json.data.file.id}/content`);
    expect(Buffer.from(got.bytes).equals(bytes)).toBe(true);

    const recheck = await w.call(owner, "POST", `${base}/storage/${r.json.data.backend.id}/check`);
    expect(recheck.status).toBe(200);
    expect(recheck.json.data).toMatchObject({ ok: true, backend: { status: "active", lastError: null } });
  });

  it("a library with files can't change storage, and a failing bucket leaves it on managed storage, unlocked", async () => {
    const bad = await w.call(owner, "POST", `${base}/storage`, bucket({ bucket: "nope-bucket" }));
    expect(bad.status).toBe(409);
    expect(bad.json.error.code).toBe("bucket_check_failed");
    expect(bad.json.error.details.steps[0]).toMatchObject({ step: "put", code: "NoSuchBucket" });
    expect((await w.call(owner, "GET", `${base}/storage`)).json.data.current.kind).toBe("managed-r2");
    // the lock was released: uploads work, into managed R2
    expect((await upload(editor, "b.bin", randomBytes(300))).status).toBe(200);
    expect(w.bucket.objects.size).toBe(1);

    const busy = await w.call(owner, "POST", `${base}/storage`, bucket());
    expect(busy.status).toBe(409);
    expect(busy.json.error).toMatchObject({ code: "library_not_empty", details: { files: 1 } });
  });

  it("during a switch no upload can start or commit; a commit into a store that is no longer current is refused", async () => {
    const idx = indexFor(w.env, { orgId: A.id, libraryId: libId });
    const now = w.now;
    expect(await idx.call({ op: "beginStorageSwitch", nowIso: now.toISOString(), untilIso: new Date(now.getTime() + 60_000).toISOString() })).toMatchObject({ ok: true });
    const r = await w.call(editor, "POST", `${base}/uploads`, { name: "c.bin", size: 10, sha256: sha256hex(randomBytes(10)), mime: "application/octet-stream" });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("storage_changing");
    await idx.call({ op: "endStorageSwitch", backend: null });

    await expect(
      idx.call({ op: "commit", input: { fileId: crypto.randomUUID(), path: "/d.bin", name: "d.bin", folder: "/", size: 1, sha256: "a".repeat(64), mime: "application/octet-stream", visibility: "private", replace: false, objectKey: "k", actor: owner.id, nowIso: now.toISOString(), backend: "some-other-backend" } }),
    ).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("detaching an empty library goes back to managed storage; with files it is refused", async () => {
    const attached = (await w.call(owner, "POST", `${base}/storage`, bucket())).json.data.backend;
    const commit = await upload(editor, "e.bin", randomBytes(100));
    expect((await w.call(owner, "DELETE", `${base}/storage/${attached.id}`)).json.error.code).toBe("library_not_empty");
    await w.call(owner, "DELETE", `${base}/files/${commit.json.data.file.id}`);
    await w.call(owner, "DELETE", `${base}/files/${commit.json.data.file.id}?permanent=1`);
    const d = await w.call(owner, "DELETE", `${base}/storage/${attached.id}`);
    expect(d.status).toBe(200);
    expect((await w.call(owner, "GET", `${base}/storage`)).json.data.current.kind).toBe("managed-r2");
    expect(JSON.parse(w.kv.get(`lib:${A.slug}/${lib.slug}`)!).b).toBeUndefined();
    expect((await upload(editor, "f.bin", randomBytes(100))).status).toBe(200);
    expect(w.bucket.objects.size).toBe(1);
  });
});
