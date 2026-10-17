ALTER TABLE marks ADD CONSTRAINT marks_label_check CHECK (label IN ('niubi', 'received', 'boring')) NOT VALID;
