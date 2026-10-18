-- Composite reports no longer get mention links: only primary and report memberships remain. Replaced in
-- three steps: drop, add NOT VALID, validate (0132, 0133). The old mention rows are removed by hand before
-- the update (docs/deploy.md); validation fails while any remains.
ALTER TABLE fact_articles DROP CONSTRAINT IF EXISTS fact_articles_role_check;
