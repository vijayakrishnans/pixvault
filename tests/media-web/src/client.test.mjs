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
