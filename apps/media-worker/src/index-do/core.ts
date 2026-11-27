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
  status: "processing" | "held" | "public" | "private" | "flagged" | "trashed";
  prev_status: string | null;
  version: number;
  uploaded_by: string;
  created_at: string;
  updated_at: string;
  trashed_at: string | null;
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
`;

const one = <T>(rows: T[]): T | null => rows[0] ?? null;

export class LibraryIndexCore {
  constructor(private readonly sql: Sql) {
    for (const stmt of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) this.sql.exec(stmt);
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

  listFiles(opts: { folder?: string; status?: "live" | "trashed"; uploadedBy?: string; cursor?: string; limit: number }): {
    files: FileRow[];
    nextCursor: string | null;
  } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.status === "trashed") where.push(`status = 'trashed'`);
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
  }): CommitResult {
    return this.sql.transaction(() => {
      if (input.sessionId) {
        const s = this.getSession(input.sessionId);
        if (!s || s.state !== "open") throw new IndexError("invalid_state", "Session is not open");
        this.sql.exec(`UPDATE sessions SET state = 'committed' WHERE id = ?`, input.sessionId);
      }
      const existing = this.liveFileAt(input.path);
      if (existing && !input.replace) throw new IndexError("conflict", "A file already exists at this path");

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
        this.sql.exec(
          `UPDATE files SET blob_sha256 = ?, size = ?, mime = ?, version = ?, updated_at = ? WHERE id = ?`,
          input.sha256, input.size, input.mime, version, input.nowIso, fileId,
        );
      } else {
        this.sql.exec(
          `INSERT INTO files (id, path, name, folder, blob_sha256, size, mime, visibility, status, prev_status, version,
             uploaded_by, created_at, updated_at, trashed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, ?, NULL)`,
          fileId, input.path, input.name, input.folder, input.sha256, input.size, input.mime, input.visibility,
          input.visibility, input.actor, input.nowIso, input.nowIso,
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
      return { file: this.getFile(fileId)!, deduplicated, storedBytes, deleteKeys, releasedBytes };
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
      return this.getFile(id)!;
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
      return this.getFile(id)!;
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
  restoreVersion(id: string, version: number, actor: string, nowIso: string): FileRow {
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
      this.sql.exec(`UPDATE files SET blob_sha256 = ?, size = ?, version = ?, updated_at = ? WHERE id = ?`, v.blob_sha256, v.size, next, nowIso, id);
      return this.getFile(id)!;
    });
  }
}
