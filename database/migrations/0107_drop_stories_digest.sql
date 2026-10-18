-- Event digests are gone: the current digest text.
ALTER TABLE stories DROP COLUMN IF EXISTS digest;
