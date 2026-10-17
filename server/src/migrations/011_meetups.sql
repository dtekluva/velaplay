-- time spent together and favours done, counted a day (each has its own bonus, once a day per person)
ALTER TABLE relations ADD COLUMN IF NOT EXISTS hangouts integer NOT NULL DEFAULT 0;
ALTER TABLE relations ADD COLUMN IF NOT EXISTS favours integer NOT NULL DEFAULT 0;
