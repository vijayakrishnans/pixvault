-- 260_media_share_links: what share links (PV6) need beyond the table 200_media_control created empty.
--
-- Context: media
-- target_label keeps the file name or folder path as shared, for the owner list. opens and last_opened_at are the
-- open trail (counts and time only, never who or where). The token and password are stored only as hashes.
-- Additive only.

ALTER TABLE media_share_links ADD COLUMN target_label TEXT NOT NULL DEFAULT '';
ALTER TABLE media_share_links ADD COLUMN opens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE media_share_links ADD COLUMN last_opened_at TEXT;
CREATE INDEX IF NOT EXISTS media_share_links_target_idx ON media_share_links (org_id, library_id, target_kind, target_id);
