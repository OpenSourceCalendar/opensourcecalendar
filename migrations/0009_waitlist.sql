-- Hosted-plan waitlist from the home page: the email address only, so we can send one "it's open" email.
CREATE TABLE waitlist (
  email TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
