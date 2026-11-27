// The per-library index: files, blobs (deduplicated by SHA-256), versions and upload sessions, in the library's
// own SQLite (design §1.3). Every write is one transaction, and the Durable Object's single thread means two
// commits never interleave.
//
// Reference counting: a blob's refcount is the number of version rows that point at it, across every file,
// trashed ones included. A blob's object is deleted only when that count reaches zero.
//
// This core speaks to a tiny SQL interface so the tests run it over real SQLite (node:sqlite) exactly as the
// Durable Object runs it over ctx.storage.sql.

export interface Sql {
  exec<T = Record<string, unknown>>(query: string, ...params: unknown[]): { toArray(): T[] };
  transaction<T>(fn: () => T): T;
}

export class IndexError extends Error {
  constructor(
    readonly code: "not_found" | "conflict" | "scope_mismatch" | "invalid_state" | "forbidden",
    message: string,
  ) {
    super(message);
  }
}

export interface Scope {
  orgId: string;
  libraryId: string;
}

export interface FileRow {
  id: string;
  path: string;
  name: string;
  folder: string;
  blob_sha256: string;
  size: number;
  mime: string;
  visibility: "public" | "private";
  status: "processing" | "held" | "public" | "private" | "flagged" | "removed" | "trashed";
  prev_status: string | null;
  version: number;
  uploaded_by: string;
  created_at: string;
  updated_at: string;
  trashed_at: string | null;
  /** Pipeline results (PV4); null until the file has been processed. */
  width: number | null;
  height: number | null;
  /** JSON array of tags. */
  tags: string | null;
  /** "pass" | "fail" | "error" | "skipped" | "manual" */
  moderation: string | null;
  /** Why the pipeline held the file, or what it did (no file content). */
  pipeline_note: string | null;
}

/** Pipeline outcome for one file version (written by ProcessFileWorkflow). */
export interface ProcessingResult {
  status: "public" | "private" | "held" | "flagged";
  width?: number | null;
  height?: number | null;
  tags?: string[] | null;
  moderation?: string | null;
  note?: string | null;
}

export interface SessionRow {
  id: string;
  path: string;
  name: string;
  folder: string;
  size: number;
  sha256: string;
  mime: string;
  visibility: "public" | "private";
  replace: number;
  mode: "single" | "multipart";
  object_key: string;
  multipart_upload_id: string | null;
  part_size: number;
  part_count: number;
  parts_json: string;
  state: "open" | "committed" | "aborted";
  created_by: string;
  created_at: string;
  expires_at: string;
}

export interface BlobRow {
  sha256: string;
  object_key: string;
  size: number;
  refcount: number;
}

export interface CommitResult {
  file: FileRow;
  deduplicated: boolean;
  /** Bytes newly stored (0 when deduplicated). */
  storedBytes: number;
  /** Objects no longer referenced: delete them from the bucket. */
  deleteKeys: string[];
  /** Bytes released by deleteKeys (stored bytes to subtract from usage). */
  releasedBytes: number;
}

export const MAX_VERSIONS = 10;

/** What serve-worker needs to serve one path (design §1.3). Written to KV as `route:<libraryId>:<sha256(path)>`. */
export interface RouteValue {
  /** object key */ k: string;
  /** MIME type */ m: string;
  /** size */ s: number;
  /** etag: the bytes' SHA-256 */ e: string;
  /** visibility */ v: "public" | "private";
  /** file status */ st: FileRow["status"];
  /** file name (for Content-Disposition) */ n: string;
  /** file id */ f: string;
}

export interface OutboxRow {
  seq: number;
  op: "route.put" | "route.delete";
  path: string;
  value: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS blobs (
  sha256 TEXT PRIMARY KEY, object_key TEXT NOT NULL UNIQUE, size INTEGER NOT NULL, refcount INTEGER NOT NULL,
  created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL, folder TEXT NOT NULL, blob_sha256 TEXT NOT NULL,
  size INTEGER NOT NULL, mime TEXT NOT NULL, visibility TEXT NOT NULL, status TEXT NOT NULL, prev_status TEXT,
  version INTEGER NOT NULL, uploaded_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  trashed_at TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS files_live_path ON files (path) WHERE status != 'trashed';
CREATE INDEX IF NOT EXISTS files_folder ON files (folder, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS files_created ON files (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS files_trashed ON files (status, trashed_at);
CREATE TABLE IF NOT EXISTS versions (
  file_id TEXT NOT NULL, version INTEGER NOT NULL, blob_sha256 TEXT NOT NULL, size INTEGER NOT NULL,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (file_id, version));
CREATE INDEX IF NOT EXISTS versions_blob ON versions (blob_sha256);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL, folder TEXT NOT NULL, size INTEGER NOT NULL,
  sha256 TEXT NOT NULL, mime TEXT NOT NULL, visibility TEXT NOT NULL, replace INTEGER NOT NULL, mode TEXT NOT NULL,
  object_key TEXT NOT NULL, multipart_upload_id TEXT, part_size INTEGER NOT NULL, part_count INTEGER NOT NULL,
  parts_json TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions (state, expires_at);
CREATE TABLE IF NOT EXISTS outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, op TEXT NOT NULL, path TEXT NOT NULL, value TEXT, created_at TEXT NOT NULL);
`;

// Columns added after a library's index was created. CREATE TABLE IF NOT EXISTS never adds columns, so each index
// adds the ones it lacks when it starts.
const ADDED_COLUMNS: [table: string, column: string, ddl: string][] = [
  ["files", "width", "INTEGER"],
  ["files", "height", "INTEGER"],
  ["files", "tags", "TEXT"],
  ["files", "moderation", "TEXT"],
  ["files", "pipeline_note", "TEXT"],
];

const one = <T>(rows: T[]): T | null => rows[0] ?? null;

export class LibraryIndexCore {
  constructor(private readonly sql: Sql) {
    for (const stmt of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) this.sql.exec(stmt);
    const have = new Map<string, Set<string>>();
    for (const [table, column, ddl] of ADDED_COLUMNS) {
      if (!have.has(table)) have.set(table, new Set(this.sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().map((c) => c.name)));
      if (!have.get(table)!.has(column)) {
        this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
        have.get(table)!.add(column);
      }
    }
    this.sql.exec(`CREATE INDEX IF NOT EXISTS files_status ON files (status, updated_at)`);
  }

  // ── identity ──────────────────────────────────────────────

  /** Bind this index to its library on first use; refuse any other library forever after. */
  assertScope(scope: Scope): void {
    const rows = this.sql.exec<{ key: string; value: string }>(`SELECT key, value FROM meta WHERE key IN ('org_id', 'library_id')`).toArray();
    if (rows.length === 0) {
      this.sql.transaction(() => {
        this.sql.exec(`INSERT INTO meta (key, value) VALUES ('org_id', ?), ('library_id', ?)`, scope.orgId, scope.libraryId);
      });
      return;
    }
    const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    if (m.org_id !== scope.orgId || m.library_id !== scope.libraryId) {
      throw new IndexError("scope_mismatch", "This index belongs to another library");
    }
  }

  setRetentionDays(days: number): void {
    this.sql.exec(`INSERT INTO meta (key, value) VALUES ('retention_days', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, String(days));
  }

  retentionDays(): number {
    const r = one(this.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'retention_days'`).toArray());
    return r ? Number(r.value) : 30;
  }

  // ── outbox (design §1.3): every change that serving must see, in the same transaction as the change ──

  private enqueueRoute(f: FileRow, nowIso: string): void {
    if (f.status === "trashed") {
      this.sql.exec(`INSERT INTO outbox (op, path, value, created_at) VALUES ('route.delete', ?, NULL, ?)`, f.path, nowIso);
      return;
    }
    const blob = this.findBlob(f.blob_sha256);
    if (!blob) return;
    const value: RouteValue = { k: blob.object_key, m: f.mime, s: f.size, e: f.blob_sha256, v: f.visibility, st: f.status, n: f.name, f: f.id };
    this.sql.exec(`INSERT INTO outbox (op, path, value, created_at) VALUES ('route.put', ?, ?, ?)`, f.path, JSON.stringify(value), nowIso);
  }

  pendingOutbox(limit: number): OutboxRow[] {
    return this.sql.exec<OutboxRow>(`SELECT seq, op, path, value FROM outbox ORDER BY seq ASC LIMIT ?`, limit).toArray();
  }

  ackOutbox(seqs: number[]): void {
    for (const seq of seqs) this.sql.exec(`DELETE FROM outbox WHERE seq = ?`, seq);
  }

  outboxSize(): number {
    return Number(one(this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM outbox`).toArray())?.n ?? 0);
  }

  /** Re-publish every live file's route (a library that predates serving, or a rebuilt KV). */
  requeueAllRoutes(nowIso: string): number {
    return this.sql.transaction(() => {
      const files = this.sql.exec<FileRow>(`SELECT * FROM files WHERE status != 'trashed'`).toArray();
      for (const f of files) this.enqueueRoute(f, nowIso);
      return files.length;
    });
  }

  /**
   * Change who can see a file. With `requireSafety` (a public file on a free plan), a file that hasn't passed
   * moderation goes through the pipeline first: it is `processing` until then, and the caller starts the pipeline.
   */
  setVisibility(id: string, visibility: "public" | "private", nowIso: string, requireSafety = false): FileRow {
    return this.sql.transaction(() => {
      const f = this.getFile(id);
      if (!f || f.status === "trashed") throw new IndexError("not_found", "File not found");
      // Only files that are plainly public or private follow their visibility; processing, held, flagged and removed
      // files stay as they are.
      const plain = f.status === "public" || f.status === "private";
      const needsCheck = plain && visibility === "public" && requireSafety && f.moderation !== "pass" && f.moderation !== "manual";
      const status = needsCheck ? "processing" : plain ? visibility : f.status;
      this.sql.exec(`UPDATE files SET visibility = ?, status = ?, updated_at = ? WHERE id = ?`, visibility, status, nowIso, id);
      const updated = this.getFile(id)!;
      this.enqueueRoute(updated, nowIso);
      return updated;
    });
  }

  /** A random public image under `folder` (and its subfolders), for the random-image API. */
  randomPublic(folder: string, mimePrefix: string): FileRow | null {
    const like = folder === "/" ? "/%" : `${folder}/%`;
    return one(
      this.sql
        .exec<FileRow>(
          `SELECT * FROM files WHERE status = 'public' AND path LIKE ? AND mime LIKE ? ORDER BY RANDOM() LIMIT 1`,
          like,
          `${mimePrefix}%`,
        )
        .toArray(),
    );
  }

  // ── pipeline (PV4) ────────────────────────────────────────

  /** The file and its object, if it is still waiting for the pipeline with these bytes. */
  processingTarget(id: string, sha256: string): { file: FileRow; objectKey: string } | null {
    const f = this.getFile(id);
    if (!f || f.status !== "processing" || f.blob_sha256 !== sha256) return null;
    const b = this.findBlob(sha256);
    return b ? { file: f, objectKey: b.object_key } : null;
  }

  /**
   * Point a processing file's current version at new bytes (e.g. with GPS removed). The old blob loses a reference
   * (other files may still share it); the new bytes join an existing blob if they match one.
   */
  swapBlob(input: { id: string; fromSha: string; toSha: string; toKey: string; toSize: number; nowIso: string }): {
    file: FileRow;
    deleteKeys: string[];
    storedBytes: number;
    releasedBytes: number;
  } {
    return this.sql.transaction(() => {
      const f = this.getFile(input.id);
      // A retried step whose swap already happened: nothing more to do.
      if (f && f.status === "processing" && f.blob_sha256 === input.toSha) return { file: f, deleteKeys: [], storedBytes: 0, releasedBytes: 0 };
      if (!f || f.status !== "processing" || f.blob_sha256 !== input.fromSha) throw new IndexError("invalid_state", "The file changed meanwhile");
      const deleteKeys: string[] = [];
      let storedBytes = 0;
      let releasedBytes = 0;
      const existing = this.findBlob(input.toSha);
      if (existing) {
        this.sql.exec(`UPDATE blobs SET refcount = refcount + 1 WHERE sha256 = ?`, input.toSha);
        if (existing.object_key !== input.toKey) deleteKeys.push(input.toKey);
      } else {
        this.sql.exec(`INSERT INTO blobs (sha256, object_key, size, refcount, created_at) VALUES (?, ?, ?, 1, ?)`, input.toSha, input.toKey, input.toSize, input.nowIso);
        storedBytes = input.toSize;
      }
      this.sql.exec(`UPDATE versions SET blob_sha256 = ?, size = ? WHERE file_id = ? AND version = ?`, input.toSha, input.toSize, f.id, f.version);
      this.sql.exec(`UPDATE files SET blob_sha256 = ?, size = ?, updated_at = ? WHERE id = ?`, input.toSha, input.toSize, input.nowIso, f.id);
      const r = this.release(input.fromSha);
      if (r) {
        deleteKeys.push(r.key);
        releasedBytes = r.size;
      }
      return { file: this.getFile(f.id)!, deleteKeys, storedBytes, releasedBytes };
    });
  }

  /** Record the pipeline's outcome, unless the file has changed since (a newer upload starts its own run). */
  finishProcessing(id: string, sha256: string, result: ProcessingResult, nowIso: string): FileRow | null {
    return this.sql.transaction(() => {
      const f = this.getFile(id);
      if (!f || f.status !== "processing" || f.blob_sha256 !== sha256) return null;
      this.sql.exec(
        `UPDATE files SET status = ?, width = COALESCE(?, width), height = COALESCE(?, height), tags = COALESCE(?, tags),
           moderation = COALESCE(?, moderation), pipeline_note = ?, updated_at = ? WHERE id = ?`,
        result.status, result.width ?? null, result.height ?? null, result.tags ? JSON.stringify(result.tags) : null,
        result.moderation ?? null, result.note ?? null, nowIso, id,
      );
      const done = this.getFile(id)!;
      this.enqueueRoute(done, nowIso);
      return done;
    });
  }

  /**
   * A person's decision on a held or flagged file. Approve serves it as its visibility says (moderation "manual");
   * reject moves it to the trash. A file held because its run failed must be replayed, not approved: its location
   * data may still be in it.
   */
  review(id: string, decision: "approve" | "reject", nowIso: string): FileRow {
    return this.sql.transaction(() => {
      const f = this.getFile(id);
      if (!f || f.status === "trashed") throw new IndexError("not_found", "File not found");
      if (f.status !== "held" && f.status !== "flagged") throw new IndexError("invalid_state", "This file isn't waiting for review");
      if (decision === "approve" && (f.pipeline_note ?? "").startsWith("failed:")) {
        throw new IndexError("invalid_state", "Processing failed for this file: process it again instead");
      }
      if (decision === "approve") {
        this.sql.exec(`UPDATE files SET status = visibility, moderation = 'manual', updated_at = ? WHERE id = ?`, nowIso, id);
      } else {
        this.sql.exec(`UPDATE files SET prev_status = status, status = 'trashed', trashed_at = ?, updated_at = ? WHERE id = ?`, nowIso, nowIso, id);
      }
      const after = this.getFile(id)!;
      this.enqueueRoute(after, nowIso);
      return after;
    });
  }

  /** Put a held or flagged file back through the pipeline (a replay). */
  reprocess(id: string, nowIso: string): FileRow {
    return this.sql.transaction(() => {
      const f = this.getFile(id);
      if (!f || f.status === "trashed") throw new IndexError("not_found", "File not found");
      if (f.status !== "held" && f.status !== "processing") throw new IndexError("invalid_state", "Only held files can be processed again");
      this.sql.exec(`UPDATE files SET status = 'processing', pipeline_note = NULL, updated_at = ? WHERE id = ?`, nowIso, id);
      return this.getFile(id)!;
    });
  }

  /** Files that have been processing since before `cutoffIso` (their run was lost or failed to start). */
  stuckProcessing(cutoffIso: string): FileRow[] {
    return this.sql.exec<FileRow>(`SELECT * FROM files WHERE status = 'processing' AND updated_at <= ? LIMIT 50`, cutoffIso).toArray();
  }

  oldestProcessingAt(): string | null {
    return one(this.sql.exec<{ t: string | null }>(`SELECT MIN(updated_at) AS t FROM files WHERE status = 'processing'`).toArray())?.t ?? null;
  }

  // ── reads ─────────────────────────────────────────────────

  findBlob(sha256: string): BlobRow | null {
    return one(this.sql.exec<BlobRow>(`SELECT sha256, object_key, size, refcount FROM blobs WHERE sha256 = ?`, sha256).toArray());
  }

  liveFileAt(path: string): FileRow | null {
    return one(this.sql.exec<FileRow>(`SELECT * FROM files WHERE path = ? AND status != 'trashed'`, path).toArray());
  }

  getFile(id: string): FileRow | null {
    return one(this.sql.exec<FileRow>(`SELECT * FROM files WHERE id = ?`, id).toArray());
  }

  blobKeyOf(file: FileRow): string | null {
    return this.findBlob(file.blob_sha256)?.object_key ?? null;
  }

  listFiles(opts: { folder?: string; status?: "live" | "trashed" | "review"; uploadedBy?: string; cursor?: string; limit: number }): {
    files: FileRow[];
    nextCursor: string | null;
  } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.status === "trashed") where.push(`status = 'trashed'`);
    else if (opts.status === "review") where.push(`status IN ('held', 'flagged')`);
    else where.push(`status != 'trashed'`);
    if (opts.folder !== undefined) {
      where.push(`folder = ?`);
      params.push(opts.folder);
    }
    if (opts.uploadedBy !== undefined) {
      where.push(`uploaded_by = ?`);
      params.push(opts.uploadedBy);
    }
    if (opts.cursor) {
      const [created, id] = opts.cursor.split("|");
      where.push(`(created_at < ? OR (created_at = ? AND id < ?))`);
      params.push(created, created, id);
    }
    const rows = this.sql
      .exec<FileRow>(`SELECT * FROM files WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`, ...params, opts.limit + 1)
      .toArray();
    const page = rows.slice(0, opts.limit);
    const last = page[page.length - 1];
    return { files: page, nextCursor: rows.length > opts.limit && last ? `${last.created_at}|${last.id}` : null };
  }

  versions(fileId: string): { version: number; blob_sha256: string; size: number; created_by: string; created_at: string }[] {
    return this.sql.exec<{ version: number; blob_sha256: string; size: number; created_by: string; created_at: string }>(
      `SELECT version, blob_sha256, size, created_by, created_at FROM versions WHERE file_id = ? ORDER BY version DESC`,
      fileId,
    ).toArray();
  }

  // ── sessions ──────────────────────────────────────────────

  openSession(s: Omit<SessionRow, "parts_json" | "state">): SessionRow {
    this.sql.exec(
      `INSERT INTO sessions (id, path, name, folder, size, sha256, mime, visibility, replace, mode, object_key,
         multipart_upload_id, part_size, part_count, parts_json, state, created_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', 'open', ?, ?, ?)`,
      s.id, s.path, s.name, s.folder, s.size, s.sha256, s.mime, s.visibility, s.replace, s.mode, s.object_key,
      s.multipart_upload_id, s.part_size, s.part_count, s.created_by, s.created_at, s.expires_at,
    );
    return this.getSession(s.id)!;
  }

  getSession(id: string): SessionRow | null {
    return one(this.sql.exec<SessionRow>(`SELECT * FROM sessions WHERE id = ?`, id).toArray());
  }

  recordPart(id: string, partNumber: number, etag: string): SessionRow {
    return this.sql.transaction(() => {
      const s = this.getSession(id);
      if (!s || s.state !== "open") throw new IndexError("invalid_state", "Session is not open");
      const parts = JSON.parse(s.parts_json) as Record<string, string>;
      parts[String(partNumber)] = etag;
      this.sql.exec(`UPDATE sessions SET parts_json = ? WHERE id = ?`, JSON.stringify(parts), id);
      return this.getSession(id)!;
    });
  }

  closeSession(id: string, state: "aborted" | "committed"): SessionRow | null {
    return this.sql.transaction(() => {
      const s = this.getSession(id);
      if (!s || s.state !== "open") return null;
      this.sql.exec(`UPDATE sessions SET state = ? WHERE id = ?`, state, id);
      return s;
    });
  }

  expiredSessions(nowIso: string): SessionRow[] {
    return this.sql.exec<SessionRow>(`SELECT * FROM sessions WHERE state = 'open' AND expires_at <= ?`, nowIso).toArray();
  }

  nextSessionExpiry(): string | null {
    return one(this.sql.exec<{ e: string | null }>(`SELECT MIN(expires_at) AS e FROM sessions WHERE state = 'open'`).toArray())?.e ?? null;
  }

  // ── commits ───────────────────────────────────────────────

  /**
   * Turn verified bytes into a file, in one transaction. `objectKey` holds the bytes just uploaded (or null for a
   * dedup link with no upload). If the library already has a blob with this hash, the new object is redundant and
   * is returned in deleteKeys.
   */
  commit(input: {
    sessionId?: string;
    fileId: string;
    path: string;
    name: string;
    folder: string;
    size: number;
    sha256: string;
    mime: string;
    visibility: "public" | "private";
    replace: boolean;
    objectKey: string | null;
    actor: string;
    nowIso: string;
    /** The file must pass the pipeline before it is served (images, and public uploads on a free plan). */
    processing?: boolean;
  }): CommitResult {
    return this.sql.transaction(() => {
      if (input.sessionId) {
        const s = this.getSession(input.sessionId);
        if (!s || s.state !== "open") throw new IndexError("invalid_state", "Session is not open");
        this.sql.exec(`UPDATE sessions SET state = 'committed' WHERE id = ?`, input.sessionId);
      }
      const existing = this.liveFileAt(input.path);
      if (existing && !input.replace) throw new IndexError("conflict", "A file already exists at this path");
      if (existing?.status === "removed") throw new IndexError("forbidden", "This file was taken down and can't be replaced");
      const status = input.processing ? "processing" : existing ? existing.visibility : input.visibility;

      const deleteKeys: string[] = [];
      let releasedBytes = 0;
      let storedBytes = 0;
      let deduplicated = false;
      const blob = this.findBlob(input.sha256);
      if (blob) {
        deduplicated = true;
        this.sql.exec(`UPDATE blobs SET refcount = refcount + 1 WHERE sha256 = ?`, input.sha256);
        if (input.objectKey && input.objectKey !== blob.object_key) deleteKeys.push(input.objectKey);
      } else {
        if (!input.objectKey) throw new IndexError("invalid_state", "No bytes to commit");
        this.sql.exec(
          `INSERT INTO blobs (sha256, object_key, size, refcount, created_at) VALUES (?, ?, ?, 1, ?)`,
          input.sha256, input.objectKey, input.size, input.nowIso,
        );
        storedBytes = input.size;
      }

      let fileId = input.fileId;
      let version = 1;
      if (existing) {
        fileId = existing.id;
        version = existing.version + 1;
        // New bytes: earlier pipeline results no longer apply.
        this.sql.exec(
          `UPDATE files SET blob_sha256 = ?, size = ?, mime = ?, version = ?, status = ?, prev_status = NULL, width = NULL,
             height = NULL, tags = NULL, moderation = NULL, pipeline_note = NULL, updated_at = ? WHERE id = ?`,
          input.sha256, input.size, input.mime, version, status, input.nowIso, fileId,
        );
      } else {
        this.sql.exec(
          `INSERT INTO files (id, path, name, folder, blob_sha256, size, mime, visibility, status, prev_status, version,
             uploaded_by, created_at, updated_at, trashed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, ?, NULL)`,
          fileId, input.path, input.name, input.folder, input.sha256, input.size, input.mime, input.visibility,
          status, input.actor, input.nowIso, input.nowIso,
        );
      }
      this.sql.exec(
        `INSERT INTO versions (file_id, version, blob_sha256, size, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        fileId, version, input.sha256, input.size, input.actor, input.nowIso,
      );

      // Keep the newest MAX_VERSIONS versions; older ones release their blob reference.
      const old = this.sql
        .exec<{ version: number; blob_sha256: string }>(
          `SELECT version, blob_sha256 FROM versions WHERE file_id = ? ORDER BY version DESC LIMIT -1 OFFSET ?`,
          fileId, MAX_VERSIONS,
        )
        .toArray();
      for (const v of old) {
        this.sql.exec(`DELETE FROM versions WHERE file_id = ? AND version = ?`, fileId, v.version);
        const released = this.release(v.blob_sha256);
        if (released) {
          deleteKeys.push(released.key);
          releasedBytes += released.size;
        }
      }
      const file = this.getFile(fileId)!;
      this.enqueueRoute(file, input.nowIso);
      return { file, deduplicated, storedBytes, deleteKeys, releasedBytes };
    });
  }

  /** Drop one reference to a blob; at zero, forget the blob and return its object to delete. */
  private release(sha256: string): { key: string; size: number } | null {
    this.sql.exec(`UPDATE blobs SET refcount = refcount - 1 WHERE sha256 = ?`, sha256);
    const b = this.findBlob(sha256);
    if (b && b.refcount <= 0) {
      this.sql.exec(`DELETE FROM blobs WHERE sha256 = ?`, sha256);
      return { key: b.object_key, size: b.size };
    }
    return null;
  }

  // ── trash ─────────────────────────────────────────────────

  trash(id: string, nowIso: string): FileRow {
    return this.sql.transaction(() => {
      const f = this.getFile(id);
      if (!f || f.status === "trashed") throw new IndexError("not_found", "File not found");
      this.sql.exec(`UPDATE files SET prev_status = status, status = 'trashed', trashed_at = ?, updated_at = ? WHERE id = ?`, nowIso, nowIso, id);
      const trashed = this.getFile(id)!;
      this.enqueueRoute(trashed, nowIso);
      return trashed;
    });
  }

  restore(id: string, nowIso: string): FileRow {
    return this.sql.transaction(() => {
      const f = this.getFile(id);
      if (!f || f.status !== "trashed") throw new IndexError("not_found", "File not in trash");
      if (this.liveFileAt(f.path)) throw new IndexError("conflict", "Another file now uses this path");
      this.sql.exec(
        `UPDATE files SET status = COALESCE(prev_status, visibility), prev_status = NULL, trashed_at = NULL, updated_at = ? WHERE id = ?`,
        nowIso, id,
      );
      const restored = this.getFile(id)!;
      this.enqueueRoute(restored, nowIso);
      return restored;
    });
  }

  /** Delete a trashed file for good: every version releases its blob; blobs at refcount 0 are returned. */
  purge(id: string): { deleteKeys: string[]; releasedBytes: number } {
    return this.sql.transaction(() => {
      const f = this.getFile(id);
      if (!f || f.status !== "trashed") throw new IndexError("not_found", "File not in trash");
      const vs = this.versions(id);
      const deleteKeys: string[] = [];
      let releasedBytes = 0;
      this.sql.exec(`DELETE FROM versions WHERE file_id = ?`, id);
      for (const v of vs) {
        const r = this.release(v.blob_sha256);
        if (r) {
          deleteKeys.push(r.key);
          releasedBytes += r.size;
        }
      }
      this.sql.exec(`DELETE FROM files WHERE id = ?`, id);
      return { deleteKeys, releasedBytes };
    });
  }

  trashedBefore(cutoffIso: string): string[] {
    return this.sql
      .exec<{ id: string }>(`SELECT id FROM files WHERE status = 'trashed' AND trashed_at <= ? LIMIT 500`, cutoffIso)
      .toArray()
      .map((r) => r.id);
  }

  oldestTrashedAt(): string | null {
    return one(this.sql.exec<{ t: string | null }>(`SELECT MIN(trashed_at) AS t FROM files WHERE status = 'trashed'`).toArray())?.t ?? null;
  }

  /** Make an older version current again (a new version pointing at the old bytes). */
  restoreVersion(id: string, version: number, actor: string, nowIso: string, processing = false): FileRow {
    return this.sql.transaction(() => {
      const f = this.getFile(id);
      if (!f || f.status === "trashed") throw new IndexError("not_found", "File not found");
      const v = one(
        this.sql.exec<{ blob_sha256: string; size: number }>(`SELECT blob_sha256, size FROM versions WHERE file_id = ? AND version = ?`, id, version).toArray(),
      );
      if (!v) throw new IndexError("not_found", "Version not found");
      const next = f.version + 1;
      this.sql.exec(`UPDATE blobs SET refcount = refcount + 1 WHERE sha256 = ?`, v.blob_sha256);
      this.sql.exec(`INSERT INTO versions (file_id, version, blob_sha256, size, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`, id, next, v.blob_sha256, v.size, actor, nowIso);
      if (f.status === "removed") throw new IndexError("forbidden", "This file was taken down");
      this.sql.exec(
        `UPDATE files SET blob_sha256 = ?, size = ?, version = ?, status = ?, width = NULL, height = NULL, tags = NULL,
           moderation = NULL, pipeline_note = NULL, updated_at = ? WHERE id = ?`,
        v.blob_sha256, v.size, next, processing ? "processing" : f.visibility, nowIso, id,
      );
      const current = this.getFile(id)!;
      this.enqueueRoute(current, nowIso);
      return current;
    });
  }
}
