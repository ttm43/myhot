-- Event digests are gone: when the digest was last written.
ALTER TABLE stories DROP COLUMN IF EXISTS digest_updated_at;
