-- White-label: one agency account, many client calendars.
-- The hosted account that owns a calendar. Its own ("home") calendar has external_user_id = account_user_id; a client's
-- has external_user_id '<user id>:<calendar id>' (keeps UNIQUE (app_id, external_user_id), never equals a user id).
-- NULL = not a hosted calendar (host apps, standalone installs).
ALTER TABLE calendars ADD COLUMN account_user_id TEXT;
UPDATE calendars SET account_user_id = external_user_id WHERE app_id = 'app_hosted';
CREATE INDEX idx_calendars_account ON calendars(account_user_id, created_at);
-- Most calendars an account may have, its own included. NULL = the default 50; the operator raises it by hand.
ALTER TABLE billing ADD COLUMN client_limit INTEGER;
