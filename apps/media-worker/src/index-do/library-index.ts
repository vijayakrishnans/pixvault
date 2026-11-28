// The LibraryIndex Durable Object: one per library, SQLite-backed (design §1.3). media-worker reaches it only
// after policy-worker allowed the action; every call names its (org, library) scope, which the index checks
// against the scope it was created for.

import { storeFor } from "../storage/stores.js";
import { DurableObject } from "cloudflare:workers";
import { createSqlExecutor } from "@saas/db/d1";
import { createMediaRepository } from "@saas/db/media";
import type { Env } from "../env.js";
import { IndexError, LibraryIndexCore, type BatchAction, type ListFilter, type LiveScope, type ProcessingResult, type Scope, type Sql } from "./core.js";
import { startPipeline } from "../pipeline/start.js";
import { abortUpload } from "../storage/object-store.js";
import { drainOutbox } from "./routes.js";
import { activityFor } from "./activity.js";
import { MAX_SOCKETS, SOCKET_TTL_MS, broadcastPresence, changeFor, deliver, onClientMessage, type Attachment, type LiveSocket } from "./live.js";

export type IndexOp =
  | { op: "findBlob"; sha256: string }
  | { op: "liveFileAt"; path: string }
  | { op: "getFile"; id: string }
  | { op: "getFileWithKey"; id: string }
  | ({ op: "listFiles" } & ListFilter)
  | { op: "listFolders"; uploadedBy?: string }
  | { op: "listTags" }
  | { op: "createFolder"; folder: string; actor: string; nowIso: string }
  | { op: "moveFile"; id: string; folder?: string; name?: string; actor: string; nowIso: string }
  | { op: "moveFolder"; from: string; to: string; actor: string; nowIso: string }
  | { op: "trashFolder"; folder: string; nowIso: string }
  | { op: "batch"; ids: string[]; act: BatchAction; actor: string; nowIso: string }
  | { op: "issueTicket"; subject: string; scope: LiveScope; nowIso: string }
  | { op: "versions"; id: string }
  | { op: "beginStorageSwitch"; nowIso: string; untilIso: string; allowFiles?: boolean }
  | { op: "extendStorageLock"; untilIso: string }
  | { op: "blobsPage"; after: string; limit: number }
  | { op: "migration" }
  | { op: "setMigration"; migration: Record<string, unknown> }
  | { op: "endStorageSwitch"; backend?: string | null }
  | { op: "noteStorageCheck"; nowIso: string }
  | { op: "openSession"; session: Parameters<LibraryIndexCore["openSession"]>[0] }
  | { op: "getSession"; id: string }
  | { op: "recordPart"; id: string; partNumber: number; etag: string }
  | { op: "closeSession"; id: string; state: "aborted" | "committed" }
  | { op: "commit"; input: Parameters<LibraryIndexCore["commit"]>[0] }
  | { op: "trash"; id: string; nowIso: string }
  | { op: "restore"; id: string; nowIso: string }
  | { op: "purge"; id: string; nowIso?: string }
  | { op: "restoreVersion"; id: string; version: number; actor: string; nowIso: string; processing?: boolean }
  | { op: "setRetentionDays"; days: number }
  | { op: "setVisibility"; id: string; visibility: "public" | "private"; nowIso: string; requireSafety?: boolean }
  | { op: "processingTarget"; id: string; sha256: string }
  | { op: "swapBlob"; input: Parameters<LibraryIndexCore["swapBlob"]>[0] }
  | { op: "finishProcessing"; id: string; sha256: string; result: ProcessingResult; nowIso: string }
  | { op: "reprocess"; id: string; nowIso: string }
  | { op: "review"; id: string; decision: "approve" | "reject"; nowIso: string }
  | { op: "takedown"; id: string; note: string; nowIso: string }
  | { op: "reinstate"; id: string; nowIso: string }
  | { op: "requeueAllRoutes"; nowIso: string }
  | { op: "randomPublic"; folder: string; mimePrefix: string }
  | { op: "createCollection"; input: Parameters<LibraryIndexCore["createCollection"]>[0] }
  | { op: "listCollections" }
  | { op: "getCollection"; id: string }
  | { op: "updateCollection"; id: string; patch: { name?: string; description?: string; publicGallery?: boolean }; nowIso: string }
  | { op: "deleteCollection"; id: string }
  | { op: "collectionItems"; id: string; action: "add" | "remove"; fileIds: string[]; nowIso: string }
  | { op: "collectionFiles"; id: string; servedOnly?: boolean; limit: number }
  | { op: "inCollection"; id: string; fileId: string }
  | { op: "gallery"; id: string }
  | { op: "listActivity"; fileId?: string; before?: number; limit: number }
  | { op: "listComments"; fileId: string }
  | { op: "getComment"; id: string }
  | { op: "addComment"; input: Parameters<LibraryIndexCore["addComment"]>[0] }
  | { op: "editComment"; id: string; fileId: string; body: string; nowIso: string }
  | { op: "resolveComment"; id: string; fileId: string; resolved: boolean; by: string; nowIso: string }
  | { op: "deleteComment"; id: string; fileId: string };

export type IndexResult = { ok: true; value: unknown } | { ok: false; code: string; message: string };

/** Run one operation and, when it changed something, record it in the activity log. */
export function dispatchAndRecord(core: LibraryIndexCore, scope: Scope, req: IndexOp, nowIso = new Date().toISOString()): IndexResult {
  const result = dispatch(core, scope, req);
  if (result.ok) {
    const entries = activityFor(req, result.value);
    if (entries.length) {
      try {
        // Takedowns and reinstatements are an operator's: the team sees "operator", never who.
        const actor = req.op === "takedown" || req.op === "reinstate" ? "operator" : (scope.actor ?? "system");
        core.recordActivity(actor, entries, nowIso);
      } catch {
        /* the log never fails the operation */
      }
    }
  }
  return result;
}

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
      case "listFolders":
        return { ok: true, value: req.uploadedBy ? core.listFoldersOf(req.uploadedBy) : core.listFolders() };
      case "listTags":
        return { ok: true, value: core.listTags() };
      case "createFolder":
        return { ok: true, value: core.createFolder(req.folder, req.actor, req.nowIso) };
      case "moveFile":
        return { ok: true, value: core.moveFile(req.id, { ...(req.folder !== undefined ? { folder: req.folder } : {}), ...(req.name !== undefined ? { name: req.name } : {}) }, req.actor, req.nowIso) };
      case "moveFolder":
        return { ok: true, value: core.moveFolder(req.from, req.to, req.actor, req.nowIso) };
      case "trashFolder":
        return { ok: true, value: core.trashFolder(req.folder, req.nowIso) };
      case "batch":
        return { ok: true, value: core.batch(req.ids, req.act, req.actor, req.nowIso) };
      case "issueTicket":
        return { ok: true, value: core.issueTicket(req.subject, req.scope, req.nowIso) };
      case "versions":
        return { ok: true, value: core.versions(req.id) };
      case "beginStorageSwitch":
        return { ok: true, value: core.beginStorageSwitch(req.nowIso, req.untilIso, { allowFiles: req.allowFiles === true }) };
      case "extendStorageLock":
        core.extendStorageLock(req.untilIso);
        return { ok: true, value: true };
      case "blobsPage":
        return { ok: true, value: core.blobsPage(req.after, req.limit) };
      case "migration":
        return { ok: true, value: core.migration() };
      case "setMigration":
        core.setMigration(req.migration);
        return { ok: true, value: true };
      case "endStorageSwitch":
        core.endStorageSwitch(req.backend ?? null);
        return { ok: true, value: true };
      case "noteStorageCheck":
        return { ok: true, value: core.noteStorageCheck(req.nowIso) };
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
        return { ok: true, value: core.purge(req.id, req.nowIso) };
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
      case "takedown":
        return { ok: true, value: core.takedown(req.id, req.note, req.nowIso) };
      case "reinstate":
        return { ok: true, value: core.reinstate(req.id, req.nowIso) };
      case "review":
        return { ok: true, value: core.review(req.id, req.decision, req.nowIso) };
      case "reprocess":
        return { ok: true, value: core.reprocess(req.id, req.nowIso) };
      case "requeueAllRoutes":
        return { ok: true, value: core.requeueAllRoutes(req.nowIso) };
      case "createCollection":
        return { ok: true, value: core.createCollection(req.input) };
      case "listCollections":
        return { ok: true, value: core.listCollections() };
      case "getCollection":
        return { ok: true, value: core.getCollection(req.id) };
      case "updateCollection":
        return { ok: true, value: core.updateCollection(req.id, req.patch, req.nowIso) };
      case "deleteCollection":
        core.deleteCollection(req.id);
        return { ok: true, value: true };
      case "collectionItems":
        return { ok: true, value: core.collectionItems(req.id, req.action, req.fileIds, req.nowIso) };
      case "collectionFiles":
        return { ok: true, value: core.collectionFiles(req.id, { servedOnly: req.servedOnly ?? false, limit: req.limit }) };
      case "inCollection":
        return { ok: true, value: core.inCollection(req.id, req.fileId) };
      case "listActivity":
        return { ok: true, value: core.listActivity({ ...(req.fileId ? { fileId: req.fileId } : {}), ...(req.before ? { before: req.before } : {}), limit: req.limit }) };
      case "listComments":
        return { ok: true, value: core.listComments(req.fileId) };
      case "getComment":
        return { ok: true, value: core.getComment(req.id) };
      case "addComment":
        return { ok: true, value: core.addComment(req.input) };
      case "editComment":
        return { ok: true, value: core.editComment(req.id, req.fileId, req.body, req.nowIso) };
      case "resolveComment":
        return { ok: true, value: core.resolveComment(req.id, req.fileId, req.resolved, req.by, req.nowIso) };
      case "deleteComment":
        core.deleteComment(req.id, req.fileId);
        return { ok: true, value: true };
      case "gallery":
        return { ok: true, value: core.gallery(req.id) };
      case "randomPublic":
        return { ok: true, value: core.randomPublic(req.folder, req.mimePrefix) };
    }
  } catch (e) {
    if (e instanceof IndexError) return { ok: false, code: e.code, message: e.message };
    return { ok: false, code: "internal", message: "Index operation failed" };
  }
}

const STUCK_MS = 10 * 60_000;
const DRAIN_PER_ALARM = 600;
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
    // Keepalive pings are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
  }

  async call(scope: Scope, req: IndexOp): Promise<IndexResult> {
    const result = dispatchAndRecord(this.core, scope, req);
    if (result.ok) {
      const change = changeFor(req, result.value);
      if (change) {
        const sockets = this.sockets();
        if (sockets.length) deliver(sockets, change, Date.now());
      }
    }
    // The outbox drains on an alarm right away, so the request isn't held up by KV writes; sessions expire and
    // trash ages out on later alarms.
    if (result.ok && (this.core.outboxSize() > 0 || req.op === "openSession" || req.op === "trash" || req.op === "commit" || req.op === "setVisibility" || req.op === "reprocess" || req.op === "restoreVersion" || req.op === "review" || req.op === "batch" || req.op === "trashFolder")) {
      await this.scheduleAlarm();
    }
    return result;
  }

  private sockets(): LiveSocket[] {
    return this.ctx.getWebSockets() as unknown as LiveSocket[];
  }

  /**
   * The live socket (GET …/live?ticket=…, forwarded by media-worker). The ticket was issued by this index, minutes
   * ago at most, to someone the API authorised, and works once. Anything else is 404.
   */
  async fetch(request: Request): Promise<Response> {
    const notFound = () => new Response(JSON.stringify({ error: { code: "not_found", message: "Not found" } }), { status: 404, headers: { "content-type": "application/json" } });
    if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") return notFound();
    const ticket = new URL(request.url).searchParams.get("ticket") ?? "";
    if (!/^[0-9a-f]{64}$/.test(ticket)) return notFound();
    const who = this.core.consumeTicket(ticket, new Date().toISOString());
    if (!who) return notFound();
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) {
      return new Response(JSON.stringify({ error: { code: "unavailable", message: "Too many live connections to this library" } }), { status: 503, headers: { "content-type": "application/json" } });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, [who.subject]);
    const attachment: Attachment = { sub: who.subject, scope: who.scope, folder: null, exp: Date.now() + SOCKET_TTL_MS };
    server.serializeAttachment(attachment);
    broadcastPresence(this.sockets());
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (onClientMessage(ws as unknown as LiveSocket, message)) broadcastPresence(this.sockets());
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "bye");
    } catch {
      /* already closed */
    }
    broadcastPresence(this.sockets(), ws as unknown as LiveSocket);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    broadcastPresence(this.sockets(), ws as unknown as LiveSocket);
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
    // At most DRAIN_PER_ALARM KV writes per alarm (a bulk move queues two per file); the rest go on the next alarm,
    // which scheduleAlarm sets for now while the outbox isn't empty.
    if (this.env.ROUTES_KV && libraryId) await drainOutbox(this.core, this.env.ROUTES_KV, libraryId, 200, DRAIN_PER_ALARM);
    const orgForStore = this.orgId();
    const bucket = orgForStore && libraryId ? await storeFor(this.env, orgForStore, libraryId).catch(() => null) : null;
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
    const purgeIds = this.core.storageLocked(now.toISOString()) ? [] : this.core.trashedBefore(cutoff);
    for (const id of purgeIds) {
      const r = this.core.purge(id, now.toISOString());
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
