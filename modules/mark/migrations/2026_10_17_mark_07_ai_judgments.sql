CREATE TABLE IF NOT EXISTS ai_judgments (
  article_id text PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
  label text NOT NULL CHECK (label IN ('niubi', 'received', 'boring')),
  score real NOT NULL,
  reason text,
  trigger_fact text,
  version text,
  judged_at timestamptz NOT NULL DEFAULT now()
);
