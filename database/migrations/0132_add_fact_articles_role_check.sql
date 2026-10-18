ALTER TABLE fact_articles ADD CONSTRAINT fact_articles_role_check CHECK (role IN ('primary', 'report')) NOT VALID;
