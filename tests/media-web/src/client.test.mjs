import { test } from "node:test";
import assert from "node:assert/strict";
import { apiBase, createClient, getToken, setToken, ApiError } from "../../../apps/media-web/src/api/client.js";

test("each deployment talks to its own environment's edge", () => {
  assert.equal(apiBase("pixvault-media-web-stage.vijayakrishnan12994.workers.dev", undefined), "https://pixvault-api-edge-stage.vijayakrishnan12994.workers.dev");
  assert.equal(apiBase("pixvault-media-web-prod.vijayakrishnan12994.workers.dev", undefined), "https://pixvault-api-edge-prod.vijayakrishnan12994.workers.dev");
  assert.equal(apiBase("localhost", "http://127.0.0.1:8787/"), "http://127.0.0.1:8787");
  // A look-alike host never gets a derived edge on someone else's domain.
  assert.equal(apiBase("pixvault-media-web-stage.evil.example", undefined), "https://pixvault-api-edge-stage.vijayakrishnan12994.workers.dev");
});

function fakeFetch(status, data) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return { ok: status < 400, status, json: async () => data };
  };
  return { fn, calls };
}

test("reads send the bearer token and no idempotency key; writes send a fresh one", async () => {
  const f = fakeFetch(200, { data: { libraries: [] } });
  const c = createClient({ base: "https://edge", fetchImpl: f.fn, token: () => "tok" });
  assert.deepEqual(await c.libraries.list("org_1"), { libraries: [] });
  assert.equal(f.calls[0].url, "https://edge/v1/organizations/org_1/libraries");
  assert.equal(f.calls[0].init.headers.authorization, "Bearer tok");
  assert.equal(f.calls[0].init.headers["idempotency-key"], undefined);
  await c.libraries.create("org_1", { name: "A" });
  await c.libraries.create("org_1", { name: "A" });
  const k1 = f.calls[1].init.headers["idempotency-key"];
  const k2 = f.calls[2].init.headers["idempotency-key"];
  assert.ok(k1 && k2 && k1 !== k2);
  assert.equal(f.calls[1].init.body, JSON.stringify({ name: "A" }));
});

test("path segments are encoded", async () => {
  const f = fakeFetch(200, { data: {} });
  const c = createClient({ base: "https://edge", fetchImpl: f.fn, token: () => null });
  await c.libraries.putMember("org_1", "lib_1", "usr/../x", "viewer");
  assert.equal(f.calls[0].url, "https://edge/v1/organizations/org_1/libraries/lib_1/members/usr%2F..%2Fx");
  assert.equal(f.calls[0].init.headers.authorization, undefined);
});

test("errors carry the edge's status and code", async () => {
  const f = fakeFetch(404, { error: { code: "not_found", message: "Not found" } });
  const c = createClient({ base: "https://edge", fetchImpl: f.fn, token: () => "t" });
  await assert.rejects(c.libraries.get("o", "l"), (e) => e instanceof ApiError && e.status === 404 && e.code === "not_found");
  const down = createClient({ base: "https://edge", fetchImpl: async () => { throw new Error("offline"); }, token: () => "t" });
  await assert.rejects(down.orgs.list(), (e) => e.status === 0 && e.code === "network");
});

test("token storage survives a storage that throws", () => {
  const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
  assert.equal(getToken(broken), null);
  assert.doesNotThrow(() => setToken("x", broken));
  const mem = new Map();
  const ok = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  setToken("abc", ok);
  assert.equal(getToken(ok), "abc");
  setToken(null, ok);
  assert.equal(getToken(ok), null);
});

test("visibility and signed links call the file routes", async () => {
  const f = fakeFetch(200, { data: { url: "u", expiresAt: "t" } });
  const c = createClient({ base: "https://edge", fetchImpl: f.fn, token: () => "tok" });
  await c.libraries.setVisibility("org_1", "lib_2", "fil_3", "public");
  assert.equal(f.calls[0].url, "https://edge/v1/organizations/org_1/libraries/lib_2/files/fil_3");
  assert.equal(f.calls[0].init.method, "PATCH");
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { visibility: "public" });
  assert.deepEqual(await c.libraries.signedUrl("org_1", "lib_2", "fil_3", 3600), { url: "u", expiresAt: "t" });
  assert.equal(f.calls[1].url, "https://edge/v1/organizations/org_1/libraries/lib_2/files/fil_3/signed-url");
  assert.deepEqual(JSON.parse(f.calls[1].init.body), { expiresIn: 3600 });
});

test("review, reprocess and the review list call their routes", async () => {
  const f = fakeFetch(200, { data: { file: { id: "fil_3" }, files: [], nextCursor: null } });
  const c = createClient({ base: "https://edge", fetchImpl: f.fn, token: () => "tok" });
  await c.libraries.review("org_1", "lib_2", "fil_3", "approve");
  assert.equal(f.calls[0].url, "https://edge/v1/organizations/org_1/libraries/lib_2/files/fil_3/review");
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { decision: "approve" });
  await c.libraries.reprocess("org_1", "lib_2", "fil_3");
  assert.equal(f.calls[1].url, "https://edge/v1/organizations/org_1/libraries/lib_2/files/fil_3/reprocess");
  assert.equal(f.calls[1].init.method, "POST");
  await c.libraries.files("org_1", "lib_2", { review: true });
  assert.equal(f.calls[2].url, "https://edge/v1/organizations/org_1/libraries/lib_2/files?review=1");
});

test("the browser's calls: search and filters, moves, batches, folders, tags, versions and live tickets", async () => {
  const f = fakeFetch(200, { data: {} });
  const c = createClient({ base: "https://edge", fetchImpl: f.fn, token: () => "tok" });
  const L = "https://edge/v1/organizations/org_1/libraries/lib_2";
  await c.libraries.files("org_1", "lib_2", { folder: "/a b", q: "  sun set ", type: "image", tag: "tabby cat", visibility: "public", status: "", cursor: "c1" });
  assert.equal(f.calls[0].url, `${L}/files?folder=%2Fa+b&q=sun+set&type=image&tag=tabby+cat&visibility=public&cursor=c1`);
  await c.libraries.files("org_1", "lib_2", { q: "   " });
  assert.equal(f.calls[1].url, `${L}/files`);
  const calls = [
    [() => c.libraries.moveFile("org_1", "lib_2", "fil_3", { folder: "/x", name: "y.png" }), "PATCH", `${L}/files/fil_3`, { folder: "/x", name: "y.png" }],
    [() => c.libraries.batch("org_1", "lib_2", { action: "move", ids: ["fil_3"], folder: "/x" }), "POST", `${L}/files:batch`, { action: "move", ids: ["fil_3"], folder: "/x" }],
    [() => c.libraries.folders("org_1", "lib_2"), "GET", `${L}/folders`, undefined],
    [() => c.libraries.createFolder("org_1", "lib_2", "/new"), "POST", `${L}/folders`, { path: "/new" }],
    [() => c.libraries.moveFolder("org_1", "lib_2", "/a", "/b"), "POST", `${L}/folders/move`, { from: "/a", to: "/b" }],
    [() => c.libraries.trashFolder("org_1", "lib_2", "/a"), "POST", `${L}/folders/trash`, { path: "/a" }],
    [() => c.libraries.tags("org_1", "lib_2"), "GET", `${L}/tags`, undefined],
    [() => c.libraries.versions("org_1", "lib_2", "fil_3"), "GET", `${L}/files/fil_3/versions`, undefined],
    [() => c.libraries.restoreVersion("org_1", "lib_2", "fil_3", 2), "POST", `${L}/files/fil_3/versions/2/restore`, undefined],
    [() => c.libraries.liveTicket("org_1", "lib_2"), "POST", `${L}/live-tickets`, undefined],
    [() => c.libraries.file("org_1", "lib_2", "fil_3"), "GET", `${L}/files/fil_3`, undefined],
  ];
  for (const [call, method, url, body] of calls) {
    const n = f.calls.length;
    await call();
    assert.equal(f.calls[n].url, url);
    assert.equal(f.calls[n].init.method, method);
    assert.deepEqual(f.calls[n].init.body === undefined ? undefined : JSON.parse(f.calls[n].init.body), body);
  }
  assert.equal(c.base, "https://edge");
});

test("the sharing calls: share links, upload links, collections and comments", async () => {
  const f = fakeFetch(200, { data: {} });
  const c = createClient({ base: "https://edge", fetchImpl: f.fn, token: () => "tok" });
  const L = "https://edge/v1/organizations/org_1/libraries/lib_2";
  const calls = [
    [() => c.libraries.shareLinks("org_1", "lib_2", { folder: "/a b" }), "GET", `${L}/share-links?folder=%2Fa+b`, undefined],
    [() => c.libraries.shareLinks("org_1", "lib_2"), "GET", `${L}/share-links`, undefined],
    [() => c.libraries.createShareLink("org_1", "lib_2", { target: { kind: "file", fileId: "fil_3" }, mode: "view" }), "POST", `${L}/share-links`, { target: { kind: "file", fileId: "fil_3" }, mode: "view" }],
    [() => c.libraries.revokeShareLink("org_1", "lib_2", "shl_4"), "DELETE", `${L}/share-links/shl_4`, undefined],
    [() => c.libraries.uploadLinks("org_1", "lib_2"), "GET", `${L}/upload-links`, undefined],
    [() => c.libraries.createUploadLink("org_1", "lib_2", { folder: "/in" }), "POST", `${L}/upload-links`, { folder: "/in" }],
    [() => c.libraries.revokeUploadLink("org_1", "lib_2", "upl_5"), "DELETE", `${L}/upload-links/upl_5`, undefined],
    [() => c.libraries.collections("org_1", "lib_2"), "GET", `${L}/collections`, undefined],
    [() => c.libraries.createCollection("org_1", "lib_2", { name: "K" }), "POST", `${L}/collections`, { name: "K" }],
    [() => c.libraries.updateCollection("org_1", "lib_2", "col_6", { publicGallery: true }), "PATCH", `${L}/collections/col_6`, { publicGallery: true }],
    [() => c.libraries.collectionItems("org_1", "lib_2", "col_6", "add", ["fil_3"]), "POST", `${L}/collections/col_6/items`, { action: "add", ids: ["fil_3"] }],
    [() => c.libraries.deleteCollection("org_1", "lib_2", "col_6"), "DELETE", `${L}/collections/col_6`, undefined],
    [() => c.libraries.comments("org_1", "lib_2", "fil_3"), "GET", `${L}/files/fil_3/comments`, undefined],
    [() => c.libraries.addComment("org_1", "lib_2", "fil_3", "hi", ["usr_7"]), "POST", `${L}/files/fil_3/comments`, { body: "hi", mentions: ["usr_7"] }],
    [() => c.libraries.updateComment("org_1", "lib_2", "fil_3", "cmt_8", { resolved: true }), "PATCH", `${L}/files/fil_3/comments/cmt_8`, { resolved: true }],
    [() => c.libraries.deleteComment("org_1", "lib_2", "fil_3", "cmt_8"), "DELETE", `${L}/files/fil_3/comments/cmt_8`, undefined],
  ];
  for (const [call, method, url, body] of calls) {
    const n = f.calls.length;
    await call();
    assert.equal(f.calls[n].url, url);
    assert.equal(f.calls[n].init.method, method);
    assert.deepEqual(f.calls[n].init.body === undefined ? undefined : JSON.parse(f.calls[n].init.body), body);
  }
});
