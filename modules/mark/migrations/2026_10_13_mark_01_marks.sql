CREATE TABLE IF NOT EXISTS marks (
  article_id text PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
  label text NOT NULL CHECK (label IN ('niubi', 'known', 'boring')),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
