// PV-17: serve-worker. Library isolation, signatures, presets, access rules, ranges, cache, random API, analytics.
import { createHash, randomBytes } from "node:crypto";
import { newSigningKey, signPath } from "@saas/shared/media-signing";
import { clearMapMemo, parsePath, serve } from "@serve-worker/serve";
import { ipAllowed, ipMatches, referrerAllowed } from "@serve-worker/rules";
import { FakeCache, world, type World } from "./fakes.js";

const H = "https://serve.test";
const NOW = 1_800_000_000_000;
const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");

interface Lib {
  org: string;
  slug: string;
  orgId: string;
  id: string;
  key: string;
}

function addLibrary(w: World, org: string, slug: string, extra: Record<string, unknown> = {}): Lib {
  const lib = { org, slug, orgId: crypto.randomUUID(), id: crypto.randomUUID(), key: newSigningKey() };
  w.kv.data.set(
    `lib:${org}/${slug}`,
    JSON.stringify({ o: lib.orgId, l: lib.id, v: "private", k: { "1": lib.key }, r: [], ia: [], ib: [], rnd: false, p: ["thumb", "small", "medium", "large"], ...extra }),
  );
  return lib;
}

function addFile(w: World, lib: Lib, path: string, opts: { bytes?: Uint8Array; mime?: string; v?: "public" | "private"; st?: string } = {}) {
  const bytes = opts.bytes ?? randomBytes(1000);
  const e = sha(bytes);
  const k = `org/${lib.orgId}/lib/${lib.id}/blob/${crypto.randomUUID()}`;
  w.r2.objects.set(k, bytes);
  const v = opts.v ?? "public";
  w.kv.data.set(
    `route:${lib.id}:${sha(path)}`,
    JSON.stringify({ k, m: opts.mime ?? "image/png", s: bytes.length, e, v, st: opts.st ?? v, n: path.split("/").pop(), f: crypto.randomUUID() }),
  );
  return { bytes, e, k };
}

const get = (w: World, path: string, headers: Record<string, string> = {}, deps: Parameters<typeof serve>[2] = {}) =>
  serve(new Request(`${H}${path}`, { headers }), w.env, { now: () => NOW, ...deps });

let w: World;
beforeEach(() => {
  clearMapMemo();
  w = world();
});

describe("public serving", () => {
  it("serves a public file's bytes with its type, etag and safe headers", async () => {
    const A = addLibrary(w, "acme", "brand");
    const f = addFile(w, A, "/logos/mark.png");
    const r = await get(w, "/acme/brand/logos/mark.png");
    expect(r.status).toBe(200);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(new Uint8Array(f.bytes));
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(r.headers.get("etag")).toBe(`"${f.e}"`);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-security-policy")).toContain("sandbox");
    expect(r.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(r.headers.get("cache-control")).toMatch(/^public/);
  });

  it("decodes encoded segments and refuses traversal and malformed paths", async () => {
    const A = addLibrary(w, "acme", "brand");
    addFile(w, A, "/my photos/a b.png");
    expect((await get(w, "/acme/brand/my%20photos/a%20b.png")).status).toBe(200);
    expect(parsePath("/acme/brand/%2e%2e/x")).toBeNull();
    expect(parsePath("/acme/brand/a%2Fb")).toBeNull();
    expect(parsePath("/acme/brand/%E0%A4%A")).toBeNull();
    expect(parsePath("/acme/brand/a%00b")).toBeNull();
    expect(parsePath("/acme/brand")).toBeNull();
    expect(parsePath("/Acme/brand/x")).toBeNull();
  });

  it("HTML, SVG and other active types download instead of rendering", async () => {
    const A = addLibrary(w, "acme", "brand");
    addFile(w, A, "/x.svg", { mime: "image/svg+xml" });
    addFile(w, A, "/x.html", { mime: "text/html" });
    for (const p of ["/x.svg", "/x.html"]) {
      const r = await get(w, `/acme/brand${p}`);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-disposition")).toMatch(/^attachment;/);
      expect(r.headers.get("content-security-policy")).toContain("sandbox");
    }
  });

  it("files that are processing, held or flagged are not served", async () => {
    const A = addLibrary(w, "acme", "brand");
    for (const st of ["processing", "held", "flagged"]) {
      addFile(w, A, `/${st}.png`, { st });
      expect((await get(w, `/acme/brand/${st}.png`)).status).toBe(404);
    }
  });

  it("an unknown library, file or method is 404 / 405", async () => {
    addLibrary(w, "acme", "brand");
    expect((await get(w, "/acme/other/x.png")).status).toBe(404);
    expect((await get(w, "/acme/brand/missing.png")).status).toBe(404);
    expect((await serve(new Request(`${H}/acme/brand/x.png`, { method: "POST" }), w.env)).status).toBe(405);
  });
});

describe("library isolation", () => {
  it("a file in library A can't be served through library B's path, even in the same org or with A's signature", async () => {
    const A = addLibrary(w, "acme", "brand");
    const B = addLibrary(w, "acme", "other");
    const C = addLibrary(w, "rival", "brand");
    addFile(w, A, "/shared-name.png");
    const priv = addFile(w, A, "/secret.png", { v: "private" });
    void priv;
    expect((await get(w, "/acme/brand/shared-name.png")).status).toBe(200);
    expect((await get(w, "/acme/other/shared-name.png")).status).toBe(404);
    expect((await get(w, "/rival/brand/shared-name.png")).status).toBe(404);
    const exp = NOW / 1000 + 600;
    const sig = await signPath(A.key, 1, A.id, "/secret.png", exp);
    expect((await get(w, `/acme/brand/secret.png?exp=${exp}&sig=${encodeURIComponent(sig)}`)).status).toBe(200);
    expect((await get(w, `/acme/other/secret.png?exp=${exp}&sig=${encodeURIComponent(sig)}`)).status).toBe(404);
    void B;
    void C;
  });
});

describe("private files", () => {
  let A: Lib;
  beforeEach(() => {
    A = addLibrary(w, "acme", "brand");
    addFile(w, A, "/private/doc.png", { v: "private" });
  });
  const exp = NOW / 1000 + 600;

  it("serve only with a valid signature, never cached publicly", async () => {
    const sig = await signPath(A.key, 1, A.id, "/private/doc.png", exp);
    const cache = new FakeCache();
    const r = await get(w, `/acme/brand/private/doc.png?exp=${exp}&sig=${encodeURIComponent(sig)}`, {}, { cache: cache as unknown as Cache });
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
    expect(cache.store.size).toBe(0);
  });

  it("a missing, forged, altered or other-path signature is 404; an expired one is 410", async () => {
    const sig = await signPath(A.key, 1, A.id, "/private/doc.png", exp);
    const other = await signPath(A.key, 1, A.id, "/private/other.png", exp);
    const forged = await signPath(newSigningKey(), 1, A.id, "/private/doc.png", exp);
    const flipped = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
    const u = (e: number, s: string) => `/acme/brand/private/doc.png?exp=${e}&sig=${encodeURIComponent(s)}`;
    expect((await get(w, "/acme/brand/private/doc.png")).status).toBe(404);
    expect((await get(w, u(exp, forged))).status).toBe(404);
    expect((await get(w, u(exp, flipped))).status).toBe(404);
    expect((await get(w, u(exp, other))).status).toBe(404);
    expect((await get(w, u(exp + 1, sig))).status).toBe(404);
    expect((await get(w, `/acme/brand/private/doc.png?exp=${exp}&sig=9.${sig.split(".")[1]}`)).status).toBe(404);
    const old = await signPath(A.key, 1, A.id, "/private/doc.png", NOW / 1000 - 1);
    expect((await get(w, u(NOW / 1000 - 1, old))).status).toBe(410);
    expect(w.r2.gets).toEqual([]); // nothing was read from storage for a refused request
  });
});

describe("presets", () => {
  let A: Lib;
  beforeEach(() => {
    A = addLibrary(w, "acme", "brand", { p: ["thumb", "small"] });
    addFile(w, A, "/p.jpg", { mime: "image/jpeg" });
    addFile(w, A, "/doc.pdf", { mime: "application/pdf" });
  });

  it("an allowed preset transforms through the Images binding to the best accepted format", async () => {
    const r = await get(w, "/acme/brand/p.jpg?preset=thumb", { accept: "image/avif,image/webp,*/*" });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/avif");
    expect(await r.text()).toBe("transformed:image/avif");
    expect(w.images.calls).toEqual([{ opts: { width: 200, height: 200, fit: "cover" }, format: "image/avif" }]);
    const r2 = await get(w, "/acme/brand/p.jpg?preset=small", { accept: "image/webp" });
    expect(r2.headers.get("content-type")).toBe("image/webp");
    const r3 = await get(w, "/acme/brand/p.jpg?preset=small", { accept: "*/*" });
    expect(r3.headers.get("content-type")).toBe("image/jpeg");
  });

  it("a preset outside the library's list, an unknown one or a non-image is refused and not transformed", async () => {
    expect((await get(w, "/acme/brand/p.jpg?preset=large")).status).toBe(400);
    expect((await get(w, "/acme/brand/p.jpg?preset=w9999")).status).toBe(400);
    expect((await get(w, "/acme/brand/p.jpg?preset=__proto__")).status).toBe(400);
    expect((await get(w, "/acme/brand/doc.pdf?preset=thumb")).status).toBe(400);
    expect(w.images.calls).toEqual([]);
    expect(w.r2.gets).toEqual([]);
  });

  it("variants have their own etag and cache entry", async () => {
    const cache = new FakeCache();
    const a = await get(w, "/acme/brand/p.jpg?preset=thumb", { accept: "image/webp" }, { cache: cache as unknown as Cache });
    const o = await get(w, "/acme/brand/p.jpg", {}, { cache: cache as unknown as Cache });
    expect(a.headers.get("etag")).not.toBe(o.headers.get("etag"));
    await a.arrayBuffer();
    await o.arrayBuffer();
    expect(cache.store.size).toBe(2);
  });
});

describe("access rules", () => {
  it("referrer rules allow listed hosts and subdomains, direct visits and the serve host itself", async () => {
    const A = addLibrary(w, "acme", "brand", { r: ["blog.example.test", "*.cdn.example.test"] });
    addFile(w, A, "/x.png");
    expect((await get(w, "/acme/brand/x.png", { referer: "https://blog.example.test/post" })).status).toBe(200);
    expect((await get(w, "/acme/brand/x.png", { referer: "https://a.cdn.example.test/" })).status).toBe(200);
    expect((await get(w, "/acme/brand/x.png")).status).toBe(200);
    expect((await get(w, "/acme/brand/x.png", { referer: "https://evil.test/" })).status).toBe(403);
    expect((await get(w, "/acme/brand/x.png", { referer: "https://blog.example.test.evil.test/" })).status).toBe(403);
    expect(referrerAllowed("not a url", ["a.test"], "serve.test")).toBe(false);
    expect(referrerAllowed("https://serve.test/x", ["a.test"], "serve.test")).toBe(true);
  });

  it("IP block and allow lists, with IPv4 CIDR", async () => {
    const A = addLibrary(w, "acme", "brand", { ia: ["10.0.0.0/8", "2001:db8::1"], ib: ["10.9.0.0/16"] });
    addFile(w, A, "/x.png");
    expect((await get(w, "/acme/brand/x.png", { "cf-connecting-ip": "10.1.2.3" })).status).toBe(200);
    expect((await get(w, "/acme/brand/x.png", { "cf-connecting-ip": "2001:db8::1" })).status).toBe(200);
    expect((await get(w, "/acme/brand/x.png", { "cf-connecting-ip": "10.9.1.1" })).status).toBe(403);
    expect((await get(w, "/acme/brand/x.png", { "cf-connecting-ip": "192.0.2.1" })).status).toBe(403);
    expect(ipMatches("1.2.3.4", "1.2.3.4/32")).toBe(true);
    expect(ipMatches("1.2.3.5", "1.2.3.4/32")).toBe(false);
    expect(ipMatches("1.2.3.4", "0.0.0.0/0")).toBe(true);
    expect(ipMatches("1.2.3.4", "1.2.3.0/33")).toBe(false);
    expect(ipAllowed("", [], [])).toBe(true);
    expect(ipAllowed("", ["1.2.3.4"], [])).toBe(false);
  });

  it("rate-limited IPs get 429", async () => {
    const A = addLibrary(w, "acme", "brand");
    addFile(w, A, "/x.png");
    w.limited.add("192.0.2.9");
    const r = await get(w, "/acme/brand/x.png", { "cf-connecting-ip": "192.0.2.9" });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("60");
  });
});

describe("ranges, conditional requests and cache", () => {
  it("serves a single byte range and refuses one past the end", async () => {
    const A = addLibrary(w, "acme", "brand");
    const f = addFile(w, A, "/v.mp4", { mime: "video/mp4" });
    const r = await get(w, "/acme/brand/v.mp4", { range: "bytes=10-19" });
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toBe(`bytes 10-19/${f.bytes.length}`);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(new Uint8Array(f.bytes.subarray(10, 20)));
    const tail = await get(w, "/acme/brand/v.mp4", { range: "bytes=-5" });
    expect(new Uint8Array(await tail.arrayBuffer())).toEqual(new Uint8Array(f.bytes.subarray(f.bytes.length - 5)));
    expect((await get(w, "/acme/brand/v.mp4", { range: `bytes=${f.bytes.length}-` })).status).toBe(416);
  });

  it("If-None-Match answers 304 without touching storage", async () => {
    const A = addLibrary(w, "acme", "brand");
    const f = addFile(w, A, "/x.png");
    const r = await get(w, "/acme/brand/x.png", { "if-none-match": `"${f.e}"` });
    expect(r.status).toBe(304);
    expect(w.r2.gets).toEqual([]);
  });

  it("a second request is a cache hit; a replaced file (new etag) misses", async () => {
    const A = addLibrary(w, "acme", "brand");
    const f = addFile(w, A, "/x.png");
    const cache = new FakeCache();
    const deps = { cache: cache as unknown as Cache };
    const a = await get(w, "/acme/brand/x.png", {}, deps);
    expect(a.headers.get("x-cache")).toBe("MISS");
    await a.arrayBuffer();
    const b = await get(w, "/acme/brand/x.png", {}, deps);
    expect(b.headers.get("x-cache")).toBe("HIT");
    expect(new Uint8Array(await b.arrayBuffer())).toEqual(new Uint8Array(f.bytes));
    expect(w.r2.gets.length).toBe(1);
    addFile(w, A, "/x.png");
    const c = await get(w, "/acme/brand/x.png", {}, deps);
    expect(c.headers.get("x-cache")).toBe("MISS");
  });

  it("a trashed file (route deleted) is not served from the cache", async () => {
    const A = addLibrary(w, "acme", "brand");
    addFile(w, A, "/x.png");
    const cache = new FakeCache();
    await (await get(w, "/acme/brand/x.png", {}, { cache: cache as unknown as Cache })).arrayBuffer();
    w.kv.data.delete(`route:${A.id}:${sha("/x.png")}`);
    expect((await get(w, "/acme/brand/x.png", {}, { cache: cache as unknown as Cache })).status).toBe(404);
  });

  it("the library map is read from KV once per isolate window", async () => {
    const A = addLibrary(w, "acme", "brand");
    addFile(w, A, "/x.png");
    await get(w, "/acme/brand/x.png");
    await get(w, "/acme/brand/x.png");
    expect(w.kv.reads).toBe(3); // one map read, two route reads
  });

  it("every KV read uses the 30 s minimum cache TTL, so changes reach serving within about 30 s", async () => {
    const A = addLibrary(w, "acme", "brand");
    addFile(w, A, "/x.png");
    await (await get(w, "/acme/brand/x.png")).arrayBuffer();
    expect(w.kv.ttls).toEqual([30, 30]);
  });
});

describe("random image API", () => {
  it("is off unless the library enables it", async () => {
    addLibrary(w, "acme", "brand");
    expect((await get(w, "/acme/brand/_random")).status).toBe(404);
    expect(w.randomCalls).toEqual([]);
  });

  it("redirects to a random public image in the folder, asking only this library's index", async () => {
    const A = addLibrary(w, "acme", "brand", { rnd: true });
    w.randomResult = { path: "/wall papers/a.png" };
    const r = await get(w, "/acme/brand/_random?folder=/wall%20papers/");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/acme/brand/wall%20papers/a.png");
    expect(w.randomCalls).toEqual([
      { id: `org:${A.orgId}:lib:${A.id}`, scope: { orgId: A.orgId, libraryId: A.id }, req: { op: "randomPublic", folder: "/wall papers", mimePrefix: "image/" } },
    ]);
    w.randomResult = null;
    expect((await get(w, "/acme/brand/_random")).status).toBe(404);
    expect((await get(w, "/acme/brand/_random?folder=../x")).status).toBe(404);
  });
});

describe("Server-Timing", () => {
  it("every response reports the worker's own duration, refusals included", async () => {
    const A = addLibrary(w, "acme", "brand");
    addFile(w, A, "/x.png");
    let t = 100;
    const clock = () => (t += 7.25);
    const ok = await get(w, "/acme/brand/x.png", {}, { clock });
    expect(ok.headers.get("server-timing")).toBe("worker;dur=7.3");
    await ok.arrayBuffer();
    expect((await get(w, "/acme/brand/missing.png")).headers.get("server-timing")).toMatch(/^worker;dur=\d+(\.\d)?$/);
    expect((await get(w, "/health")).headers.get("server-timing")).toMatch(/^worker;dur=/);
  });
});

describe("analytics", () => {
  it("records library, file, referrer host, country, preset and outcome, never the IP or full referrer", async () => {
    const A = addLibrary(w, "acme", "brand");
    addFile(w, A, "/x.png");
    await (await get(w, "/acme/brand/x.png", { referer: "https://blog.example.test/secret-post?id=1", "cf-connecting-ip": "192.0.2.44" })).arrayBuffer();
    expect(w.ae).toHaveLength(1);
    const blobs = w.ae[0]!.blobs as string[];
    expect(blobs[0]).toBe(A.id);
    expect(blobs[2]).toBe("blog.example.test");
    expect(blobs[5]).toBe("origin");
    expect(JSON.stringify(w.ae)).not.toContain("192.0.2.44");
    expect(JSON.stringify(w.ae)).not.toContain("secret-post");
  });
});
