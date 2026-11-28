// PV6 share-link pages on serve-worker: paths, the landing page, the password form and cookie, the file bytes,
// and the headers that keep the token from leaking. media-worker is faked at the service binding.

import { parseSharePath } from "@serve-worker/share";
import { clearMapMemo, serve } from "@serve-worker/serve";
import { world, type World } from "./fakes.js";

const H = "https://serve.test";
const T = "A".repeat(43);
const FIL = "fil_" + "a".repeat(32);
const json = (data: unknown, status = 200) => new Response(JSON.stringify(status < 400 ? { data } : { error: data }), { status, headers: { "content-type": "application/json" } });
const opened = (over: Record<string, unknown> = {}) => ({
  share: { kind: "file", mode: "view", label: "pic.png", expiresAt: null, downloadsLeft: null },
  files: [{ id: FIL, name: "pic <b>.png", size: 2048, mime: "image/png", folder: "/" }],
  truncated: false,
  ...over,
});

let w: World;
beforeEach(() => {
  clearMapMemo();
  w = world();
});
const req = (path: string, init: RequestInit = {}) => serve(new Request(`${H}${path}`, init), w.env, { now: () => 1_800_000_000_000 });

describe("share paths", () => {
  it("accept a token and an optional file, nothing else", () => {
    expect(parseSharePath(`/_s/${T}`)).toEqual({ token: T, fileId: null });
    expect(parseSharePath(`/_s/${T}/f/${FIL}`)).toEqual({ token: T, fileId: FIL });
    for (const bad of [`/_s/short`, `/_s/${T}/x/${FIL}`, `/_s/${T}/f/fil_zz`, `/_s/${T}/f/${FIL}/more`, `/_s/${T}!`]) expect(parseSharePath(bad)).toBeNull();
  });
});

describe("share pages", () => {
  it("the landing page escapes names, previews an image in view mode, and leaks no token", async () => {
    w.shareAnswer = () => json(opened());
    const r = await req(`/_s/${T}`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("pic &lt;b&gt;.png");
    expect(html).not.toContain("<b>.png");
    expect(html).toContain(`<img src="/_s/${T}/f/${FIL}"`);
    expect(html).toContain(`href="/_s/${T}/f/${FIL}?dl=1"`);
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("x-robots-tag")).toContain("noindex");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(w.shareCalls).toEqual([{ route: "open", body: { token: T } }]);
  });

  it("download mode shows no inline preview (every fetch would count)", async () => {
    w.shareAnswer = () => json(opened({ share: { kind: "file", mode: "download", label: "pic.png", expiresAt: null, downloadsLeft: 3 } }));
    const html = await (await req(`/_s/${T}`)).text();
    expect(html).not.toContain("<img");
    expect(html).toContain("3 downloads left");
  });

  it("a folder share lists its files with their relative folders", async () => {
    w.shareAnswer = () =>
      json(opened({ share: { kind: "folder", mode: "view", label: "trip", expiresAt: null, downloadsLeft: null }, files: [{ id: FIL, name: "a.jpg", size: 10, mime: "image/jpeg", folder: "/day1" }] }));
    const html = await (await req(`/_s/${T}`)).text();
    expect(html).toContain("<h1>trip</h1>");
    expect(html).toContain("day1/");
  });

  it("a password link shows a form; the right password sets a cookie scoped to the link and redirects", async () => {
    w.shareAnswer = (_route, body) => (body.password === "correct horse" ? json(opened({ proof: { value: "123.abc", maxAge: 43200 } })) : json({ code: "password_required", details: { wrong: body.password !== undefined } }, 401));
    const form = await req(`/_s/${T}`);
    expect(form.status).toBe(401);
    expect(await form.text()).toContain('type="password"');
    const wrong = await req(`/_s/${T}`, { method: "POST", body: new URLSearchParams({ password: "nope" }) });
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain("isn't right");
    const ok = await req(`/_s/${T}`, { method: "POST", body: new URLSearchParams({ password: "correct horse" }) });
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe(`/_s/${T}`);
    const cookie = ok.headers.get("set-cookie")!;
    expect(cookie).toContain("pv_share=123.abc");
    expect(cookie).toContain(`Path=/_s/${T}`);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    // the cookie goes back to media-worker as the proof
    await req(`/_s/${T}`, { headers: { cookie: "other=1; pv_share=123.abc" } });
    expect(w.shareCalls.at(-1)!.body).toEqual({ token: T, proof: "123.abc" });
  });

  it("password tries are rate-limited per address and link", async () => {
    w.shareLimited.add(`1.2.3.4:${T.slice(0, 16)}`);
    const r = await req(`/_s/${T}`, { method: "POST", headers: { "cf-connecting-ip": "1.2.3.4" }, body: new URLSearchParams({ password: "x" }) });
    expect(r.status).toBe(429);
    expect(w.shareCalls).toEqual([]);
  });

  it("file bytes pass through with media-worker's headers; ?dl=1 asks for a download", async () => {
    w.shareAnswer = () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png", "content-disposition": "inline", "x-request-id": "r1" } });
    const r = await req(`/_s/${T}/f/${FIL}?dl=1`);
    expect(r.status).toBe(200);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(r.headers.get("x-request-id")).toBeNull();
    expect(r.headers.get("x-robots-tag")).toContain("noindex");
    expect(w.shareCalls.at(-1)).toEqual({ route: "content", body: { token: T, fileId: FIL, download: true } });
  });

  it("gone, expired, taken down and off", async () => {
    for (const [status, text] of [[404, "doesn't work"], [410, "no longer available"]] as const) {
      w.shareAnswer = () => json({ code: "x" }, status);
      const r = await req(`/_s/${T}`);
      expect(r.status).toBe(status);
      expect(await r.text()).toContain(text);
    }
    w.shareAnswer = () => json({ code: "x" }, 451);
    expect((await req(`/_s/${T}`)).status).toBe(451);
    w.env.PUBLIC_SHARING = "off";
    w.shareCalls = [];
    expect((await req(`/_s/${T}`)).status).toBe(404);
    expect(w.shareCalls).toEqual([]);
  });
});
