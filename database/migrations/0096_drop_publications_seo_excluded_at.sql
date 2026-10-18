-- Sitemaps, robots and IndexNow are gone: an editor's exclusion has nothing left to steer.
ALTER TABLE publications DROP COLUMN IF EXISTS seo_excluded_at;
