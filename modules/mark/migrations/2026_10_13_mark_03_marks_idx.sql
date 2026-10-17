CREATE INDEX CONCURRENTLY IF NOT EXISTS marks_label_idx ON marks (label, updated_at DESC);
