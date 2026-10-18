-- Full-text RSS is gone: a source's redistribution licence has no reader.
ALTER TABLE sources DROP COLUMN IF EXISTS syndicate_fulltext;
