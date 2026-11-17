-- Hosted accounts (self-serve sign-up). Only used when SIGNUP is on; see src/worker/routes/accounts.ts.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  google_sub TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);

-- used_by deliberately has no REFERENCES users(id): it is set just before the user row is inserted.
CREATE TABLE invites (
  token_hash TEXT PRIMARY KEY,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_by TEXT
);

CREATE TABLE login_links (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  invite_hash TEXT,
  ip_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX login_links_email ON login_links (email, created_at);
CREATE INDEX login_links_ip ON login_links (ip_hash, created_at);
CREATE INDEX login_links_created ON login_links (created_at);
