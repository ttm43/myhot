-- Heat counted accounts of one organisation once; nothing counts heat any more.
ALTER TABLE sources DROP COLUMN IF EXISTS signal_group_id;
