-- Selection comes only from editorial overrides; nothing reads the analysis verdict.
ALTER TABLE analyses DROP COLUMN IF EXISTS selected;
