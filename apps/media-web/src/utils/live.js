// The library's live connection (PV5): a WebSocket to the library's index, opened with a one-use ticket from the
// API. It reconnects with backoff (a fresh ticket each time), pings to stay open, re-announces the folder in view,
// and hands change and presence messages to the page. Events carry only file ids, folders and states; the page
// refetches through the API.

const PING_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;

/** ws(s) URL for a ticket path on the API's base. */
export function liveUrl(base, path, ticket) {
  const u = new URL(path, base);
  u.protocol = u.protocol === "http:" ? "ws:" : "wss:";
  u.searchParams.set("ticket", ticket);
  return u.toString();
}

/**
 * @param {object} o
 * @param {() => Promise<{ticket: string, path: string}>} o.getTicket
 * @param {string} o.base  the API base (https://…)
 * @param {(m: {op: string, files: {id: string, folder: string, status: string}[], tree: boolean}) => void} o.onChange
 * @param {(users: {sub: string, folder: string|null}[]) => void} [o.onPresence]
 * @param {(state: "connecting"|"open"|"closed") => void} [o.onState]
 */
export function createLive(o, deps = {}) {
  const WS = deps.WebSocket ?? globalThis.WebSocket;
  const timers = deps.timers ?? { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t), setInterval: (f, ms) => setInterval(f, ms), clearInterval: (t) => clearInterval(t) };
  let ws = null;
  let stopped = false;
  let attempt = 0;
  let retryTimer = null;
  let pingTimer = null;
  let folder = null;
  const state = (s) => o.onState?.(s);

  function send(msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  function scheduleRetry(immediate = false) {
    if (stopped) return;
    const delay = immediate ? 0 : Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempt, 5)) * (0.75 + Math.random() * 0.5);
    attempt++;
    retryTimer = timers.setTimeout(connect, delay);
  }

  async function connect() {
    if (stopped || !WS) return;
    state("connecting");
    let t;
    try {
      t = await o.getTicket();
    } catch (e) {
      // Not allowed any more (removed from the library): stop; anything else: try again later.
      if (e?.status === 404 || e?.status === 401) {
        stopped = true;
        state("closed");
        return;
      }
      scheduleRetry();
      return;
    }
    if (stopped) return;
    const sock = new WS(liveUrl(o.base, t.path, t.ticket));
    ws = sock;
    sock.onopen = () => {
      attempt = 0;
      state("open");
      if (folder !== null) send({ t: "where", folder });
      timers.clearInterval(pingTimer);
      pingTimer = timers.setInterval(() => send({ t: "ping" }), PING_MS);
    };
    sock.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m?.t === "change") o.onChange(m);
      else if (m?.t === "presence") o.onPresence?.(m.users ?? []);
    };
    sock.onclose = (e) => {
      if (ws !== sock) return;
      ws = null;
      timers.clearInterval(pingTimer);
      state("closed");
      // 4001: the socket's hour is up; reconnect at once with a fresh ticket.
      scheduleRetry(e?.code === 4001);
    };
    sock.onerror = () => {
      /* onclose follows */
    };
  }

  connect();
  return {
    /** Tell teammates which folder is in view (null: the whole library). */
    where(f) {
      folder = f ?? "/";
      send({ t: "where", folder });
    },
    stop() {
      stopped = true;
      timers.clearTimeout(retryTimer);
      timers.clearInterval(pingTimer);
      const s = ws;
      ws = null;
      try {
        s?.close(1000, "bye");
      } catch {
        /* closed */
      }
    },
  };
}

/** Collect many events into one call after `ms` of quiet (or at most `max` ms after the first). */
// The default timers are wrapped: a browser throws "Illegal invocation" when setTimeout is called as a method of
// another object, which is what `timers.setTimeout(…)` would do with the bare functions.
const defaultTimers = { setTimeout: (f, ms) => globalThis.setTimeout(f, ms), clearTimeout: (t) => globalThis.clearTimeout(t) };

export function debounce(fn, ms = 250, max = 1000, timers = defaultTimers) {
  let t = null;
  let first = 0;
  let pending = [];
  return (arg) => {
    pending.push(arg);
    const now = Date.now();
    if (!t) first = now;
    timers.clearTimeout(t);
    const wait = Math.max(0, Math.min(ms, first + max - now));
    t = timers.setTimeout(() => {
      t = null;
      const batch = pending;
      pending = [];
      fn(batch);
    }, wait);
  };
}
