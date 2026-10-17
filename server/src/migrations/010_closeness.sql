-- how much closer you got to someone today (talk is capped a day; so are gifts)
ALTER TABLE relations ADD COLUMN IF NOT EXISTS day date;
ALTER TABLE relations ADD COLUMN IF NOT EXISTS day_gain integer NOT NULL DEFAULT 0;
ALTER TABLE relations ADD COLUMN IF NOT EXISTS gifts integer NOT NULL DEFAULT 0;
ALTER TABLE relations ADD COLUMN IF NOT EXISTS compliments integer NOT NULL DEFAULT 0;
