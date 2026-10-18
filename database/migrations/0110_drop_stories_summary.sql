-- Event pages are gone: the event's own factual summary.
ALTER TABLE stories DROP COLUMN IF EXISTS summary;
