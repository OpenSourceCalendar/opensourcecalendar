-- Phase 8: webhooks. The signing secret is derived from MANAGE_SECRET and this version (never stored);
-- rotating the secret bumps the version.
ALTER TABLE apps ADD COLUMN webhook_secret_version INTEGER NOT NULL DEFAULT 1;
