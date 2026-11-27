// The LibraryIndex Durable Object: one per library, SQLite-backed (design §1.3). media-worker reaches it only
// after policy-worker allowed the action; every call names its (org, library) scope, which the index checks
// against the scope it was created for.

import { DurableObject } from "cloudflare:workers";
import { createSqlExecutor } from "@saas/db/d1";
import { createMediaRepository } from "@saas/db/media";
import type { Env } from "../env.js";
import { IndexError, LibraryIndexCore, type Scope, type Sql } from "./core.js";
import { abortUpload } from "../storage/object-store.js";

export type IndexOp =
  | { op: "findBlob"; sha256: string }
  | { op: "liveFileAt"; path: string }
  | { op: "getFile"; id: string }
  | { op: "getFileWithKey"; id: string }
  | { op: "listFiles"; folder?: string; status?: "live" | "trashed"; uploadedBy?: string; cursor?: string; limit: number }
  | { op: "versions"; id: string }
  | { op: "openSession"; session: Parameters<LibraryIndexCore["openSession"]>[0] }
  | { op: "getSession"; id: string }
  | { op: "recordPart"; id: string; partNumber: number; etag: string }
  | { op: "closeSession"; id: string; state: "aborted" | "committed" }
  | { op: "commit"; input: Parameters<LibraryIndexCore["commit"]>[0] }
  | { op: "trash"; id: string; nowIso: string }
  | { op: "restore"; id: string; nowIso: string }
  | { op: "purge"; id: string }
  | { op: "restoreVersion"; id: string; version: number; actor: string; nowIso: string }
  | { op: "setRetentionDays"; days: number };

export type IndexResult = { ok: true; value: unknown } | { ok: false; code: string; message: string };

/** Dispatch one operation to the core. Shared by the Durable Object and the tests. */
export function dispatch(core: LibraryIndexCore, scope: Scope, req: IndexOp): IndexResult {
  try {
    core.assertScope(scope);
    switch (req.op) {
      case "findBlob":
        return { ok: true, value: core.findBlob(req.sha256) };
      case "liveFileAt":
        return { ok: true, value: core.liveFileAt(req.path) };
      case "getFile":
        return { ok: true, value: core.getFile(req.id) };
      case "getFileWithKey": {
        const f = core.getFile(req.id);
        return { ok: true, value: f ? { file: f, objectKey: core.blobKeyOf(f) } : null };
      }
      case "listFiles":
        return { ok: true, value: core.listFiles(req) };
      case "versions":
        return { ok: true, value: core.versions(req.id) };
      case "openSession":
        return { ok: true, value: core.openSession(req.session) };
      case "getSession":
        return { ok: true, value: core.getSession(req.id) };
      case "recordPart":
        return { ok: true, value: core.recordPart(req.id, req.partNumber, req.etag) };
      case "closeSession":
        return { ok: true, value: core.closeSession(req.id, req.state) };
      case "commit":
        return { ok: true, value: core.commit(req.input) };
      case "trash":
        return { ok: true, value: core.trash(req.id, req.nowIso) };
      case "restore":
        return { ok: true, value: core.restore(req.id, req.nowIso) };
      case "purge":
        return { ok: true, value: core.purge(req.id) };
      case "restoreVersion":
        return { ok: true, value: core.restoreVersion(req.id, req.version, req.actor, req.nowIso) };
      case "setRetentionDays":
        core.setRetentionDays(req.days);
        return { ok: true, value: true };
    }
  } catch (e) {
    if (e instanceof IndexError) return { ok: false, code: e.code, message: e.message };
    return { ok: false, code: "internal", message: "Index operation failed" };
  }
}

const DAY = 86_400_000;

export class LibraryIndex extends DurableObject<Env> {
  private core: LibraryIndexCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const storage = ctx.storage;
    const sql: Sql = {
      exec: (query, ...params) => storage.sql.exec(query, ...params) as unknown as { toArray(): never[] },
      transaction: (fn) => storage.transactionSync(fn),
    };
    this.core = new LibraryIndexCore(sql);
  }

  async call(scope: Scope, req: IndexOp): Promise<IndexResult> {
    const result = dispatch(this.core, scope, req);
    // Sessions expire and trash ages out: make sure an alarm is set whenever there is something to clean.
    if (result.ok && (req.op === "openSession" || req.op === "trash")) await this.scheduleAlarm();
    return result;
  }

  private async scheduleAlarm(): Promise<void> {
    const times: number[] = [];
    const s = this.core.nextSessionExpiry();
    if (s) times.push(Date.parse(s));
    const t = this.core.oldestTrashedAt();
    if (t) times.push(Date.parse(t) + this.core.retentionDays() * DAY);
    if (!times.length) return;
    const next = Math.max(Date.now() + 60_000, Math.min(...times));
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > next) await this.ctx.storage.setAlarm(next);
  }

  /** Abort expired upload sessions and purge trash older than the library's retention. */
  async alarm(): Promise<void> {
    const now = new Date();
    const bucket = this.env.MEDIA_BUCKET;
    for (const s of this.core.expiredSessions(now.toISOString())) {
      if (bucket) await abortUpload(bucket, s.object_key, s.mode, s.multipart_upload_id);
      this.core.closeSession(s.id, "aborted");
    }
    const cutoff = new Date(now.getTime() - this.core.retentionDays() * DAY).toISOString();
    let released = 0;
    for (const id of this.core.trashedBefore(cutoff)) {
      const r = this.core.purge(id);
      if (bucket) for (const key of r.deleteKeys) await bucket.delete(key);
      released += r.releasedBytes;
    }
    if (released > 0 && this.env.PLATFORM_DB) {
      const orgId = this.orgId();
      if (orgId) await createMediaRepository(createSqlExecutor(this.env.PLATFORM_DB)).releaseStorage(orgId, released, now);
    }
    await this.scheduleAlarm();
  }

  private orgId(): string | null {
    const r = this.ctx.storage.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'org_id'`).toArray();
    return r[0]?.value ?? null;
  }
}
