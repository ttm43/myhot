-- Selection and scores come only from editorial overrides; nothing reads the analysis score.
ALTER TABLE analyses DROP COLUMN IF EXISTS score;
