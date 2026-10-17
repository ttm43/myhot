CREATE TABLE IF NOT EXISTS mark_events (
  id bigserial PRIMARY KEY,
  article_id text NOT NULL,
  label text NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
