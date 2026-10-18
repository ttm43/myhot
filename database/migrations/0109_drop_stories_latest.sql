-- Event pages are gone: the digest's latest-progress line.
ALTER TABLE stories DROP COLUMN IF EXISTS latest;
