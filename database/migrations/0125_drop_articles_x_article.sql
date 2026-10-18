-- X Article bodies are no longer fetched or read.
ALTER TABLE articles DROP COLUMN IF EXISTS x_article;
