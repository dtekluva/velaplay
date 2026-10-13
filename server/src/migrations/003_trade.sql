-- players dealing with each other: selling or giving land (with its house) to another player, and sending money
-- money sent to you waits here until your game next syncs, so a sync never overwrites it
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS inbox bigint NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL,                           -- the plot ("px,pz"); for the Banana Island lot, the whole lot moves
  seller uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  buyer uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  price bigint NOT NULL,                       -- 0: a gift
  status text NOT NULL DEFAULT 'open',         -- open, accepted, declined, cancelled, void (the seller no longer has it)
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);
CREATE INDEX IF NOT EXISTS offers_buyer_open ON offers (buyer) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS offers_seller_open ON offers (seller) WHERE status = 'open';

-- every transfer of money between players: payments, and what buyers paid for land
CREATE TABLE IF NOT EXISTS payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payer uuid REFERENCES users(id) ON DELETE SET NULL,
  payee uuid REFERENCES users(id) ON DELETE SET NULL,
  amount bigint NOT NULL,
  kind text NOT NULL,                          -- 'gift' (sent money) or 'land' (paid for a plot)
  ref text,                                    -- the plot, for land
  seen boolean NOT NULL DEFAULT false,         -- the payee has been told
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payments_payer_time ON payments (payer, created_at);
CREATE INDEX IF NOT EXISTS payments_payee_unseen ON payments (payee) WHERE NOT seen;
