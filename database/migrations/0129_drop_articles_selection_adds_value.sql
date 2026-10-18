-- Grouping no longer judges whether a report adds information to 精选; selection is editorial only.
ALTER TABLE articles DROP COLUMN IF EXISTS selection_adds_value;
