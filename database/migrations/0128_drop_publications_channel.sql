-- Every report is news since X posts went; 一手 filters by source tier. Also drops the channel check
-- and the two indexes covering the column (0056, 0057); 0127 replaced the category one.
ALTER TABLE publications DROP COLUMN IF EXISTS channel;
