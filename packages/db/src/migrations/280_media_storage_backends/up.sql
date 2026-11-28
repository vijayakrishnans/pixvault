-- 280_media_storage_backends: what bring-your-own buckets (PV7) need beyond the table 200_media_control created.
--
-- Context: media
-- path_style: address the bucket in the URL path (most S3-compatible servers) instead of the host name.
-- last_error: the S3 error code from the last failed check (a code only, never a URL or a key).
-- credential_ref already holds the envelope-encrypted access key and secret: only storage-worker can open it.
-- Additive only.

ALTER TABLE media_storage_backends ADD COLUMN path_style INTEGER NOT NULL DEFAULT 0;
ALTER TABLE media_storage_backends ADD COLUMN last_error TEXT;
