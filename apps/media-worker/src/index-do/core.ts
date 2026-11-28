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
  /** Who is acting (usr_…, upl_…, "pipeline", "operator"), for the activity log; not part of the scope check. */
  actor?: string;
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
  /** 1: held for review after the pipeline (upload-link uploads, PV6). */
  review_required?: number;
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

/** pipeline_note of a file held because it came through an upload link and waits for review. */
export const REVIEW_NOTE = "review:upload_link";

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
CREATE TABLE IF NOT EXISTS folders (
  path TEXT PRIMARY KEY, parent TEXT, name TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS folders_parent ON folders (parent);
CREATE TABLE IF NOT EXISTS fts_map (file_id TEXT PRIMARY KEY, fts_rowid INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', public_gallery INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS collection_items (
  collection_id TEXT NOT NULL, file_id TEXT NOT NULL, position INTEGER NOT NULL, added_at TEXT NOT NULL,
  PRIMARY KEY (collection_id, file_id));
CREATE INDEX IF NOT EXISTS collection_items_order ON collection_items (collection_id, position);
CREATE INDEX IF NOT EXISTS collection_items_file ON collection_items (file_id);
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY, file_id TEXT NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL, mentions_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL, edited_at TEXT, resolved_at TEXT, resolved_by TEXT);
CREATE INDEX IF NOT EXISTS comments_file ON comments (file_id, created_at);
CREATE TABLE IF NOT EXISTS activity (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, op TEXT NOT NULL, file_id TEXT, folder TEXT,
  detail TEXT NOT NULL DEFAULT '{}');
CREATE INDEX IF NOT EXISTS activity_file ON activity (file_id, seq);
CREATE TABLE IF NOT EXISTS live_tickets (
  ticket TEXT PRIMARY KEY, subject TEXT NOT NULL, scope TEXT NOT NULL, expires_at TEXT NOT NULL);
`;

// Search (PV5): FTS5 over each file's name, folder and tags, kept in step with `files` by triggers, so every write
// path (commit, move, pipeline tags, purge) updates it in the same transaction. fts_map ties a file to its FTS row,
// so an update touches one row instead of scanning the index. Triggers hold semicolons, so these run one by one.
const SEARCH_DDL = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(name, folder, tags, tokenize = "unicode61 remove_diacritics 2")`,
  `CREATE TRIGGER IF NOT EXISTS files_fts_ai AFTER INSERT ON files BEGIN
     INSERT INTO files_fts (name, folder, tags) VALUES (new.name, new.folder, COALESCE(new.tags, ''));
     INSERT INTO fts_map (file_id, fts_rowid) VALUES (new.id, last_insert_rowid());
   END`,
  `CREATE TRIGGER IF NOT EXISTS files_fts_au AFTER UPDATE OF name, folder, tags ON files BEGIN
     UPDATE files_fts SET name = new.name, folder = new.folder, tags = COALESCE(new.tags, '')
       WHERE rowid = (SELECT fts_rowid FROM fts_map WHERE file_id = new.id);
   END`,
  `CREATE TRIGGER IF NOT EXISTS files_fts_ad AFTER DELETE ON files BEGIN
     DELETE FROM files_fts WHERE rowid = (SELECT fts_rowid FROM fts_map WHERE file_id = old.id);
     DELETE FROM fts_map WHERE file_id = old.id;
   END`,
];

/** The most files one batch request may name. */
export const MAX_BATCH = 1000;

export type FileType = "image" | "video" | "audio" | "document" | "other";

const DOCUMENT_MIME = `(mime = 'application/pdf' OR mime LIKE 'text/%' OR mime = 'application/msword' OR mime LIKE 'application/vnd.%' OR mime = 'application/rtf')`;
const TYPE_SQL: Record<FileType, string> = {
  image: `mime LIKE 'image/%'`,
  video: `mime LIKE 'video/%'`,
  audio: `mime LIKE 'audio/%'`,
  document: DOCUMENT_MIME,
  other: `NOT (mime LIKE 'image/%' OR mime LIKE 'video/%' OR mime LIKE 'audio/%' OR ${DOCUMENT_MIME})`,
};

export interface ListFilter {
  folder?: string;
  status?: "live" | "trashed" | "review";
  uploadedBy?: string;
  /** Words to search for in names, folders and tags (each one a prefix). */
  q?: string;
  type?: FileType;
  tag?: string;
  /** One exact status among live files. */
  fileStatus?: Exclude<FileRow["status"], "trashed">;
  visibility?: "public" | "private";
  /** This folder and every folder under it (a shared folder). */
  under?: string;
  /** Only files that are being served (public or private): what a share link may show. */
  servedOnly?: boolean;
  /** created_at bounds, ISO. */
  from?: string;
  to?: string;
  cursor?: string;
  limit: number;
}

export interface FolderRow {
  path: string;
  parent: string | null;
  name: string;
  /** Live files directly in this folder. */
  files: number;
}

export type BatchAction =
  | { action: "move"; folder: string }
  | { action: "trash" }
  | { action: "restore" }
  | { action: "visibility"; visibility: "public" | "private"; requireSafety: boolean };

/** What a live socket may see: every file's changes, or only the holder's own uploads. */
export type LiveScope = "all" | "own";

export interface CollectionRow {
  id: string;
  name: string;
  description: string;
  public_gallery: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  /** Live files in it (trashed ones are hidden). */
  files: number;
  /** The first live image, for a cover. */
  cover_file_id: string | null;
}

export interface CommentRow {
  id: string;
  file_id: string;
  author: string;
  body: string;
  mentions_json: string;
  created_at: string;
  edited_at: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
}

export interface ActivityRow {
  seq: number;
  at: string;
  actor: string;
  op: string;
  file_id: string | null;
  folder: string | null;
  detail: string;
}

export interface ActivityInput {
  op: string;
  fileId?: string | null;
  folder?: string | null;
  detail?: Record<string, string | number | boolean | null>;
}

/** The newest entries kept per library. */
export const ACTIVITY_KEEP = 10_000;
export const MAX_COMMENTS_PER_FILE = 1000;
export const MAX_COLLECTION_ITEMS = 5000;
export const MAX_COLLECTIONS = 500;

export interface BatchResult {
  done: FileRow[];
  failed: { id: string; code: string }[];
}

/** "/a/b" → ["/a", "/a/b"]; "/" → []. */
export function folderChain(folder: string): string[] {
  const parts = folder.split("/").filter(Boolean);
  return parts.map((_, i) => `/${parts.slice(0, i + 1).join("/")}`);
}

export const joinPath = (folder: string, name: string) => (folder === "/" ? `/${name}` : `${folder}/${name}`);

/** Turn free text into an FTS5 query: each word quoted, as a prefix, all of them required. */
export function ftsQuery(q: string): string | null {
  const words = q
    .normalize("NFKC")
    .split(/[\s"*^():{}\[\]+\-.,/\\_]+/u)
    .filter((w) => w.length > 0)
    .slice(0, 8);
  return words.length ? words.map((w) => `"${w.replace(/"/g, "")}"*`).join(" ") : null;
}

// Columns added after a library's index was created. CREATE TABLE IF NOT EXISTS never adds columns, so each index
// adds the ones it lacks when it starts.
const ADDED_COLUMNS: [table: string, column: string, ddl: string][] = [
  ["files", "width", "INTEGER"],
  ["files", "height", "INTEGER"],
  ["files", "tags", "TEXT"],
  ["files", "moderation", "TEXT"],
  ["files", "pipeline_note", "TEXT"],
  // PV6: 1 for a file that waits for a person's review after the pipeline (an upload-link upload).
  ["files", "review_required", "INTEGER NOT NULL DEFAULT 0"],
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
    for (const stmt of SEARCH_DDL) this.sql.exec(stmt);
    // An index created before PV5: fill the search index and the folder table from the files it already has.
    if (!one(this.sql.exec(`SELECT 1 AS x FROM meta WHERE key = 'browse_v' AND value = '1'`).toArray())) {
      this.sql.transaction(() => {
        this.sql.exec(`DELETE FROM files_fts`);
        this.sql.exec(`DELETE FROM fts_map`);
        for (const f of this.sql.exec<{ id: string; name: string; folder: string; tags: string | null }>(`SELECT id, name, folder, tags FROM files`).toArray()) {
          this.sql.exec(`INSERT INTO files_fts (name, folder, tags) VALUES (?, ?, ?)`, f.name, f.folder, f.tags ?? "");
          this.sql.exec(`INSERT INTO fts_map (file_id, fts_rowid) VALUES (?, last_insert_rowid())`, f.id);
        }
        const created = new Date().toISOString();
        for (const r of this.sql.exec<{ folder: string }>(`SELECT DISTINCT folder FROM files`).toArray()) this.ensureFolders(r.folder, "system", created);
        this.sql.exec(`INSERT INTO meta (key, value) VALUES ('browse_v', '1') ON CONFLICT (key) DO UPDATE SET value = '1'`);
      });
    }
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

  private enqueueRouteDelete(path: string, nowIso: string): void {
    this.sql.exec(`INSERT INTO outbox (op, path, value, created_at) VALUES ('route.delete', ?, NULL, ?)`, path, nowIso);
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
    return this.sql.transaction(() => this.setVisibilityTx(id, visibility, nowIso, requireSafety));
  }

  private setVisibilityTx(id: string, visibility: "public" | "private", nowIso: string, requireSafety: boolean): FileRow {
    {
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
    }
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
    // New bytes written during a migration could land behind its copy; the pipeline step retries after it.
    if (this.switchLocked(input.nowIso)) throw new IndexError("invalid_state", "This library's storage is changing");
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
      // A file that must be reviewed waits in the queue even when the pipeline would serve it.
      const hold = f.review_required === 1 && (result.status === "public" || result.status === "private");
      this.sql.exec(
        `UPDATE files SET status = ?, width = COALESCE(?, width), height = COALESCE(?, height), tags = COALESCE(?, tags),
           moderation = COALESCE(?, moderation), pipeline_note = ?, updated_at = ? WHERE id = ?`,
        hold ? "held" : result.status, result.width ?? null, result.height ?? null, result.tags ? JSON.stringify(result.tags) : null,
        result.moderation ?? null, hold ? REVIEW_NOTE : (result.note ?? null), nowIso, id,
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
        this.sql.exec(`UPDATE files SET status = visibility, moderation = 'manual', review_required = 0, updated_at = ? WHERE id = ?`, nowIso, id);
      } else {
        this.sql.exec(`UPDATE files SET prev_status = status, status = 'trashed', trashed_at = ?, updated_at = ? WHERE id = ?`, nowIso, nowIso, id);
      }
      const after = this.getFile(id)!;
      this.enqueueRoute(after, nowIso);
      return after;
    });
  }

  /** Take a file down (an operator's decision): serving answers 451 for it from the next route read. */
  takedown(id: string, note: string, nowIso: string): FileRow {
    return this.sql.transaction(() => {
      const f = this.getFile(id);
      if (!f) throw new IndexError("not_found", "File not found");
      if (f.status === "removed") return f;
      // A trashed file keeps its trash state but remembers the takedown for a restore.
      if (f.status === "trashed") {
        this.sql.exec(`UPDATE files SET prev_status = 'removed', pipeline_note = ?, updated_at = ? WHERE id = ?`, note, nowIso, id);
        return this.getFile(id)!;
      }
      this.sql.exec(`UPDATE files SET prev_status = status, status = 'removed', pipeline_note = ?, updated_at = ? WHERE id = ?`, note, nowIso, id);
      const after = this.getFile(id)!;
      this.enqueueRoute(after, nowIso);
      return after;
    });
  }

  /** Undo a takedown. A file that was mid-pipeline comes back as its visibility; the next replay can recheck it. */
  reinstate(id: string, nowIso: string): FileRow {
    return this.sql.transaction(() => {
      const f = this.getFile(id);
      if (!f || f.status !== "removed") throw new IndexError("invalid_state", "This file isn't taken down");
      const prev = f.prev_status && f.prev_status !== "processing" && f.prev_status !== "removed" ? f.prev_status : f.visibility;
      this.sql.exec(`UPDATE files SET status = ?, prev_status = NULL, pipeline_note = NULL, updated_at = ? WHERE id = ?`, prev, nowIso, id);
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

  listFiles(opts: ListFilter): { files: FileRow[]; nextCursor: string | null } {
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
    if (opts.under !== undefined && opts.under !== "/") {
      const prefix = `${opts.under}/`;
      where.push(`(folder = ? OR substr(folder, 1, ?) = ?)`);
      params.push(opts.under, prefix.length, prefix);
    }
    if (opts.servedOnly) where.push(`status IN ('public', 'private')`);
    if (opts.q !== undefined) {
      const match = ftsQuery(opts.q);
      if (match) {
        where.push(`id IN (SELECT m.file_id FROM fts_map m WHERE m.fts_rowid IN (SELECT rowid FROM files_fts WHERE files_fts MATCH ?))`);
        params.push(match);
      }
    }
    if (opts.type) where.push(TYPE_SQL[opts.type]);
    if (opts.tag !== undefined) {
      where.push(`EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(tags) THEN tags ELSE '[]' END) WHERE value = ?)`);
      params.push(opts.tag);
    }
    if (opts.fileStatus !== undefined) {
      where.push(`status = ?`);
      params.push(opts.fileStatus);
    }
    if (opts.visibility !== undefined) {
      where.push(`visibility = ?`);
      params.push(opts.visibility);
    }
    if (opts.from !== undefined) {
      where.push(`created_at >= ?`);
      params.push(opts.from);
    }
    if (opts.to !== undefined) {
      where.push(`created_at < ?`);
      params.push(opts.to);
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

  // ── activity (PV6): who did what to which file ────────────

  recordActivity(actor: string, entries: ActivityInput[], nowIso: string): void {
    if (!entries.length) return;
    this.sql.transaction(() => {
      for (const e of entries) {
        this.sql.exec(
          `INSERT INTO activity (at, actor, op, file_id, folder, detail) VALUES (?, ?, ?, ?, ?, ?)`,
          nowIso, actor, e.op, e.fileId ?? null, e.folder ?? null, JSON.stringify(e.detail ?? {}),
        );
      }
      const last = Number(one(this.sql.exec<{ s: number }>(`SELECT MAX(seq) AS s FROM activity`).toArray())?.s ?? 0);
      // Prune now and then, not on every write.
      if (last % 200 < entries.length) this.sql.exec(`DELETE FROM activity WHERE seq <= ?`, last - ACTIVITY_KEEP);
    });
  }

  /** Newest first; `before` is a seq cursor. */
  listActivity(opts: { fileId?: string; before?: number; limit: number }): { entries: ActivityRow[]; nextCursor: number | null } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.fileId) {
      where.push(`file_id = ?`);
      params.push(opts.fileId);
    }
    if (opts.before) {
      where.push(`seq < ?`);
      params.push(opts.before);
    }
    const rows = this.sql
      .exec<ActivityRow>(`SELECT * FROM activity ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY seq DESC LIMIT ?`, ...params, opts.limit + 1)
      .toArray();
    const page = rows.slice(0, opts.limit);
    return { entries: page, nextCursor: rows.length > opts.limit ? page[page.length - 1]!.seq : null };
  }

  // ── comments (PV6) ────────────────────────────────────────

  listComments(fileId: string): CommentRow[] {
    // rowid breaks ties between comments made in the same millisecond: insertion order.
    return this.sql.exec<CommentRow>(`SELECT * FROM comments WHERE file_id = ? ORDER BY created_at, rowid LIMIT ?`, fileId, MAX_COMMENTS_PER_FILE).toArray();
  }

  getComment(id: string): CommentRow | null {
    return one(this.sql.exec<CommentRow>(`SELECT * FROM comments WHERE id = ?`, id).toArray());
  }

  addComment(input: { id: string; fileId: string; author: string; body: string; mentions: string[]; nowIso: string }): CommentRow {
    return this.sql.transaction(() => {
      const f = this.getFile(input.fileId);
      if (!f || f.status === "trashed") throw new IndexError("not_found", "File not found");
      const n = Number(one(this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM comments WHERE file_id = ?`, input.fileId).toArray())?.n ?? 0);
      if (n >= MAX_COMMENTS_PER_FILE) throw new IndexError("invalid_state", `At most ${MAX_COMMENTS_PER_FILE} comments on a file`);
      this.sql.exec(
        `INSERT INTO comments (id, file_id, author, body, mentions_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        input.id, input.fileId, input.author, input.body, JSON.stringify(input.mentions), input.nowIso,
      );
      return this.getComment(input.id)!;
    });
  }

  editComment(id: string, fileId: string, body: string, nowIso: string): CommentRow {
    return this.sql.transaction(() => {
      const c = this.getComment(id);
      if (!c || c.file_id !== fileId) throw new IndexError("not_found", "Comment not found");
      this.sql.exec(`UPDATE comments SET body = ?, edited_at = ? WHERE id = ?`, body, nowIso, id);
      return this.getComment(id)!;
    });
  }

  resolveComment(id: string, fileId: string, resolved: boolean, by: string, nowIso: string): CommentRow {
    return this.sql.transaction(() => {
      const c = this.getComment(id);
      if (!c || c.file_id !== fileId) throw new IndexError("not_found", "Comment not found");
      this.sql.exec(`UPDATE comments SET resolved_at = ?, resolved_by = ? WHERE id = ?`, resolved ? nowIso : null, resolved ? by : null, id);
      return this.getComment(id)!;
    });
  }

  deleteComment(id: string, fileId: string): void {
    this.sql.transaction(() => {
      const c = this.getComment(id);
      if (!c || c.file_id !== fileId) throw new IndexError("not_found", "Comment not found");
      this.sql.exec(`DELETE FROM comments WHERE id = ?`, id);
    });
  }

  // ── collections (PV6): ordered sets of files; a public one is a gallery ──

  private collectionRow(where: string, ...params: unknown[]): CollectionRow[] {
    return this.sql
      .exec<CollectionRow>(
        `SELECT c.*,
           (SELECT COUNT(*) FROM collection_items i JOIN files f ON f.id = i.file_id WHERE i.collection_id = c.id AND f.status != 'trashed') AS files,
           (SELECT i.file_id FROM collection_items i JOIN files f ON f.id = i.file_id
              WHERE i.collection_id = c.id AND f.status != 'trashed' AND f.mime LIKE 'image/%' ORDER BY i.position LIMIT 1) AS cover_file_id
         FROM collections c ${where}`,
        ...params,
      )
      .toArray();
  }

  createCollection(input: { id: string; name: string; description: string; publicGallery: boolean; actor: string; nowIso: string }): CollectionRow {
    return this.sql.transaction(() => {
      const n = Number(one(this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM collections`).toArray())?.n ?? 0);
      if (n >= MAX_COLLECTIONS) throw new IndexError("invalid_state", `At most ${MAX_COLLECTIONS} collections in a library`);
      this.sql.exec(
        `INSERT INTO collections (id, name, description, public_gallery, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        input.id, input.name, input.description, input.publicGallery ? 1 : 0, input.actor, input.nowIso, input.nowIso,
      );
      return this.collectionRow(`WHERE c.id = ?`, input.id)[0]!;
    });
  }

  listCollections(): CollectionRow[] {
    return this.collectionRow(`ORDER BY c.updated_at DESC LIMIT ?`, MAX_COLLECTIONS);
  }

  getCollection(id: string): CollectionRow | null {
    return this.collectionRow(`WHERE c.id = ?`, id)[0] ?? null;
  }

  updateCollection(id: string, patch: { name?: string; description?: string; publicGallery?: boolean }, nowIso: string): CollectionRow {
    return this.sql.transaction(() => {
      if (!this.getCollection(id)) throw new IndexError("not_found", "Collection not found");
      if (patch.name !== undefined) this.sql.exec(`UPDATE collections SET name = ? WHERE id = ?`, patch.name, id);
      if (patch.description !== undefined) this.sql.exec(`UPDATE collections SET description = ? WHERE id = ?`, patch.description, id);
      if (patch.publicGallery !== undefined) this.sql.exec(`UPDATE collections SET public_gallery = ? WHERE id = ?`, patch.publicGallery ? 1 : 0, id);
      this.sql.exec(`UPDATE collections SET updated_at = ? WHERE id = ?`, nowIso, id);
      return this.getCollection(id)!;
    });
  }

  deleteCollection(id: string): void {
    this.sql.transaction(() => {
      if (!this.getCollection(id)) throw new IndexError("not_found", "Collection not found");
      this.sql.exec(`DELETE FROM collection_items WHERE collection_id = ?`, id);
      this.sql.exec(`DELETE FROM collections WHERE id = ?`, id);
    });
  }

  /** Add files (to the end, in the order given) or remove them. Unknown or trashed files are reported, not added. */
  collectionItems(id: string, action: "add" | "remove", fileIds: string[], nowIso: string): { collection: CollectionRow; changed: number; failed: string[] } {
    return this.sql.transaction(() => {
      if (!this.getCollection(id)) throw new IndexError("not_found", "Collection not found");
      let changed = 0;
      const failed: string[] = [];
      if (action === "remove") {
        for (const f of new Set(fileIds)) {
          const before = Number(one(this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM collection_items WHERE collection_id = ? AND file_id = ?`, id, f).toArray())?.n ?? 0);
          this.sql.exec(`DELETE FROM collection_items WHERE collection_id = ? AND file_id = ?`, id, f);
          changed += before;
        }
      } else {
        let size = Number(one(this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM collection_items WHERE collection_id = ?`, id).toArray())?.n ?? 0);
        let pos = Number(one(this.sql.exec<{ p: number | null }>(`SELECT MAX(position) AS p FROM collection_items WHERE collection_id = ?`, id).toArray())?.p ?? 0);
        for (const f of new Set(fileIds)) {
          const file = this.getFile(f);
          if (!file || file.status === "trashed") {
            failed.push(f);
            continue;
          }
          if (one(this.sql.exec(`SELECT 1 AS x FROM collection_items WHERE collection_id = ? AND file_id = ?`, id, f).toArray())) continue;
          if (size >= MAX_COLLECTION_ITEMS) throw new IndexError("invalid_state", `At most ${MAX_COLLECTION_ITEMS} files in a collection`);
          this.sql.exec(`INSERT INTO collection_items (collection_id, file_id, position, added_at) VALUES (?, ?, ?, ?)`, id, f, ++pos, nowIso);
          size++;
          changed++;
        }
      }
      this.sql.exec(`UPDATE collections SET updated_at = ? WHERE id = ?`, nowIso, id);
      return { collection: this.getCollection(id)!, changed, failed };
    });
  }

  /** A collection's files in order: every live file, or (servedOnly) only those being served. */
  collectionFiles(id: string, opts: { servedOnly?: boolean; publicOnly?: boolean; limit: number }): FileRow[] {
    const status = opts.publicOnly ? `f.status = 'public' AND f.visibility = 'public'` : opts.servedOnly ? `f.status IN ('public', 'private')` : `f.status != 'trashed'`;
    return this.sql
      .exec<FileRow>(`SELECT f.* FROM collection_items i JOIN files f ON f.id = i.file_id WHERE i.collection_id = ? AND ${status} ORDER BY i.position LIMIT ?`, id, opts.limit)
      .toArray();
  }

  inCollection(id: string, fileId: string): boolean {
    return !!one(this.sql.exec(`SELECT 1 AS x FROM collection_items WHERE collection_id = ? AND file_id = ?`, id, fileId).toArray());
  }

  /** A public gallery: the collection if it is one, with its public files only. */
  gallery(id: string, limit = 500): { collection: CollectionRow; files: FileRow[] } | null {
    const c = this.getCollection(id);
    if (!c || c.public_gallery !== 1) return null;
    return { collection: c, files: this.collectionFiles(id, { publicOnly: true, limit }) };
  }

  // ── live tickets (PV5): one-use passes for the library's WebSocket ──

  /**
   * A one-use ticket for opening this library's live socket, for someone the API has just authorised. Browsers can't
   * send an Authorization header on a WebSocket, so the socket presents this instead. It lives in this index only.
   */
  issueTicket(subject: string, scope: LiveScope, nowIso: string, ttlMs = 60_000): { ticket: string; expiresAt: string } {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const ticket = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    const expiresAt = new Date(Date.parse(nowIso) + ttlMs).toISOString();
    this.sql.exec(`DELETE FROM live_tickets WHERE expires_at <= ?`, nowIso);
    this.sql.exec(`INSERT INTO live_tickets (ticket, subject, scope, expires_at) VALUES (?, ?, ?, ?)`, ticket, subject, scope, expiresAt);
    return { ticket, expiresAt };
  }

  /** Use a ticket up: who it was for, or null if it is unknown, used or expired. */
  consumeTicket(ticket: string, nowIso: string): { subject: string; scope: LiveScope } | null {
    return this.sql.transaction(() => {
      const t = one(this.sql.exec<{ subject: string; scope: LiveScope; expires_at: string }>(`SELECT subject, scope, expires_at FROM live_tickets WHERE ticket = ?`, ticket).toArray());
      if (!t) return null;
      this.sql.exec(`DELETE FROM live_tickets WHERE ticket = ?`, ticket);
      return t.expires_at > nowIso ? { subject: t.subject, scope: t.scope } : null;
    });
  }

  // ── folders, moves and batches (PV5) ──────────────────────

  /** Make sure `folder` and each of its ancestors has a row. */
  private ensureFolders(folder: string, actor: string, nowIso: string): void {
    for (const path of folderChain(folder)) {
      const cut = path.lastIndexOf("/");
      const parent = cut === 0 ? "/" : path.slice(0, cut);
      this.sql.exec(
        `INSERT INTO folders (path, parent, name, created_by, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (path) DO NOTHING`,
        path, parent, path.slice(cut + 1), actor, nowIso,
      );
    }
  }

  createFolder(folder: string, actor: string, nowIso: string): FolderRow {
    if (folder === "/") throw new IndexError("invalid_state", "The root folder always exists");
    this.sql.transaction(() => this.ensureFolders(folder, actor, nowIso));
    return this.listFolders().find((f) => f.path === folder)!;
  }

  /** Every folder, with the number of live files directly in each. */
  listFolders(limit = 5000): FolderRow[] {
    return this.sql
      .exec<FolderRow>(
        `SELECT d.path, d.parent, d.name, COALESCE(c.n, 0) AS files FROM folders d
           LEFT JOIN (SELECT folder, COUNT(*) AS n FROM files WHERE status != 'trashed' GROUP BY folder) c ON c.folder = d.path
         ORDER BY d.path LIMIT ?`,
        limit,
      )
      .toArray();
  }

  /**
   * The folders holding someone's own live files, and their ancestors, with counts of their files only. For members
   * who may list only their own uploads: other people's folder names stay hidden (OWASP A01).
   */
  listFoldersOf(uploadedBy: string): FolderRow[] {
    const counts = new Map<string, number>();
    for (const r of this.sql
      .exec<{ folder: string; n: number }>(`SELECT folder, COUNT(*) AS n FROM files WHERE uploaded_by = ? AND status != 'trashed' GROUP BY folder`, uploadedBy)
      .toArray()) {
      counts.set(r.folder, Number(r.n));
    }
    const paths = new Set<string>();
    for (const f of counts.keys()) for (const p of folderChain(f)) paths.add(p);
    return [...paths].sort().map((path) => {
      const cut = path.lastIndexOf("/");
      return { path, parent: cut === 0 ? "/" : path.slice(0, cut), name: path.slice(cut + 1), files: counts.get(path) ?? 0 };
    });
  }

  /** Tags on live files, most used first. */
  listTags(limit = 200): { tag: string; files: number }[] {
    return this.sql
      .exec<{ tag: string; files: number }>(
        `SELECT j.value AS tag, COUNT(*) AS files FROM files f, json_each(CASE WHEN json_valid(f.tags) THEN f.tags ELSE '[]' END) j
         WHERE f.status != 'trashed' GROUP BY j.value ORDER BY files DESC, tag LIMIT ?`,
        limit,
      )
      .toArray();
  }

  private folderExists(folder: string): boolean {
    if (folder === "/") return true;
    return !!one(this.sql.exec(`SELECT 1 AS x FROM folders WHERE path = ?`, folder).toArray());
  }

  /** Move and/or rename one file. Its old path stops serving and its new path starts, in the same transaction. */
  moveFile(id: string, to: { folder?: string; name?: string }, actor: string, nowIso: string): FileRow {
    return this.sql.transaction(() => this.moveFileTx(id, to, actor, nowIso));
  }

  private moveFileTx(id: string, to: { folder?: string; name?: string }, actor: string, nowIso: string): FileRow {
    const f = this.getFile(id);
    if (!f || f.status === "trashed") throw new IndexError("not_found", "File not found");
    if (f.status === "removed") throw new IndexError("forbidden", "This file was taken down");
    const folder = to.folder ?? f.folder;
    const name = to.name ?? f.name;
    const path = joinPath(folder, name);
    if (path === f.path) return f;
    if (this.liveFileAt(path)) throw new IndexError("conflict", "A file already exists at this path");
    this.sql.exec(`UPDATE files SET path = ?, folder = ?, name = ?, updated_at = ? WHERE id = ?`, path, folder, name, nowIso, id);
    this.ensureFolders(folder, actor, nowIso);
    this.enqueueRouteDelete(f.path, nowIso);
    const moved = this.getFile(id)!;
    this.enqueueRoute(moved, nowIso);
    return moved;
  }

  /**
   * Move (or rename) a folder and everything under it to `to`, which must not exist yet. One transaction: a
   * concurrent move of the same folder runs after this one and finds its source gone.
   */
  moveFolder(from: string, to: string, actor: string, nowIso: string): { folder: FolderRow; moved: number } {
    return this.sql.transaction(() => {
      if (from === "/" || to === "/") throw new IndexError("invalid_state", "The root folder can't be moved");
      if (to === from || to.startsWith(`${from}/`)) throw new IndexError("invalid_state", "A folder can't move into itself");
      const under = `${from}/`;
      const inside = `(folder = ? OR substr(folder, 1, ?) = ?)`;
      const files = this.sql.exec<FileRow>(`SELECT * FROM files WHERE ${inside}`, from, under.length, under).toArray();
      if (!this.folderExists(from) && files.length === 0) throw new IndexError("not_found", "Folder not found");
      const toUnder = `${to}/`;
      if (this.folderExists(to) || one(this.sql.exec(`SELECT 1 AS x FROM files WHERE (folder = ? OR substr(folder, 1, ?) = ?) AND status != 'trashed' LIMIT 1`, to, toUnder.length, toUnder).toArray())) {
        throw new IndexError("conflict", "A folder already exists there");
      }
      if (files.some((f) => f.status === "removed")) throw new IndexError("forbidden", "A file in this folder was taken down");
      const rebase = (p: string) => to + p.slice(from.length);
      for (const f of files) {
        const folder = rebase(f.folder);
        const path = joinPath(folder, f.name);
        this.sql.exec(`UPDATE files SET path = ?, folder = ?, updated_at = ? WHERE id = ?`, path, folder, nowIso, f.id);
        if (f.status !== "trashed") {
          this.enqueueRouteDelete(f.path, nowIso);
          this.enqueueRoute({ ...f, path, folder }, nowIso);
        }
      }
      const rows = this.sql.exec<{ path: string; created_by: string; created_at: string }>(
        `SELECT path, created_by, created_at FROM folders WHERE path = ? OR substr(path, 1, ?) = ?`, from, under.length, under,
      ).toArray();
      this.sql.exec(`DELETE FROM folders WHERE path = ? OR substr(path, 1, ?) = ?`, from, under.length, under);
      this.ensureFolders(to, actor, nowIso);
      for (const r of rows) {
        const path = rebase(r.path);
        const cut = path.lastIndexOf("/");
        this.sql.exec(
          `INSERT INTO folders (path, parent, name, created_by, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (path) DO NOTHING`,
          path, cut === 0 ? "/" : path.slice(0, cut), path.slice(cut + 1), r.created_by, r.created_at,
        );
      }
      for (const f of files) this.ensureFolders(rebase(f.folder), actor, nowIso);
      return { folder: this.listFolders().find((d) => d.path === to)!, moved: files.filter((f) => f.status !== "trashed").length };
    });
  }

  /** Trash every live file under a folder and forget the folder and its subfolders. */
  trashFolder(folder: string, nowIso: string): { trashed: number } {
    return this.sql.transaction(() => {
      if (folder === "/") throw new IndexError("invalid_state", "The root folder can't be deleted");
      const under = `${folder}/`;
      const ids = this.sql
        .exec<{ id: string }>(`SELECT id FROM files WHERE (folder = ? OR substr(folder, 1, ?) = ?) AND status != 'trashed'`, folder, under.length, under)
        .toArray();
      if (!this.folderExists(folder) && ids.length === 0) throw new IndexError("not_found", "Folder not found");
      for (const r of ids) this.trashTx(r.id, nowIso);
      this.sql.exec(`DELETE FROM folders WHERE path = ? OR substr(path, 1, ?) = ?`, folder, under.length, under);
      return { trashed: ids.length };
    });
  }

  /**
   * One action on many files, in one transaction. A file that can't take the action (gone, conflicting path, taken
   * down) is reported in `failed` and the rest go ahead.
   */
  batch(ids: string[], act: BatchAction, actor: string, nowIso: string): BatchResult {
    if (ids.length > MAX_BATCH) throw new IndexError("invalid_state", `At most ${MAX_BATCH} files at a time`);
    return this.sql.transaction(() => {
      const done: FileRow[] = [];
      const failed: { id: string; code: string }[] = [];
      for (const id of new Set(ids)) {
        try {
          if (act.action === "move") done.push(this.moveFileTx(id, { folder: act.folder }, actor, nowIso));
          else if (act.action === "trash") done.push(this.trashTx(id, nowIso));
          else if (act.action === "restore") done.push(this.restoreTx(id, nowIso));
          else done.push(this.setVisibilityTx(id, act.visibility, nowIso, act.requireSafety));
        } catch (e) {
          if (!(e instanceof IndexError)) throw e;
          failed.push({ id, code: e.code });
        }
      }
      return { done, failed };
    });
  }

  versions(fileId: string): { version: number; blob_sha256: string; size: number; created_by: string; created_at: string }[] {
    return this.sql.exec<{ version: number; blob_sha256: string; size: number; created_by: string; created_at: string }>(
      `SELECT version, blob_sha256, size, created_by, created_at FROM versions WHERE file_id = ? ORDER BY version DESC`,
      fileId,
    ).toArray();
  }

  // ── sessions ──────────────────────────────────────────────

  /** Where new bytes go: "managed", or the customer backend's id (PV7). Set only by endStorageSwitch. */
  storageBackend(): string {
    return this.meta("storage_backend") ?? "managed";
  }

  private switchLocked(nowIso: string): boolean {
    const until = this.meta("storage_lock_until");
    return !!until && until > nowIso;
  }

  /**
   * Start changing the library's storage (PV-46): only while it holds nothing (no file in any state, no blob, no
   * open upload). Until endStorageSwitch or `untilIso`, new uploads and commits are refused, so nothing can land in
   * the old store meanwhile.
   */
  beginStorageSwitch(nowIso: string, untilIso: string, opts: { allowFiles?: boolean } = {}): { ok: true; blobs: number; bytes: number } | { ok: false; files: number; blobs: number; uploads: number } {
    if (this.switchLocked(nowIso)) throw new IndexError("conflict", "A storage change is already in progress");
    const n = (q: string) => Number(one(this.sql.exec<{ n: number }>(q).toArray())?.n ?? 0);
    const files = n(`SELECT COUNT(*) AS n FROM files`);
    const blobs = n(`SELECT COUNT(*) AS n FROM blobs`);
    const uploads = Number(one(this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM sessions WHERE state = 'open' AND expires_at > ?`, nowIso).toArray())?.n ?? 0);
    // A migration (PV-47) moves files, so it may start with some; an open upload would write to the old place.
    if (uploads > 0 || (!opts.allowFiles && files + blobs > 0)) return { ok: false, files, blobs, uploads };
    const bytes = n(`SELECT COALESCE(SUM(size), 0) AS n FROM blobs`);
    this.setMeta("storage_lock_until", untilIso);
    return { ok: true, blobs, bytes };
  }

  /** Keep a long storage change locked (a migration extends it as it goes). */
  extendStorageLock(untilIso: string): void {
    if (this.meta("storage_lock_until")) this.setMeta("storage_lock_until", untilIso);
  }

  /** Whether a storage change is under way now (the alarm skips trash purges meanwhile). */
  storageLocked(nowIso: string): boolean {
    return this.switchLocked(nowIso);
  }

  /** Blobs in key order, for a migration to copy page by page. */
  blobsPage(afterKey: string, limit: number): { object_key: string; size: number; sha256: string }[] {
    return this.sql
      .exec<{ object_key: string; size: number; sha256: string }>(`SELECT object_key, size, sha256 FROM blobs WHERE object_key > ? ORDER BY object_key LIMIT ?`, afterKey, Math.min(Math.max(limit, 1), 500))
      .toArray();
  }

  /** The current or last migration's progress (JSON kept in meta). */
  migration(): Record<string, unknown> | null {
    const v = this.meta("storage_migration");
    try {
      return v ? (JSON.parse(v) as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  setMigration(m: Record<string, unknown>): void {
    this.setMeta("storage_migration", JSON.stringify(m));
  }


  /** Finish a storage change: record the new backend (or keep the old one when `backend` is null) and unlock. */
  endStorageSwitch(backend: string | null): void {
    if (backend) this.setMeta("storage_backend", backend);
    this.sql.exec(`DELETE FROM meta WHERE key = 'storage_lock_until'`);
  }

  /** At most `max` bucket checks per hour per library: each one sends requests to an address a manager typed. */
  noteStorageCheck(nowIso: string, max = 10): boolean {
    const hour = nowIso.slice(0, 13);
    const [h, c] = (this.meta("storage_checks") ?? "").split("|");
    const count = h === hour ? Number(c) || 0 : 0;
    if (count >= max) return false;
    this.setMeta("storage_checks", `${hour}|${count + 1}`);
    return true;
  }

  private meta(key: string): string | null {
    return one(this.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, key).toArray())?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.sql.exec(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, key, value);
  }

  openSession(s: Omit<SessionRow, "parts_json" | "state">): SessionRow {
    if (this.switchLocked(s.created_at)) throw new IndexError("invalid_state", "This library's storage is changing; try again in a minute");
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
    /** Hold the new file for a person's review once the pipeline has run (upload links). New files only. */
    reviewRequired?: boolean;
    /** The store the bytes were written to (storeChoice's backend); refused if the library's storage changed. */
    backend?: string;
  }): CommitResult {
    if (input.objectKey !== null && this.switchLocked(input.nowIso)) throw new IndexError("invalid_state", "This library's storage is changing; try again in a minute");
    if (input.objectKey !== null && input.backend !== undefined && input.backend !== this.storageBackend()) {
      throw new IndexError("invalid_state", "This library's storage changed during the upload; upload again");
    }
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
             height = NULL, tags = NULL, moderation = NULL, pipeline_note = NULL, review_required = 0, updated_at = ? WHERE id = ?`,
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
        if (input.reviewRequired) this.sql.exec(`UPDATE files SET review_required = 1 WHERE id = ?`, fileId);
        this.ensureFolders(input.folder, input.actor, input.nowIso);
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
    return this.sql.transaction(() => this.trashTx(id, nowIso));
  }

  private trashTx(id: string, nowIso: string): FileRow {
    const f = this.getFile(id);
    if (!f || f.status === "trashed") throw new IndexError("not_found", "File not found");
    this.sql.exec(`UPDATE files SET prev_status = status, status = 'trashed', trashed_at = ?, updated_at = ? WHERE id = ?`, nowIso, nowIso, id);
    const trashed = this.getFile(id)!;
    this.enqueueRoute(trashed, nowIso);
    return trashed;
  }

  restore(id: string, nowIso: string): FileRow {
    return this.sql.transaction(() => this.restoreTx(id, nowIso));
  }

  private restoreTx(id: string, nowIso: string): FileRow {
    const f = this.getFile(id);
    if (!f || f.status !== "trashed") throw new IndexError("not_found", "File not in trash");
    if (this.liveFileAt(f.path)) throw new IndexError("conflict", "Another file now uses this path");
    this.sql.exec(
      `UPDATE files SET status = COALESCE(prev_status, visibility), prev_status = NULL, trashed_at = NULL, updated_at = ? WHERE id = ?`,
      nowIso, id,
    );
    this.ensureFolders(f.folder, f.uploaded_by, nowIso);
    const restored = this.getFile(id)!;
    this.enqueueRoute(restored, nowIso);
    return restored;
  }

  /** Delete a trashed file for good: every version releases its blob; blobs at refcount 0 are returned. */
  purge(id: string, nowIso = new Date().toISOString()): { deleteKeys: string[]; releasedBytes: number } {
    // During a storage change a purge could delete from one store while the copy writes the other.
    if (this.switchLocked(nowIso)) throw new IndexError("invalid_state", "This library's storage is changing; try again later");
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
      this.sql.exec(`DELETE FROM collection_items WHERE file_id = ?`, id);
      this.sql.exec(`DELETE FROM comments WHERE file_id = ?`, id);
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
