import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTree, crumbs, normalizeFolderInput } from "../../../apps/media-web/src/utils/folders.js";
import { filesFromDrop, folderForRelativePath, joinFolder } from "../../../apps/media-web/src/utils/upload/directoryTraversal.js";
import { changeTouchesView, fileKind, initials, thumbUrl, withPreset } from "../../../apps/media-web/src/utils/browse.js";
import { createLive, debounce, liveUrl } from "../../../apps/media-web/src/utils/live.js";

test("the folder tree nests the API's flat list under All files", () => {
  const t = buildTree(
    [
      { path: "/photos/2026", parent: "/photos", name: "2026", files: 2 },
      { path: "/photos", parent: "/", name: "photos", files: 1 },
      { path: "/docs", parent: "/", name: "docs", files: 0 },
    ],
    "All files",
  );
  assert.equal(t.length, 1);
  assert.equal(t[0].label, "All files");
  assert.equal(t[0].path, null);
  assert.deepEqual(t[0].children.map((n) => n.path), ["/docs", "/photos"]);
  assert.deepEqual(t[0].children[1].children.map((n) => [n.path, n.files]), [["/photos/2026", 2]]);
  assert.deepEqual(crumbs("/a/b"), [{ path: "/a", label: "a" }, { path: "/a/b", label: "b" }]);
  assert.deepEqual(crumbs(null), []);
});

test("typed folder paths are normalised like the API, and bad ones refused", () => {
  assert.equal(normalizeFolderInput(" photos//2026/ "), "/photos/2026");
  assert.equal(normalizeFolderInput(""), "/");
  assert.equal(normalizeFolderInput("/a/../b"), null);
  assert.equal(normalizeFolderInput("/a\u0001"), null);
});

test("a picked folder's files land under the current folder with their relative directories", () => {
  assert.equal(folderForRelativePath("/inbox", "trip/day1/a.jpg"), "/inbox/trip/day1");
  assert.equal(folderForRelativePath("/", "a.jpg"), "/");
  assert.equal(joinFolder("/a", "../b/./c"), "/a/b/c");
});

// FileSystemEntry fakes: readEntries hands back at most two at a time, as browsers batch them.
function fileEntry(name) {
  return { name, isFile: true, isDirectory: false, file: (res) => res({ name, size: 1 }) };
}
function dirEntry(name, children) {
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader() {
      let i = 0;
      return { readEntries: (res) => { const b = children.slice(i, i + 2); i += b.length; res(b); } };
    },
  };
}
const item = (entry) => ({ kind: "file", webkitGetAsEntry: () => entry });

test("a dropped folder keeps its structure, skips hidden files, reads every batch, and stops at the limit", async () => {
  const drop = [
    item(dirEntry("trip", [fileEntry("a.jpg"), fileEntry(".DS_Store"), dirEntry("day1", [fileEntry("b.jpg"), fileEntry("c.jpg"), fileEntry("d.jpg")]), dirEntry(".git", [fileEntry("x")])])),
    item(fileEntry("loose.png")),
  ];
  const r = await filesFromDrop(drop, "/inbox");
  assert.equal(r.truncated, false);
  assert.deepEqual(r.items.map((i) => `${i.folder}|${i.file.name}`), ["/inbox/trip|a.jpg", "/inbox/trip/day1|b.jpg", "/inbox/trip/day1|c.jpg", "/inbox/trip/day1|d.jpg", "/inbox|loose.png"]);
  const capped = await filesFromDrop(drop, "/", 2);
  assert.equal(capped.truncated, true);
  assert.equal(capped.items.length, 2);
});

test("file kinds, thumbnails and presets", () => {
  assert.equal(fileKind("image/png"), "image");
  assert.equal(fileKind("application/pdf"), "document");
  assert.equal(fileKind("application/zip"), "other");
  const pub = { url: "https://serve.test/acme/lib/a.png", status: "public", mime: "image/png" };
  assert.equal(thumbUrl(pub), "https://serve.test/acme/lib/a.png?preset=thumb");
  assert.equal(thumbUrl({ ...pub, status: "processing" }), null);
  assert.equal(thumbUrl({ ...pub, mime: "application/pdf" }), null);
  assert.equal(withPreset("https://serve.test/x.png?exp=1&sig=s", "medium"), "https://serve.test/x.png?exp=1&sig=s&preset=medium");
  assert.equal(initials("jane.doe@example.com"), "JD");
  assert.equal(initials("usr_ab12"), "A");
});

test("a live change reloads the view only when it touches it", () => {
  const listedIds = new Set(["fil_1"]);
  const ch = (files, tree = false) => ({ op: "x", files, tree });
  assert.equal(changeTouchesView(ch([{ id: "fil_1", folder: "/x" }]), { folder: "/a", listedIds, filtered: false }), true);
  assert.equal(changeTouchesView(ch([{ id: "fil_9", folder: "/a" }]), { folder: "/a", listedIds, filtered: false }), true);
  assert.equal(changeTouchesView(ch([{ id: "fil_9", folder: "/b" }]), { folder: "/a", listedIds, filtered: false }), false);
  assert.equal(changeTouchesView(ch([], true), { folder: "/a", listedIds, filtered: false }), true);
  assert.equal(changeTouchesView(ch([{ id: "fil_9", folder: "/b" }]), { folder: null, listedIds, filtered: false }), true);
});

// A fake WebSocket and manual timers for the live client.
class FakeWS {
  static all = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeWS.all.push(this);
  }
  send(m) {
    this.sent.push(JSON.parse(m));
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  msg(m) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}
function manualTimers() {
  const q = [];
  let id = 0;
  return {
    q,
    setTimeout: (f, ms) => {
      q.push({ f, ms, id: ++id });
      return id;
    },
    clearTimeout: (t) => {
      const i = q.findIndex((x) => x.id === t);
      if (i >= 0) q.splice(i, 1);
    },
    setInterval: () => 0,
    clearInterval: () => {},
    async runNext() {
      const t = q.shift();
      await t.f();
      return t.ms;
    },
  };
}
const tick = () => new Promise((r) => setImmediate(r));

test("the live client opens with a ticket, says where it is, delivers changes and presence, and reconnects", async () => {
  FakeWS.all = [];
  const timers = manualTimers();
  let tickets = 0;
  const changes = [];
  const states = [];
  let users = null;
  const live = createLive(
    {
      base: "https://edge.test",
      getTicket: async () => ({ ticket: `t${++tickets}`, path: "/v1/organizations/o/libraries/l/live" }),
      onChange: (m) => changes.push(m),
      onPresence: (u) => (users = u),
      onState: (s) => states.push(s),
    },
    { WebSocket: FakeWS, timers },
  );
  live.where("/photos");
  await tick();
  const ws = FakeWS.all[0];
  assert.equal(ws.url, "wss://edge.test/v1/organizations/o/libraries/l/live?ticket=t1");
  ws.open();
  assert.deepEqual(ws.sent, [{ t: "where", folder: "/photos" }]);
  ws.msg({ t: "change", op: "commit", files: [{ id: "fil_1", folder: "/photos", status: "private" }], tree: true });
  ws.msg({ t: "presence", users: [{ sub: "usr_a", folder: "/photos" }] });
  ws.msg({ t: "pong" });
  assert.equal(changes.length, 1);
  assert.deepEqual(users, [{ sub: "usr_a", folder: "/photos" }]);

  // dropped: back off, then reconnect with a fresh ticket
  ws.drop();
  assert.ok(timers.q[0].ms >= 750, `backoff ${timers.q[0].ms}`);
  await timers.runNext();
  await tick();
  assert.equal(FakeWS.all[1].url.endsWith("ticket=t2"), true);
  FakeWS.all[1].open();
  assert.deepEqual(FakeWS.all[1].sent, [{ t: "where", folder: "/photos" }]);
  // an expired socket (4001) reconnects at once
  FakeWS.all[1].drop(4001);
  assert.equal(timers.q[0].ms, 0);
  live.stop();
  assert.equal(timers.q.length, 0); // the pending reconnect is cancelled
  await tick();
  assert.equal(FakeWS.all.length, 2);
  assert.deepEqual([...new Set(states)], ["connecting", "open", "closed"]);
  assert.equal(liveUrl("http://127.0.0.1:8787", "/v1/x/live", "abc"), "ws://127.0.0.1:8787/v1/x/live?ticket=abc");
});

test("the live client stops when its holder is no longer allowed in", async () => {
  FakeWS.all = [];
  const timers = manualTimers();
  const states = [];
  createLive({ base: "https://edge.test", getTicket: async () => Promise.reject(Object.assign(new Error("nope"), { status: 404 })), onChange: () => {}, onState: (s) => states.push(s) }, { WebSocket: FakeWS, timers });
  await tick();
  assert.deepEqual(states, ["connecting", "closed"]);
  assert.equal(timers.q.length, 0);
  assert.equal(FakeWS.all.length, 0);
});

test("debounce gathers bursts into one call", async () => {
  const timers = manualTimers();
  const got = [];
  const d = debounce((batch) => got.push(batch), 250, 1000, timers);
  d(1);
  d(2);
  d(3);
  assert.equal(timers.q.length, 1);
  await timers.runNext();
  assert.deepEqual(got, [[1, 2, 3]]);
});
