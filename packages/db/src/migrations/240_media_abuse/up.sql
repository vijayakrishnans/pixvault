-- 240_media_abuse: abuse reports, takedown and org suspension (PV4).
--
-- Context: media
-- Epic: pixvault-team-media (PV4). Design: specs/epics/pixvault-team-media/design.md §4.9.
--
--   * media_abuse_cases (created empty by 200_media_control) gains what PV4 needs: the reported bytes, the
--     reporter words, a report count (one open case per file, repeats add to it) and the decision note.
--     file_ref holds the file id and reason the category. Never file content or a URL with a signature.
--   * platform_media_operators: who may act on abuse cases and suspend orgs. Filled by hand, not from the repo
--     (it is public). Ids only.
--   * media_org_status: an org suspended by an operator. Its libraries answer 451 and it cannot upload.
--   * Additive only.

ALTER TABLE media_abuse_cases ADD COLUMN sha256 TEXT;
ALTER TABLE media_abuse_cases ADD COLUMN details TEXT;
ALTER TABLE media_abuse_cases ADD COLUMN report_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE media_abuse_cases ADD COLUMN decision_note TEXT;
CREATE INDEX IF NOT EXISTS media_abuse_cases_file_idx ON media_abuse_cases (org_id, library_id, file_ref, status);

CREATE TABLE IF NOT EXISTS platform_media_operators (
  subject_id  TEXT PRIMARY KEY NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- table platform_media_operators: Subjects allowed to act on abuse cases and suspend orgs. Filled by hand.

CREATE TABLE IF NOT EXISTS media_org_status (
  org_id        TEXT PRIMARY KEY NOT NULL,
  suspended_at  TEXT,
  reason        TEXT,
  decided_by    TEXT,
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- table media_org_status: An org suspension by an operator (NULL suspended_at means active).
