-- businesses you own: a shopfront, a buka, a kiosk, a filling station. One owner each, worldwide. The till fills with
-- the hours since you last collected (up to a cap), and the server is the one that works out what's in it.
CREATE TABLE IF NOT EXISTS businesses (
  key text PRIMARY KEY,                        -- the site, as the game names it ("y:x,z" a Yaba shopfront, "i:x,z" a shop with rooms, "v:x,z" a buka or kiosk)
  type text NOT NULL,                          -- what it sells (see BIZ_TYPES)
  label text NOT NULL,                         -- the name on the sign when you bought it
  owner uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  level integer NOT NULL DEFAULT 1,            -- 1 to 5
  mode text NOT NULL DEFAULT 'fair',           -- prices: 'low', 'fair' or 'high'
  manager boolean NOT NULL DEFAULT false,      -- a manager keeps it going longer between visits
  rep integer NOT NULL DEFAULT 0,              -- -100 to 100: what the street thinks of the place
  invested bigint NOT NULL,                    -- the price and every upgrade (for selling it on)
  earned bigint NOT NULL DEFAULT 0,            -- everything it has paid you
  last_collect timestamptz NOT NULL DEFAULT now(),
  bought_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS businesses_owner ON businesses (owner);
