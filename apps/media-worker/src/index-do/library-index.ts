// The LibraryIndex Durable Object: one per library, SQLite-backed (design §1.3). media-worker reaches it only
// after policy-worker allowed the action; every call names its (org, library) scope, which the index checks
// against the scope it was created for.

import { DurableObject } from "cloudflare:workers";
import { createSqlExecutor } from "@saas/db/d1";
import { createMediaRepository } from "@saas/db/media";
import type { Env } from "../env.js";
import { IndexError, LibraryIndexCore, type ProcessingResult, type Scope, type Sql } from "./core.js";
import { startPipeline } from "../pipeline/start.js";
import { abortUpload } from "../storage/object-store.js";
import { drainOutbox } from "./routes.js";

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
  | { op: "restoreVersion"; id: string; version: number; actor: string; nowIso: string; processing?: boolean }
  | { op: "setRetentionDays"; days: number }
  | { op: "setVisibility"; id: string; visibility: "public" | "private"; nowIso: string; requireSafety?: boolean }
  | { op: "processingTarget"; id: string; sha256: string }
  | { op: "swapBlob"; input: Parameters<LibraryIndexCore["swapBlob"]>[0] }
  | { op: "finishProcessing"; id: string; sha256: string; result: ProcessingResult; nowIso: string }
  | { op: "reprocess"; id: string; nowIso: string }
  | { op: "requeueAllRoutes"; nowIso: string }
  | { op: "randomPublic"; folder: string; mimePrefix: string };

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
        return { ok: true, value: core.restoreVersion(req.id, req.version, req.actor, req.nowIso, req.processing ?? false) };
      case "setRetentionDays":
        core.setRetentionDays(req.days);
        return { ok: true, value: true };
      case "setVisibility":
        return { ok: true, value: core.setVisibility(req.id, req.visibility, req.nowIso, req.requireSafety ?? false) };
      case "processingTarget":
        return { ok: true, value: core.processingTarget(req.id, req.sha256) };
      case "swapBlob":
        return { ok: true, value: core.swapBlob(req.input) };
      case "finishProcessing":
        return { ok: true, value: core.finishProcessing(req.id, req.sha256, req.result, req.nowIso) };
      case "reprocess":
        return { ok: true, value: core.reprocess(req.id, req.nowIso) };
      case "requeueAllRoutes":
        return { ok: true, value: core.requeueAllRoutes(req.nowIso) };
      case "randomPublic":
        return { ok: true, value: core.randomPublic(req.folder, req.mimePrefix) };
    }
  } catch (e) {
    if (e instanceof IndexError) return { ok: false, code: e.code, message: e.message };
    return { ok: false, code: "internal", message: "Index operation failed" };
  }
}

const STUCK_MS = 10 * 60_000;
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
    // The outbox drains on an alarm right away, so the request isn't held up by KV writes; sessions expire and
    // trash ages out on later alarms.
    if (result.ok && (this.core.outboxSize() > 0 || req.op === "openSession" || req.op === "trash" || req.op === "commit" || req.op === "setVisibility" || req.op === "reprocess" || req.op === "restoreVersion")) {
      await this.scheduleAlarm();
    }
    return result;
  }

  private async scheduleAlarm(): Promise<void> {
    const times: number[] = [];
    if (this.core.outboxSize() > 0) times.push(Date.now());
    const s = this.core.nextSessionExpiry();
    if (s) times.push(Date.parse(s));
    const p = this.core.oldestProcessingAt();
    if (p) times.push(Date.parse(p) + STUCK_MS);
    const t = this.core.oldestTrashedAt();
    if (t) times.push(Date.parse(t) + this.core.retentionDays() * DAY);
    if (!times.length) return;
    const soonest = Math.min(...times);
    // Outbox work runs now; cleanup work no sooner than a minute out.
    const next = soonest <= Date.now() ? Date.now() : Math.max(Date.now() + 60_000, soonest);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > next) await this.ctx.storage.setAlarm(next);
  }

  /** Drain the outbox to the routes KV, abort expired upload sessions, purge trash older than the library's retention. */
  async alarm(): Promise<void> {
    const now = new Date();
    const libraryId = this.metaValue("library_id");
    if (this.env.ROUTES_KV && libraryId) await drainOutbox(this.core, this.env.ROUTES_KV, libraryId);
    const bucket = this.env.MEDIA_BUCKET;
    for (const s of this.core.expiredSessions(now.toISOString())) {
      if (bucket) await abortUpload(bucket, s.object_key, s.mode, s.multipart_upload_id);
      this.core.closeSession(s.id, "aborted");
    }
    // A file still processing after STUCK_MS lost its run (or it never started): start another.
    const orgIdForSweep = this.orgId();
    if (orgIdForSweep && libraryId) {
      for (const f of this.core.stuckProcessing(new Date(now.getTime() - STUCK_MS).toISOString())) {
        const started = await startPipeline(
          this.env,
          { orgId: orgIdForSweep, libraryId, fileId: f.id, sha256: f.blob_sha256, requireSafety: f.visibility === "public" },
          `s${now.getTime().toString(36)}`,
        );
        // Touch it either way so the sweep waits another STUCK_MS before trying again.
        this.ctx.storage.sql.exec(`UPDATE files SET updated_at = ? WHERE id = ? AND status = 'processing'`, now.toISOString(), f.id);
        if (!started) console.error(JSON.stringify({ level: "error", msg: "pipeline_sweep_start_failed", file: f.id }));
      }
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
    return this.metaValue("org_id");
  }

  private metaValue(key: string): string | null {
    const r = this.ctx.storage.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, key).toArray();
    return r[0]?.value ?? null;
  }
}
