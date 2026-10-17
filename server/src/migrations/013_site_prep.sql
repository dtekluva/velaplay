-- site prep: a crew cleared the plot's giant trees (for everyone, for good) and levelled it
ALTER TABLE plots ADD COLUMN IF NOT EXISTS prep boolean NOT NULL DEFAULT false;
