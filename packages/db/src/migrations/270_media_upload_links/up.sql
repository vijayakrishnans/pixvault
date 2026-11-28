-- 270_media_upload_links: what upload links (PV6) need beyond the table 200_media_control created empty.
--
-- Context: media
-- uploads and bytes count what came in through the link, reserved in one conditional UPDATE before each file, so
-- concurrent guests can't go past its limits. label is the owner's name for the link. The token is stored only as
-- a hash.
-- Additive only.

ALTER TABLE media_upload_links ADD COLUMN uploads INTEGER NOT NULL DEFAULT 0;
ALTER TABLE media_upload_links ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE media_upload_links ADD COLUMN label TEXT NOT NULL DEFAULT '';
