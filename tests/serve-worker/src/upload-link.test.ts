// PV6 upload-link page on serve-worker: the form, sending files to media-worker one by one, and the results.
import { parseUploadPath } from "@serve-worker/upload-link";
import { clearMapMemo, serve } from "@serve-worker/serve";
import { world, type World } from "./fakes.js";

const H = "https://serve.test";
const T = "B".repeat(43);
const info = (over: Record<string, unknown> = {}) => ({
  label: "Press <kit>",
  limits: { maxFiles: 5, maxFileBytes: 1048576, maxTotalBytes: 5242880, allowedTypes: ["image/*"] },
  remaining: { files: 5, bytes: 5242880 },
  expiresAt: null,
  reviewed: true,
  ...over,
});
const json = (data: unknown, status = 200) => new Response(JSON.stringify(status < 400 ? { data } : { error: data }), { status, headers: { "content-type": "application/json" } });

let w: World;
beforeEach(() => {
  clearMapMemo();
  w = world();
});
const req = (init: RequestInit = {}) => serve(new Request(`${H}/_u/${T}`, init), w.env, { now: () => 1_800_000_000_000 });

it("upload paths take a token only", () => {
  expect(parseUploadPath(`/_u/${T}`)).toBe(T);
  expect(parseUploadPath(`/_u/${T}/x`)).toBeNull();
  expect(parseUploadPath(`/_u/short`)).toBeNull();
});

it("the form escapes the label, states the limits and accepts only the link's types; no script", async () => {
  w.uploadAnswer = () => json(info());
  const r = await req();
  expect(r.status).toBe(200);
  const html = await r.text();
  expect(html).toContain("Press &lt;kit&gt;");
  expect(html).toContain('enctype="multipart/form-data"');
  expect(html).toContain('accept="image/*"');
  expect(html).toContain("review what you send");
  expect(html).not.toContain("<script");
  expect(r.headers.get("referrer-policy")).toBe("no-referrer");
  expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
});

it("each file goes to media-worker with its name and type; the page reports what arrived and why not", async () => {
  w.uploadAnswer = (route, q) => {
    if (route === "open") return json(info({ remaining: { files: 4, bytes: 5000000 } }));
    if (q.get("name") === "ok.png") return json({ file: { name: "ok.png" } }, 201);
    return json({ code: "unsupported_type" }, 415);
  };
  const fd = new FormData();
  fd.append("files", new File([new Uint8Array([1, 2, 3])], "ok.png", { type: "image/png" }));
  fd.append("files", new File([new Uint8Array([4, 5])], "bad.exe", { type: "application/x-msdownload" }));
  const r = await req({ method: "POST", body: fd });
  const html = await r.text();
  expect(html).toContain("ok.png: received");
  expect(html).toContain("bad.exe: not received (type not accepted)");
  const uploads = w.uploadCalls.filter((c) => c.route === "upload");
  expect(uploads.map((c) => new URLSearchParams(c.query.slice(1)).get("name"))).toEqual(["ok.png", "bad.exe"]);
  expect(new URLSearchParams(uploads[0]!.query.slice(1)).get("token")).toBe(T);
  expect(uploads[0]!.size).toBe(3);
});

it("too big a submission, too many submissions, a full link, expired and turned off", async () => {
  w.uploadAnswer = () => json(info());
  expect((await req({ method: "POST", headers: { "content-length": String(200 * 1024 * 1024) }, body: "x" })).status).toBe(413);
  w.uploadLimited.add("9.9.9.9");
  expect((await req({ method: "POST", headers: { "cf-connecting-ip": "9.9.9.9" }, body: new FormData() })).status).toBe(429);
  w.uploadAnswer = () => json(info({ remaining: { files: 0, bytes: 0 } }));
  const full = await (await req()).text();
  expect(full).toContain("taken all the files it can");
  expect(full).not.toContain("<form");
  w.uploadAnswer = () => json({ code: "expired" }, 410);
  expect((await req()).status).toBe(410);
  w.env.PUBLIC_SHARING = "off";
  w.uploadCalls = [];
  expect((await req()).status).toBe(404);
  expect(w.uploadCalls).toEqual([]);
});
