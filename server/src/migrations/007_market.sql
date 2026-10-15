-- cars you own (bought at a showroom, or from another player), and the player market: land, houses and cars for sale, at a
-- fixed price or by auction. A bid's money is held from the bidder's wallet until they're outbid (then it's returned) or win.
CREATE TABLE IF NOT EXISTS vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model text NOT NULL,
  color integer NOT NULL DEFAULT 0,
  paid bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vehicles_owner ON vehicles (owner);
CREATE TABLE IF NOT EXISTS listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,                          -- 'plot' (land, with any house on it) or 'car'
  ref text NOT NULL,                           -- the plot key, or the vehicle id
  seller uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  mode text NOT NULL,                          -- 'fixed' or 'auction'
  price bigint NOT NULL,                       -- fixed: the price; auction: the opening bid
  ends_at timestamptz,                         -- auctions
  top_bid bigint,
  top_bidder uuid REFERENCES users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'open',         -- open, sold, cancelled, expired, void (the seller no longer had it)
  buyer uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);
CREATE INDEX IF NOT EXISTS listings_open ON listings (status, ends_at) WHERE status = 'open';
CREATE UNIQUE INDEX IF NOT EXISTS listings_one_open ON listings (kind, ref) WHERE status = 'open';
CREATE TABLE IF NOT EXISTS bids (
  id bigserial PRIMARY KEY,
  listing uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  bidder uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bids_listing ON bids (listing, amount DESC);
