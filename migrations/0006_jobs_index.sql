-- For the per-calendar daily sending count.
CREATE INDEX idx_jobs_calendar_done ON jobs(calendar_id, done_at);
