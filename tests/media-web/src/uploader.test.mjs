import { test } from "node:test";
import assert from "node:assert/strict";
import { uploadFile, resumeKey } from "../../../apps/media-web/src/api/uploader.js";
import { ApiError } from "../../../apps/media-web/src/api/client.js";

const PART = 1000;
const file = (size, name = "photo.png") => new File([new Uint8Array(size)], name, { lastModified: 1700000000000, type: "image/png" });
const memStorage = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), m };
};
const session = (size, uploaded = []) => ({ id: "ups_1", size, partSize: PART, partCount: Math.ceil(size / PART), uploadedParts: uploaded });

function fakeApi(responses) {
  const calls = [];
  return {
    calls,
    request: async (method, path, body) => {
      calls.push([method, path.replace(/^.*\/libraries\/[^/]+/, ""), body]);
      const r = responses(method, path, body);
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

const base = { org: "org_1", lib: "lib_1" };
const deps = (api, storage, putPart) => ({ api, storage, putPart, sha256: async () => "a".repeat(64), sleep: async () => {} });

test("a fresh upload sends every part, commits and forgets the resume record", async () => {
  const storage = memStorage();
  const sent = [];
  const api = fakeApi((m, p) => (m === "POST" && p.endsWith("/uploads") ? { session: session(2500) } : m === "POST" && p.endsWith("/commit") ? { file: { id: "fil_1" }, deduplicated: false } : null));
  const r = await uploadFile({ ...base, file: file(2500) }, deps(api, storage, async (url, blob) => (sent.push([url.split("/parts/")[1], blob.size]), { status: 200, json: {} })));
  assert.deepEqual(sent, [["1", 1000], ["2", 1000], ["3", 500]]);
  assert.equal(r.file.id, "fil_1");
  assert.equal(storage.m.size, 0);
});

test("after a reload, it resumes the remembered session and sends only the missing parts", async () => {
  const storage = memStorage();
  const f = file(2500);
  storage.setItem(resumeKey("lib_1", f), JSON.stringify({ sessionId: "ups_1", sha256: "a".repeat(64) }));
  const sent = [];
  const api = fakeApi((m, p) => (m === "GET" ? { session: session(2500, [1]) } : p.endsWith("/commit") ? { file: { id: "fil_1" }, deduplicated: false } : new Error("no new session expected")));
  const r = await uploadFile({ ...base, file: f }, deps(api, storage, async (url) => (sent.push(url.split("/parts/")[1]), { status: 200, json: {} })));
  assert.deepEqual(sent, ["2", "3"]);
  assert.equal(r.resumed, true);
  assert.ok(!api.calls.some(([m, p]) => m === "POST" && p === "/uploads"));
});

test("an expired remembered session starts a new one", async () => {
  const storage = memStorage();
  const f = file(500);
  storage.setItem(resumeKey("lib_1", f), JSON.stringify({ sessionId: "ups_old", sha256: "a".repeat(64) }));
  const api = fakeApi((m, p) => (m === "GET" ? new ApiError(404, "not_found", "gone") : p.endsWith("/uploads") ? { session: session(500) } : { file: { id: "fil_2" }, deduplicated: false }));
  const r = await uploadFile({ ...base, file: f }, deps(api, storage, async () => ({ status: 200, json: {} })));
  assert.equal(r.resumed, false);
  assert.equal(r.file.id, "fil_2");
});

test("bytes the library already has are linked without sending anything", async () => {
  const api = fakeApi(() => ({ file: { id: "fil_9" }, deduplicated: true }));
  let sent = 0;
  const r = await uploadFile({ ...base, file: file(5000) }, deps(api, memStorage(), async () => (sent++, { status: 200, json: {} })));
  assert.deepEqual([r.deduplicated, sent], [true, 0]);
});

test("server errors are retried; client errors are not", async () => {
  const api = fakeApi((m, p) => (p.endsWith("/uploads") ? { session: session(500) } : { file: { id: "f" }, deduplicated: false }));
  let tries = 0;
  await uploadFile({ ...base, file: file(500) }, deps(api, memStorage(), async () => (++tries < 3 ? { status: 503, json: {} } : { status: 200, json: {} })));
  assert.equal(tries, 3);
  let tries2 = 0;
  await assert.rejects(
    uploadFile({ ...base, file: file(500) }, deps(api, memStorage(), async () => (tries2++, { status: 422, json: { error: { code: "hash_mismatch", message: "bad" } } }))),
    (e) => e.code === "hash_mismatch",
  );
  assert.equal(tries2, 1);
});
