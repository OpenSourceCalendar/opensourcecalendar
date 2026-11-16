-- Booking link names an owner has changed away from. Held for 90 days so another
-- business can't take the name while old links and printed QR codes are still around.
-- The calendar that released it can take it back at any time.
CREATE TABLE released_slugs (
  slug TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL REFERENCES calendars(id),
  released_at INTEGER NOT NULL
);
