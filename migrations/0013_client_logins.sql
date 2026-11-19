-- White-label client logins and password sign-in. See docs/superpowers/specs/2026-11-18-white-label-client-logins-design.md.
ALTER TABLE users ADD COLUMN password_hash TEXT;          -- NULL = no password; "<kdf>$<params>$<pepper id>$<salt>$<hash>"
ALTER TABLE users ADD COLUMN password_set_at INTEGER;
ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0;  -- bumped to end every session (token "v")
ALTER TABLE users ADD COLUMN client_calendar_id TEXT;     -- NULL = an ordinary account; else the one calendar it may open
CREATE UNIQUE INDEX users_client_calendar ON users(client_calendar_id) WHERE client_calendar_id IS NOT NULL;

CREATE TABLE client_invites (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,            -- the address it was sent to; valid only while the sign-in still has this email
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX client_invites_user ON client_invites(user_id);

-- Every Send/Resend, refused ones too, so the per-agency limit can't be reset or probed for free.
CREATE TABLE invite_attempts (
  agency_user_id TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX invite_attempts_agency ON invite_attempts(agency_user_id, at);

-- One row per password try, written before any hashing; a right password deletes its own row.
CREATE TABLE password_attempts (
  email TEXT NOT NULL,
  ip_key TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX password_attempts_email ON password_attempts(email, at);
CREATE INDEX password_attempts_ip ON password_attempts(ip_key, at);
