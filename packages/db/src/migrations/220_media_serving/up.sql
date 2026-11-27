-- 220_media_serving: what serving needs to know about a library (PV3).
--
-- Context: media
-- Epic: pixvault-team-media (PV3). Design: specs/epics/pixvault-team-media/design.md §2.5.
--
--   * org_slug: files are served at /<orgSlug>/<libSlug>/<path>. Library slugs are unique only within an org;
--     org slugs are unique across the service. Captured when the library is created (or first read by a
--     member, for libraries that predate this migration).
--   * signing_key / signing_key_version: one HMAC-SHA256 key per library for private-file URLs, rotatable.
--     The key is published with the library's serving map; it never appears in an API response.
--   * Additive and nullable: existing rows are filled in lazily by media-worker.

ALTER TABLE media_libraries ADD COLUMN org_slug TEXT;
ALTER TABLE media_libraries ADD COLUMN signing_key TEXT;
ALTER TABLE media_libraries ADD COLUMN signing_key_version INTEGER NOT NULL DEFAULT 1;
