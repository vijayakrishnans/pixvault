// PV5: live updates and presence. Tickets go through the real router and policy engine; the socket logic runs
// against fake hibernating sockets. No file names or contents ever reach a socket.

import { randomBytes } from "node:crypto";
import { FakeDigestStream, World, sha256hex, type User } from "./harness.js";
import { changeFor, deliver, onClientMessage, presenceOf, EXPIRED_CODE, type Attachment, type LiveSocket } from "@media-worker/index-do/live";
import type { FileRow } from "@media-worker/index-do/core";
import { route } from "@media-worker/router";

beforeAll(() => {
  (globalThis as unknown as { crypto: { DigestStream?: unknown } }).crypto.DigestStream = FakeDigestStream;
});
afterAll(() => {
  delete (globalThis as unknown as { crypto: { DigestStream?: unknown } }).crypto.DigestStream;
});

class FakeSocket implements LiveSocket {
  sent: any[] = [];
  closed: { code: number | undefined } | null = null;
  constructor(private a: Attachment) {}
  send(m: string) {
    this.sent.push(JSON.parse(m));
  }
  close(code?: number) {
    this.closed = { code };
  }
  deserializeAttachment() {
    return this.a;
  }
  serializeAttachment(v: unknown) {
    this.a = v as Attachment;
  }
}

const row = (over: Partial<FileRow>): FileRow =>
  ({ id: "00000000-0000-4000-8000-000000000001", path: "/a/secret-name.jpg", name: "secret-name.jpg", folder: "/a", status: "public", uploaded_by: "usr_1", ...over }) as FileRow;

describe("live events and presence", () => {
  const far = Date.now() + 3600_000;

  it("a change says which files changed, in which folder and state, never their names", () => {
    const c = changeFor({ op: "trash", id: "x", nowIso: "" }, row({ status: "trashed" }))!;
    const ws = new FakeSocket({ sub: "usr_2", scope: "all", folder: null, exp: far });
    deliver([ws], c, Date.now());
    expect(ws.sent).toEqual([{ t: "change", op: "trash", files: [{ id: "fil_00000000000040008000000000000001", folder: "/a", status: "trashed" }], tree: false }]);
    expect(JSON.stringify(ws.sent)).not.toContain("secret-name");
    // reads and internal steps say nothing
    expect(changeFor({ op: "listFiles", limit: 1 }, { files: [] })).toBeNull();
    expect(changeFor({ op: "finishProcessing", id: "x", sha256: "s", result: { status: "public" }, nowIso: "" }, null)).toBeNull();
    expect(changeFor({ op: "moveFolder", from: "/a", to: "/b", actor: "u", nowIso: "" }, {})).toEqual({ op: "moveFolder", files: [], tree: true });
  });

  it("a socket that sees only its holder's uploads hears only about those; expired sockets are closed", () => {
    const all = new FakeSocket({ sub: "usr_9", scope: "all", folder: null, exp: far });
    const mine = new FakeSocket({ sub: "usr_1", scope: "own", folder: null, exp: far });
    const other = new FakeSocket({ sub: "usr_3", scope: "own", folder: null, exp: far });
    const old = new FakeSocket({ sub: "usr_4", scope: "all", folder: null, exp: Date.now() - 1 });
    const c = changeFor({ op: "batch", ids: [], act: { action: "visibility", visibility: "public", requireSafety: false }, actor: "u", nowIso: "" }, {
      done: [row({}), row({ id: "00000000-0000-4000-8000-000000000002", uploaded_by: "usr_3" })],
      failed: [],
    })!;
    deliver([all, mine, other, old], c, Date.now());
    expect(all.sent[0].files).toHaveLength(2);
    expect(mine.sent[0].files.map((f: { id: string }) => f.id)).toEqual(["fil_00000000000040008000000000000001"]);
    expect(other.sent[0].files.map((f: { id: string }) => f.id)).toEqual(["fil_00000000000040008000000000000002"]);
    expect(old.sent).toEqual([]);
    expect(old.closed).toEqual({ code: EXPIRED_CODE });
    // a purge (uploader unknown) reaches only sockets that see everything
    const p = changeFor({ op: "purge", id: "00000000-0000-4000-8000-000000000001" }, {})!;
    deliver([all, mine], p, Date.now());
    expect(all.sent).toHaveLength(2);
    expect(mine.sent).toHaveLength(1);
  });

  it("presence lists each person once with the folder they named; bad messages are ignored", () => {
    const a1 = new FakeSocket({ sub: "usr_a", scope: "all", folder: null, exp: far });
    const a2 = new FakeSocket({ sub: "usr_a", scope: "all", folder: null, exp: far });
    const b = new FakeSocket({ sub: "usr_b", scope: "own", folder: null, exp: far });
    expect(onClientMessage(a2, JSON.stringify({ t: "where", folder: "/photos" }))).toBe(true);
    expect(onClientMessage(a2, JSON.stringify({ t: "where", folder: "/photos" }))).toBe(false); // no change
    for (const bad of ["nope", JSON.stringify({ t: "where", folder: "photos" }), JSON.stringify({ t: "rm" }), "x".repeat(2000), JSON.stringify({ t: "where", folder: "/a\u0000" })]) {
      expect(onClientMessage(b, bad)).toBe(false);
    }
    expect(presenceOf([a1, a2, b])).toEqual({ t: "presence", users: [{ sub: "usr_a", folder: "/photos" }, { sub: "usr_b", folder: null }] });
    expect(presenceOf([a1, a2, b], b).users.map((u) => u.sub)).toEqual(["usr_a"]);
  });
});

describe("live tickets", () => {
  let w: World;
  let A: { id: string; pub: string };
  let owner: User, viewer: User, guest: User, stranger: User;
  let base: string;

  beforeEach(async () => {
    w = new World();
    w.now = new Date(); // the socket checks tickets against the real clock, as the Durable Object does
    A = w.newOrg();
    owner = w.newUser("owner");
    viewer = w.newUser("viewer");
    guest = w.newUser("guest");
    stranger = w.newUser("stranger");
    w.grant(A, owner, "owner");
    w.grant(A, viewer, "viewer");
    const lib = (await w.call(owner, "POST", `/v1/organizations/${A.pub}/libraries`, { name: "Live" })).json.data.library;
    base = `/v1/organizations/${A.pub}/libraries/${lib.id}`;
    await w.call(owner, "PUT", `${base}/members/${viewer.id}`, { role: "viewer" });
    await w.call(owner, "POST", `${base}/invitations`, { email: guest.email, role: "uploader" });
    await w.call(guest, "POST", "/v1/media/invitations/accept");
  });

  const open = async (ticket: string, upgrade = true) => {
    // node's Request drops "upgrade" (a forbidden header name in fetch); workerd keeps it. A plain request object does too.
    const req = { url: `https://media.internal${base}/live?ticket=${ticket}`, method: "GET", headers: new Headers(upgrade ? { upgrade: "websocket" } : {}) } as unknown as Request;
    const res = await route(req, w.env);
    return { status: res.status, body: res.status === 200 ? await res.json() : null };
  };

  it("members get a one-use ticket with their scope; the socket opens once with it, without an actor", async () => {
    const t = await w.call(viewer, "POST", `${base}/live-tickets`);
    expect(t.status).toBe(201);
    expect(t.json.data).toMatchObject({ scope: "all", path: `${base}/live` });
    expect(t.json.data.ticket).toMatch(/^[0-9a-f]{64}$/);
    expect(await open(t.json.data.ticket)).toEqual({ status: 200, body: { subject: viewer.id, scope: "all" } });
    expect((await open(t.json.data.ticket)).status).toBe(404); // used up
    expect((await open("f".repeat(64))).status).toBe(404);
    expect((await open("not-a-ticket")).status).toBe(404);

    const g = await w.call(guest, "POST", `${base}/live-tickets`);
    expect(g.json.data.scope).toBe("own");
    expect((await open(g.json.data.ticket, false)).status).toBe(404); // not an upgrade
    expect((await w.call(stranger, "POST", `${base}/live-tickets`)).status).toBe(404);
    expect((await w.call(null, "POST", `${base}/live-tickets`)).status).toBe(401);
  });

  it("a ticket expires after a minute", async () => {
    const t = (await w.call(owner, "POST", `${base}/live-tickets`)).json.data;
    const core = [...w.index.cores.values()][0]!;
    expect(core.consumeTicket(t.ticket, new Date(Date.parse(t.expiresAt) + 1).toISOString())).toBeNull();
  });

  it("an upload by one member is a change for the others' sockets", async () => {
    const bytes = randomBytes(32);
    const s = (await w.call(owner, "POST", `${base}/uploads`, { name: "n.bin", folder: "/team", size: bytes.length, sha256: sha256hex(bytes), mime: "application/octet-stream" })).json.data.session;
    await w.put(owner, `${base}/uploads/${s.id}/parts/1`, bytes);
    const r = await w.call(owner, "POST", `${base}/uploads/${s.id}/commit`);
    const c = changeFor({ op: "commit", input: {} as never }, { file: { ...row({}), id: r.json.data.file.id.slice(4).replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5"), folder: "/team", status: "private", uploaded_by: owner.id } })!;
    const ws = new FakeSocket({ sub: viewer.id, scope: "all", folder: "/team", exp: Date.now() + 1000 });
    deliver([ws], c, Date.now());
    expect(ws.sent[0]).toEqual({ t: "change", op: "commit", files: [{ id: r.json.data.file.id, folder: "/team", status: "private" }], tree: true });
  });
});
