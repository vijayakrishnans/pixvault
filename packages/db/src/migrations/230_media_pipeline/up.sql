-- 230_media_pipeline: file processing failures (PV4).
--
-- Context: media
-- Epic: pixvault-team-media (PV4). Design: specs/epics/pixvault-team-media/design.md §4.3.
--
--   * Pixvault runs ProcessFileWorkflow (Workflows) instead of a queue. A run that fails after its retries holds
--     the file (never serves it unchecked) and records one row here: the dead-letter list a replay works from.
--   * Ids and step names only. Never file content, EXIF, URLs or upstream error text.

CREATE TABLE IF NOT EXISTS media_pipeline_failures (
  id          TEXT PRIMARY KEY NOT NULL,
  org_id      TEXT NOT NULL,
  library_id  TEXT NOT NULL,
  file_id     TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  step        TEXT NOT NULL,
  error_name  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at TEXT,
  CONSTRAINT chk_pipeline_failure_status CHECK (status IN ('open', 'replayed', 'resolved'))
);
-- table media_pipeline_failures: Pipeline runs that failed after their retries; the file is held until replayed or reviewed.

CREATE INDEX IF NOT EXISTS media_pipeline_failures_open ON media_pipeline_failures (status, created_at);
CREATE INDEX IF NOT EXISTS media_pipeline_failures_file ON media_pipeline_failures (org_id, library_id, file_id);
