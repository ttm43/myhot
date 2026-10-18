-- Only the hot ranking read which kind of manual grouping decision a row was; there is one kind.
ALTER TABLE grouping_overrides DROP COLUMN IF EXISTS mode;
