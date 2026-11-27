-- 210_media_usage: Pixvault media usage counters and org limits (PV2).
--
-- Context: media
-- Epic: pixvault-team-media (PV2). Design: specs/epics/pixvault-team-media/design.md §4.4 (quotas).
--
--   * media_usage holds one row per (org, period). period 'total' carries storage_bytes (managed bytes actually
--     stored, so a deduplicated upload adds nothing); period 'YYYY-MM' carries that month's uploads and their bytes.
--     Rows change by single-statement upserts only, so concurrent commits can't lose an increment.
--   * media_org_limits overrides the plan defaults for one org (set by platform admins). No row means defaults.
--   * Both tables are org-scoped.

CREATE TABLE IF NOT EXISTS media_usage (
  org_id         TEXT NOT NULL,
  period         TEXT NOT NULL,
  uploads        INTEGER NOT NULL DEFAULT 0,
  upload_bytes   INTEGER NOT NULL DEFAULT 0,
  storage_bytes  INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (org_id, period)
);
-- table media_usage: Per-org media usage; 'total' row = stored bytes, 'YYYY-MM' rows = monthly uploads.

CREATE TABLE IF NOT EXISTS media_org_limits (
  org_id                   TEXT PRIMARY KEY NOT NULL,
  storage_bytes_limit      INTEGER,
  uploads_per_month_limit  INTEGER,
  max_file_bytes           INTEGER,
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- table media_org_limits: Per-org overrides of the plan's media limits; NULL columns fall back to defaults.
