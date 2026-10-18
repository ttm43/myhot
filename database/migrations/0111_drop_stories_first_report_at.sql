-- Event pages and the hot ranking are gone: the span of an event's reports had no other reader.
ALTER TABLE stories DROP COLUMN IF EXISTS first_report_at;
