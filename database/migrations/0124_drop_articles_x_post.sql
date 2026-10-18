-- Nothing collects X posts any more (no writer since the hard fork); the post is read nowhere.
ALTER TABLE articles DROP COLUMN IF EXISTS x_post;
