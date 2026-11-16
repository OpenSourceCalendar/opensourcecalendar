-- Phase 7: Google Calendar sync.
ALTER TABLE google_connections ADD COLUMN google_calendar_name TEXT NOT NULL DEFAULT '';
-- The short-lived access token, encrypted like the refresh token, so the cron doesn't fetch a new one every minute.
ALTER TABLE google_connections ADD COLUMN access_token_enc TEXT;
ALTER TABLE google_connections ADD COLUMN access_expires_at INTEGER;
-- Why the connection is broken (status 'broken'), or the last passing problem (status 'active'). A short code, never Google's text.
ALTER TABLE google_connections ADD COLUMN last_error TEXT;
-- Hash of the last busy set written, so an unchanged calendar costs one small UPDATE a minute.
ALTER TABLE google_connections ADD COLUMN busy_hash TEXT;
ALTER TABLE google_connections ADD COLUMN connected_at INTEGER NOT NULL DEFAULT 0;
-- When the cron last tried this connection (success or not), so one failing connection can't hog every run.
ALTER TABLE google_connections ADD COLUMN last_attempt_at INTEGER;
-- Last push to Google that gave up (short code), shown to the owner; cleared by the next successful push.
ALTER TABLE google_connections ADD COLUMN push_error TEXT;

-- One row per "Connect" click: the OAuth state can be used once, then it's gone.
CREATE TABLE google_states (
  nonce_hash TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL REFERENCES calendars(id),
  expires_at INTEGER NOT NULL
);
