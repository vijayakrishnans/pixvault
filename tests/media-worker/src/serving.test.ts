// PV-16: the serving data plane. Library maps in KV, file routes through the index outbox, signed URLs.
import { createHash, randomBytes } from "node:crypto";
import { verifyPath } from "@saas/shared/media-signing";
import { FakeDigestStream, World, sha256hex, type User } from "./harness.js";

beforeAll(() => {
  (globalThis as unknown as { crypto: { DigestStream?: unknown } }).crypto.DigestStream = FakeDigestStream;
});

const routeKey = (libraryId: string, path: string) => `route:${libraryId}:${createHash("sha256").update(path).digest("hex")}`;
const uuidOf = (pub: string) => {
  const h = pub.split("_")[1]!;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

describe("serving data plane", () => {
  let w: World;
  let A: { id: string; pub: string; slug: string };
  let owner: User, guest: User;
  let lib: { id: string; slug: string };
  let libUuid: string;
  let base: string;

  beforeEach(async () => {
    w = new World();
    A = w.newOrg();
    owner = w.newUser("owner");
    guest = w.newUser("guest");
    w.grant(A, owner, "owner");
    lib = (await w.call(owner, "POST", `/v1/organizations/${A.pub}/libraries`, { name: "Brand assets" })).json.data.library;
    libUuid = uuidOf(lib.id);
    base = `/v1/organizations/${A.pub}/libraries/${lib.id}`;
  });

  async function upload(name: string, bytes: Uint8Array, extra: Record<string, unknown> = {}) {
    const s = (await w.call(owner, "POST", `${base}/uploads`, { name, size: bytes.length, sha256: sha256hex(bytes), mime: "image/png", ...extra })).json.data.session;
    await w.put(owner, `${base}/uploads/${s.id}/parts/1`, bytes);
    const committed = (await w.call(owner, "POST", `${base}/uploads/${s.id}/commit`)).json.data.file;
    // Images (and public files on a free plan) are served once the pipeline has run (PV4).
    await w.runPipelines();
    return (await w.call(owner, "GET", `${base}/files/${committed.id}`)).json.data.file;
  }

  const map = () => JSON.parse(w.kv.get(`lib:${A.slug}/${lib.slug}`) ?? "null");
  const route = (path: string) => JSON.parse(w.kv.get(routeKey(libUuid, path)) ?? "null");

  it("a new library publishes its map under its org slug, with a signing key; settings and archive follow", async () => {
    expect(map()).toMatchObject({ o: A.id, l: libUuid, v: "private", r: [], ia: [], ib: [], rnd: false, p: ["thumb", "small", "medium", "large"] });
    expect(Object.keys(map().k)).toEqual(["1"]);
    expect(map().k["1"]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await w.call(owner, "PATCH", base, { settings: { allowedReferrers: ["blog.example.test"], randomApiEnabled: true } });
    expect(map()).toMatchObject({ r: ["blog.example.test"], rnd: true });
    await w.call(owner, "DELETE", base);
    expect(map()).toBeNull();
  });

  it("the signing key never appears in an API response", async () => {
    const key = map().k["1"];
    const res = await w.call(owner, "GET", base);
    expect(JSON.stringify(res.json)).not.toContain(key);
  });

  it("a committed public file gets a route and a URL; trash, restore and visibility follow through the outbox", async () => {
    const bytes = randomBytes(500);
    const f = await upload("logo.png", bytes, { folder: "/brand", visibility: "public" });
    expect(f.url).toBe(`https://serve.test/${A.slug}/${lib.slug}/brand/logo.png`);
    expect(route("/brand/logo.png")).toBeNull(); // not until the outbox drains
    expect(await w.drain()).toBe(2); // the route while processing, then once public (PV4)
    expect(route("/brand/logo.png")).toMatchObject({ e: sha256hex(bytes), v: "public", st: "public", m: "image/png", s: 500, n: "logo.png", f: uuidOf(f.id) });

    await w.call(owner, "DELETE", `${base}/files/${f.id}`);
    await w.drain();
    expect(route("/brand/logo.png")).toBeNull();
    await w.call(owner, "POST", `${base}/files/${f.id}/restore`);
    await w.drain();
    expect(route("/brand/logo.png")).toMatchObject({ v: "public", st: "public" });

    const priv = await w.call(owner, "PATCH", `${base}/files/${f.id}`, { visibility: "private" });
    expect(priv.json.data.file).toMatchObject({ visibility: "private", status: "private", url: null });
    await w.drain();
    expect(route("/brand/logo.png")).toMatchObject({ v: "private", st: "private" });
    expect((await w.call(owner, "PATCH", `${base}/files/${f.id}`, { visibility: "world" })).status).toBe(422);
  });

  it("replacing a file updates its route's bytes", async () => {
    await upload("a.png", randomBytes(100), { visibility: "public" });
    const v2 = randomBytes(200);
    await upload("a.png", v2, { visibility: "public", replace: true });
    await w.drain();
    expect(route("/a.png")).toMatchObject({ e: sha256hex(v2), s: 200 });
  });

  it("signed URLs verify for their own path and expiry only", async () => {
    const f = await upload("secret.png", randomBytes(300)); // private by the library default
    expect(f.url).toBeNull();
    const r = await w.call(owner, "POST", `${base}/files/${f.id}/signed-url`, { expiresIn: 600 });
    expect(r.status).toBe(200);
    const u = new URL(r.json.data.url);
    expect(u.origin + u.pathname).toBe(`https://serve.test/${A.slug}/${lib.slug}/secret.png`);
    const exp = u.searchParams.get("exp")!;
    const sig = u.searchParams.get("sig")!;
    const keys = map().k;
    const now = Math.floor(w.now.getTime() / 1000);
    expect(Number(exp) - now).toBe(600);
    expect(await verifyPath(keys, libUuid, "/secret.png", exp, sig, now)).toBe("ok");
    expect(await verifyPath(keys, libUuid, "/other.png", exp, sig, now)).toBe("invalid");
    expect(await verifyPath(keys, "11111111-1111-4111-8111-111111111111", "/secret.png", exp, sig, now)).toBe("invalid");
    expect(await verifyPath(keys, libUuid, "/secret.png", String(Number(exp) + 1), sig, now)).toBe("invalid");
    expect(await verifyPath(keys, libUuid, "/secret.png", exp, sig.slice(0, -2) + (sig.endsWith("A") ? "BB" : "AA"), now)).toBe("invalid");
    expect(await verifyPath(keys, libUuid, "/secret.png", exp, sig, Number(exp) + 1)).toBe("expired");
    expect(await verifyPath({ "1": "x".repeat(43) }, libUuid, "/secret.png", exp, sig, now)).toBe("invalid"); // another library's key
    expect((await w.call(owner, "POST", `${base}/files/${f.id}/signed-url`, { expiresIn: 10 })).status).toBe(422);
  });

  it("a guest who can't read a file can't get a link to it", async () => {
    await w.call(owner, "POST", `${base}/invitations`, { email: guest.email, role: "uploader" });
    await w.call(guest, "POST", "/v1/media/invitations/accept");
    const f = await upload("owners.png", randomBytes(50));
    expect((await w.call(guest, "POST", `${base}/files/${f.id}/signed-url`, {})).status).toBe(404);
  });

  it("names beginning with '_' are reserved at a library's top level only", async () => {
    const sha = sha256hex(randomBytes(4));
    expect((await w.call(owner, "POST", `${base}/uploads`, { name: "_random", size: 1, sha256: sha })).status).toBe(422);
    expect((await w.call(owner, "POST", `${base}/uploads`, { name: "x.png", folder: "/_sys", size: 1, sha256: sha })).status).toBe(422);
    expect((await w.call(owner, "POST", `${base}/uploads`, { name: "_ok.png", folder: "/photos", size: 1, sha256: sha })).status).toBe(201);
  });

  it("a library from before PV3 gets its serving identity, map and routes the first time a member reads it", async () => {
    await upload("old.png", randomBytes(64), { visibility: "public" });
    await w.drain();
    // Simulate a pre-PV3 library: no org slug or key, no map, no routes.
    w.db.prepare(`UPDATE media_libraries SET org_slug = NULL, signing_key = NULL WHERE id = ?`).run(libUuid);
    w.kv.clear();
    // A guest can't read the org's slug, so nothing is filled in, but the request still works.
    await w.call(owner, "POST", `${base}/invitations`, { email: guest.email, role: "viewer" });
    // (The owner's invitation was itself a member read and filled everything in again: reset once more.)
    w.db.prepare(`UPDATE media_libraries SET org_slug = NULL, signing_key = NULL WHERE id = ?`).run(libUuid);
    w.kv.clear();
    await w.call(guest, "POST", "/v1/media/invitations/accept");
    expect((await w.call(guest, "GET", base)).status).toBe(200);
    expect(map()).toBeNull();
    // A member's read fills it in and re-publishes every route.
    expect((await w.call(owner, "GET", base)).status).toBe(200);
    expect(map()).toMatchObject({ l: libUuid });
    await w.drain();
    expect(route("/old.png")).toMatchObject({ v: "public" });
  });
});
