-- Event pages and the hot ranking are gone; stories_latest_idx goes with the column.
ALTER TABLE stories DROP COLUMN IF EXISTS latest_at;
