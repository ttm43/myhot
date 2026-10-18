ALTER TABLE sources ADD CONSTRAINT sources_kind_check CHECK (kind IN ('rss', 'web_list', 'json_list', 'external')) NOT VALID;
