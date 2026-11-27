-- 200_media_control: Pixvault media control plane (PV1).
--
-- Context: media
-- Epic: pixvault-team-media (PV1). Design of record: specs/epics/pixvault-team-media/design.md §1.2.
--
-- Design rules:
--   * D1 holds the CONTROL plane only: libraries, their members and settings, storage backend references,
--     domains, share-link and upload-link lookups by token hash, WebDAV credentials, the serve-route mirror,
--     abuse cases and import jobs. File metadata lives in each library's LibraryIndex Durable Object (PV2).
--   * Every table carries org_id TEXT NOT NULL, and every query scopes by it. Most also carry library_id.
--   * A library is a Cirrus project: media_libraries.project_id references projects_projects.id
--     (opaque reference, no cross-context FK, as Cirrus does).
--   * Secrets are never stored in clear: token_hash / password_hash are SHA-256 or PBKDF2 digests, and
--     credential_ref is an envelope-encrypted blob decrypted only inside storage-worker.
--   * Tables for later milestones (domains, share/upload links, dav, serve routes, abuse, import) are created
--     now so the control schema is complete; nothing reads or writes them until their milestone.
--   * Idempotent: IF NOT EXISTS throughout.

-- ── Libraries ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS media_libraries (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL,
  project_id          TEXT NOT NULL,
  slug                TEXT NOT NULL,
  name                TEXT NOT NULL,
  visibility_default  TEXT NOT NULL DEFAULT 'private' CHECK (visibility_default IN ('public', 'private')),
  everyone_in_org     INTEGER NOT NULL DEFAULT 0 CHECK (everyone_in_org IN (0, 1)),
  moderation_level    TEXT NOT NULL DEFAULT 'standard' CHECK (moderation_level IN ('off', 'standard', 'strict')),
  retention_days      INTEGER NOT NULL DEFAULT 30 CHECK (retention_days BETWEEN 1 AND 3650),
  settings_json       TEXT NOT NULL DEFAULT '{}',
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by          TEXT NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  archived_at         TEXT
);
-- table media_libraries: A shared drive. One per Cirrus project. Every query must scope by org_id.
CREATE UNIQUE INDEX IF NOT EXISTS media_libraries_org_slug_idx ON media_libraries (org_id, slug);
CREATE UNIQUE INDEX IF NOT EXISTS media_libraries_org_project_idx ON media_libraries (org_id, project_id);
CREATE UNIQUE INDEX IF NOT EXISTS media_libraries_org_id_idx ON media_libraries (org_id, id);
CREATE INDEX IF NOT EXISTS media_libraries_org_created_idx ON media_libraries (org_id, created_at DESC, id DESC);

-- ── Library members (org members and guests) ──────────────
CREATE TABLE IF NOT EXISTS media_library_members (
  org_id          TEXT NOT NULL,
  library_id      TEXT NOT NULL,
  principal_kind  TEXT NOT NULL CHECK (principal_kind IN ('member', 'guest')),
  principal_id    TEXT NOT NULL,
  email           TEXT,
  role            TEXT NOT NULL CHECK (role IN ('manager', 'editor', 'uploader', 'viewer')),
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (org_id, library_id, principal_id),
  CHECK (principal_kind = 'member' OR role IN ('uploader', 'viewer'))
);
-- table media_library_members: A principal's role on one library. Guests may only be uploader or viewer.
CREATE INDEX IF NOT EXISTS media_library_members_principal_idx ON media_library_members (principal_id, org_id);

-- ── Guest invitations ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS media_library_invitations (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  library_id   TEXT NOT NULL,
  email_lower  TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('uploader', 'viewer')),
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at   TEXT NOT NULL,
  accepted_at  TEXT,
  accepted_by  TEXT,
  revoked_at   TEXT
);
-- table media_library_invitations: Pending guest invitations, accepted by a signed-in user with the same email.
CREATE UNIQUE INDEX IF NOT EXISTS media_library_invitations_open_idx
  ON media_library_invitations (org_id, library_id, email_lower) WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS media_library_invitations_email_idx ON media_library_invitations (email_lower);

-- ── Storage backends ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS media_storage_backends (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  library_id      TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('managed-r2', 's3-compatible')),
  endpoint        TEXT,
  region          TEXT,
  bucket          TEXT,
  prefix          TEXT NOT NULL,
  credential_ref  TEXT,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'error', 'retired')),
  last_check_at   TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- table media_storage_backends: Where a library's blobs live. Managed prefix is org/<orgId>/lib/<libraryId>/.
CREATE INDEX IF NOT EXISTS media_storage_backends_library_idx ON media_storage_backends (org_id, library_id);

-- ── Domains (PV8) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS media_domains (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL,
  library_id          TEXT NOT NULL,
  hostname            TEXT NOT NULL,
  custom_hostname_id  TEXT,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'error', 'removed')),
  verified_at         TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS media_domains_hostname_idx ON media_domains (hostname) WHERE status != 'removed';
CREATE INDEX IF NOT EXISTS media_domains_library_idx ON media_domains (org_id, library_id);

-- ── Share links (PV6) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS media_share_links (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  library_id      TEXT NOT NULL,
  target_kind     TEXT NOT NULL CHECK (target_kind IN ('file', 'folder', 'collection')),
  target_id       TEXT NOT NULL,
  mode            TEXT NOT NULL CHECK (mode IN ('view', 'download')),
  token_hash      TEXT NOT NULL,
  password_hash   TEXT,
  expires_at      TEXT,
  max_downloads   INTEGER,
  downloads       INTEGER NOT NULL DEFAULT 0,
  created_by      TEXT NOT NULL,
  revoked_at      TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS media_share_links_token_idx ON media_share_links (token_hash);
CREATE INDEX IF NOT EXISTS media_share_links_library_idx ON media_share_links (org_id, library_id, created_at DESC);

-- ── Upload links (PV6) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS media_upload_links (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL,
  library_id       TEXT NOT NULL,
  folder_path      TEXT NOT NULL,
  token_hash       TEXT NOT NULL,
  limits_json      TEXT NOT NULL DEFAULT '{}',
  requires_review  INTEGER NOT NULL DEFAULT 1 CHECK (requires_review IN (0, 1)),
  created_by       TEXT NOT NULL,
  expires_at       TEXT,
  revoked_at       TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS media_upload_links_token_idx ON media_upload_links (token_hash);
CREATE INDEX IF NOT EXISTS media_upload_links_library_idx ON media_upload_links (org_id, library_id, created_at DESC);

-- ── WebDAV app passwords (PV9) ─────────────────────────────
CREATE TABLE IF NOT EXISTS media_dav_credentials (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  library_ids_json  TEXT NOT NULL DEFAULT '[]',
  label             TEXT NOT NULL DEFAULT '',
  password_hash     TEXT NOT NULL,
  last_used_at      TEXT,
  revoked_at        TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS media_dav_credentials_user_idx ON media_dav_credentials (org_id, user_id);

-- ── Serve-route mirror (PV3) ───────────────────────────────
CREATE TABLE IF NOT EXISTS media_serve_routes (
  org_id           TEXT NOT NULL,
  hostname_or_lib  TEXT NOT NULL,
  path_hash        TEXT NOT NULL,
  library_id       TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (hostname_or_lib, path_hash)
);
CREATE INDEX IF NOT EXISTS media_serve_routes_library_idx ON media_serve_routes (org_id, library_id);

-- ── Abuse cases (PV4; platform-scoped reads) ───────────────
CREATE TABLE IF NOT EXISTS media_abuse_cases (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  library_id      TEXT,
  file_ref        TEXT NOT NULL,
  reporter_email  TEXT,
  reason          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'dismissed')),
  action          TEXT,
  handled_by      TEXT,
  handled_at      TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS media_abuse_cases_status_idx ON media_abuse_cases (status, created_at DESC);
CREATE INDEX IF NOT EXISTS media_abuse_cases_org_idx ON media_abuse_cases (org_id, created_at DESC);

-- ── Import jobs (PV10) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS media_import_jobs (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  library_id  TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('imgbed-export', 'telegram', 'discord', 'hf', 'webdav', 's3')),
  status      TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled')),
  stats_json  TEXT NOT NULL DEFAULT '{}',
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS media_import_jobs_library_idx ON media_import_jobs (org_id, library_id, created_at DESC);
