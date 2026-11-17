-- Stripe billing for hosted accounts (app_hosted). One row per account; no row = Free with no Stripe customer.
CREATE TABLE billing (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  -- The plan of the subscription's price. Stays 'white_label' after it ends, so the grace month knows.
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free','pro','white_label')),
  interval TEXT CHECK (interval IN ('month','year')),
  -- Stripe's subscription status, or 'none'.
  status TEXT NOT NULL DEFAULT 'none',
  current_period_end INTEGER,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  trial_used INTEGER NOT NULL DEFAULT 0,
  trial_end INTEGER,
  grace_until INTEGER,
  grace_subscription_id TEXT,
  grace_checkin_sent INTEGER NOT NULL DEFAULT 0,
  grace_reminder_sent INTEGER NOT NULL DEFAULT 0,
  checkout_attempts TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);

-- Stripe event ids already handled, so a re-delivered event is ignored. Cleared after 30 days.
CREATE TABLE stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at INTEGER NOT NULL
);

-- A Free booking over the monthly limit sends no emails, ever.
ALTER TABLE appointments ADD COLUMN emails_off INTEGER NOT NULL DEFAULT 0;

-- One "you've used your free bookings" email per calendar per month ('YYYY-MM' in its time zone).
CREATE TABLE free_limit_notices (
  calendar_id TEXT NOT NULL REFERENCES calendars(id),
  month TEXT NOT NULL,
  PRIMARY KEY (calendar_id, month)
);
CREATE INDEX idx_appointments_calendar_created ON appointments(calendar_id, created_at);
