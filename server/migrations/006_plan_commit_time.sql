-- Historical timestamps are unknown; leave them null rather than inventing a date.
ALTER TABLE app.plans ADD COLUMN committed_at timestamptz;
