-- The time zone the customer was looking at when they booked, so emails show times the way they saw them.
ALTER TABLE appointments ADD COLUMN customer_time_zone TEXT;
-- What happened to a queued job: 'sent', 'skipped:<why>' or 'failed:<code>'.
ALTER TABLE jobs ADD COLUMN result TEXT;
