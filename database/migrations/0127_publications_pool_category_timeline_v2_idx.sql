-- The category pool index without channel: dropping the column (0128) drops every index that covers
-- it, including publications_pool_category_timeline_idx (0056) and the channel index (0057).
CREATE INDEX CONCURRENTLY IF NOT EXISTS publications_pool_category_timeline_v2_idx
  ON publications (category, timeline_at DESC, article_id DESC)
  INCLUDE (source_id, selected, visible_after)
  WHERE visibility = 'public' AND eligible;
