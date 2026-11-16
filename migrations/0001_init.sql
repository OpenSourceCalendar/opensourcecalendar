-- Booking calendar schema v1. Times are UTC milliseconds unless the column ends
-- in _min (minutes after local midnight) or _date / on_date (YYYY-MM-DD local).

CREATE TABLE apps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  api_key_hash TEXT NOT NULL UNIQUE,
  signing_secret_enc TEXT,
  webhook_url TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE calendars (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id),
  external_user_id TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  time_zone TEXT NOT NULL,
  rules TEXT NOT NULL DEFAULT '{}',
  branding TEXT NOT NULL DEFAULT '{}',
  notifications TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  UNIQUE (app_id, external_user_id)
);

CREATE TABLE weekly_hours (
  calendar_id TEXT NOT NULL REFERENCES calendars(id),
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_min INTEGER NOT NULL,
  end_min INTEGER NOT NULL,
  CHECK (start_min >= 0 AND end_min <= 1440 AND start_min < end_min)
);
CREATE INDEX idx_weekly_hours_calendar ON weekly_hours(calendar_id);

CREATE TABLE weekly_breaks (
  calendar_id TEXT NOT NULL REFERENCES calendars(id),
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_min INTEGER NOT NULL,
  end_min INTEGER NOT NULL,
  CHECK (start_min >= 0 AND end_min <= 1440 AND start_min < end_min)
);
CREATE INDEX idx_weekly_breaks_calendar ON weekly_breaks(calendar_id);

CREATE TABLE date_overrides (
  calendar_id TEXT NOT NULL REFERENCES calendars(id),
  on_date TEXT NOT NULL,
  closed INTEGER NOT NULL DEFAULT 0,
  start_min INTEGER,
  end_min INTEGER,
  breaks TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (calendar_id, on_date)
);

CREATE TABLE blocked_dates (
  id TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL REFERENCES calendars(id),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  CHECK (start_date <= end_date)
);
CREATE INDEX idx_blocked_dates_calendar ON blocked_dates(calendar_id);

CREATE TABLE time_blocks (
  id TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL REFERENCES calendars(id),
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  CHECK (start_at < end_at)
);
CREATE INDEX idx_time_blocks_calendar_start ON time_blocks(calendar_id, start_at);

CREATE TABLE services (
  id TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL REFERENCES calendars(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  duration_min INTEGER NOT NULL CHECK (duration_min > 0),
  price_cents INTEGER,
  currency TEXT NOT NULL DEFAULT 'USD',
  color TEXT NOT NULL,
  location_type TEXT NOT NULL,
  location_text TEXT NOT NULL DEFAULT '',
  hidden INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_call_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX idx_services_calendar ON services(calendar_id);

CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL REFERENCES calendars(id),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL DEFAULT '',
  phone TEXT,
  phone_norm TEXT,
  email TEXT,
  notes TEXT NOT NULL DEFAULT '',
  external_ref TEXT,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX idx_customers_calendar ON customers(calendar_id);
CREATE UNIQUE INDEX idx_customers_phone ON customers(calendar_id, phone_norm)
  WHERE phone_norm IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX idx_customers_email ON customers(calendar_id, email)
  WHERE email IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_customers_external_ref ON customers(calendar_id, external_ref);

CREATE TABLE appointments (
  id TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL REFERENCES calendars(id),
  service_id TEXT NOT NULL REFERENCES services(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('booked', 'confirmed', 'done', 'no_show', 'cancelled')),
  source TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  cancel_reason TEXT,
  manage_token_hash TEXT NOT NULL UNIQUE,
  ics_sequence INTEGER NOT NULL DEFAULT 0,
  google_event_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (start_at < end_at)
);
CREATE INDEX idx_appointments_calendar_start ON appointments(calendar_id, start_at);
CREATE INDEX idx_appointments_customer ON appointments(customer_id);

CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL REFERENCES calendars(id),
  at INTEGER NOT NULL,
  title TEXT NOT NULL,
  customer_id TEXT REFERENCES customers(id),
  external_ref TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_reminders_calendar_at ON reminders(calendar_id, at);

CREATE TABLE consents (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  appointment_id TEXT REFERENCES appointments(id),
  kind TEXT NOT NULL,
  wording TEXT NOT NULL,
  given_at INTEGER NOT NULL
);
CREATE INDEX idx_consents_customer ON consents(customer_id);

CREATE TABLE google_connections (
  calendar_id TEXT PRIMARY KEY REFERENCES calendars(id),
  google_email TEXT NOT NULL,
  refresh_token_enc TEXT NOT NULL,
  google_calendar_id TEXT NOT NULL,
  block_all_day INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  sync_token TEXT,
  last_synced_at INTEGER
);

CREATE TABLE google_busy (
  calendar_id TEXT NOT NULL REFERENCES calendars(id),
  google_event_id TEXT NOT NULL,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  PRIMARY KEY (calendar_id, google_event_id)
);
CREATE INDEX idx_google_busy_calendar_start ON google_busy(calendar_id, start_at);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  calendar_id TEXT REFERENCES calendars(id),
  kind TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  run_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  done_at INTEGER
);
CREATE INDEX idx_jobs_due ON jobs(done_at, run_at);
