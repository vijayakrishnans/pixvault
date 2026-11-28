-- 250_identity_challenge_attempts: wrong-code limit for email login challenges (OWASP A07).
--
-- Context: identity
-- Each wrong code adds one to failed_attempts. A challenge with 5 wrong codes, or past its expiry, can no longer
-- be used, so a 6-digit code cannot be guessed from many addresses within its 10 minutes.
-- Additive only.

ALTER TABLE identity_login_challenges ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0;
