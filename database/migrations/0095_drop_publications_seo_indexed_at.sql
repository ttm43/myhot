-- Sitemaps, robots and IndexNow are gone: an editor's indexing mark has nothing left to steer.
ALTER TABLE publications DROP COLUMN IF EXISTS seo_indexed_at;
