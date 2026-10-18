-- Sitemaps, robots and IndexNow are gone: nothing decides whether a page is indexed any more.
-- Its partial sitemap index goes with the column.
ALTER TABLE publications DROP COLUMN IF EXISTS indexable;
