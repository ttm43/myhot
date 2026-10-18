-- Full-text RSS is gone: whether an item may be redistributed with its body has no reader.
ALTER TABLE publications DROP COLUMN IF EXISTS syndicate;
