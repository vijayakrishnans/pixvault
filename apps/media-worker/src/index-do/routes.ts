// Route keys and the outbox drain. serve-worker reads `route:<libraryId>:<sha256hex(path)>`; the path is hashed so
// any path fits KV's key limit and a key never reveals a file name.

import type { LibraryIndexCore } from "./core.js";

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function routeKey(libraryId: string, path: string): Promise<string> {
  return `route:${libraryId}:${await sha256Hex(path)}`;
}

export interface RouteKv {
  put(key: string, value: string): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

/** Push pending outbox rows to KV, oldest first; acknowledge each one written. Returns how many were written. */
export async function drainOutbox(core: LibraryIndexCore, kv: RouteKv, libraryId: string, batch = 200): Promise<number> {
  let written = 0;
  for (;;) {
    const rows = core.pendingOutbox(batch);
    if (!rows.length) return written;
    const done: number[] = [];
    for (const r of rows) {
      const key = await routeKey(libraryId, r.path);
      if (r.op === "route.put" && r.value) await kv.put(key, r.value);
      else await kv.delete(key);
      done.push(r.seq);
    }
    core.ackOutbox(done);
    written += done.length;
    if (rows.length < batch) return written;
  }
}
