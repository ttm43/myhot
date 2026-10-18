-- X search and WeChat accounts are gone: only these kinds can be collected. Replaced in three steps:
-- drop, add NOT VALID, validate (0122, 0123).
ALTER TABLE sources DROP CONSTRAINT IF EXISTS sources_kind_check;
