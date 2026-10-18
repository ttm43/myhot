-- publications.channel is going away (0128): the release that stops writing it must insert while it
-- still exists, so it defaults to the only value left.
ALTER TABLE publications ALTER COLUMN channel SET DEFAULT 'news';
