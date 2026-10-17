-- romance: a resident is with one player at a time (partner_user); the relationship's romantic stage, spark and since when
ALTER TABLE residents ADD COLUMN IF NOT EXISTS partner_user uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE relations ADD COLUMN IF NOT EXISTS romance text;              -- null, dating, partner, engaged, married
ALTER TABLE relations ADD COLUMN IF NOT EXISTS spark integer NOT NULL DEFAULT 0;
ALTER TABLE relations ADD COLUMN IF NOT EXISTS romance_since timestamptz;
ALTER TABLE relations ADD COLUMN IF NOT EXISTS flirts integer NOT NULL DEFAULT 0;
