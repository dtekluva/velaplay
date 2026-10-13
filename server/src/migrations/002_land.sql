-- shared ownership: money and the bulldozer per player, and every owned (or sold-on) plot in one world
CREATE TABLE IF NOT EXISTS wallets (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  money bigint NOT NULL,
  dozer boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 0,          -- bumps on every accepted change; clients send the version they last saw
  synced_at timestamptz,                       -- null until the first sync (which imports the player's existing save)
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS plots (
  key text PRIMARY KEY,                        -- "px,pz" on the game's 24 m grid
  owner uuid REFERENCES users(id) ON DELETE SET NULL,
  npc boolean NOT NULL DEFAULT false,          -- sold on: the house stays, nobody can buy it
  paid integer NOT NULL DEFAULT 0,
  big boolean NOT NULL DEFAULT false,          -- part of the Banana Island lot
  house jsonb,
  edits jsonb NOT NULL DEFAULT '{}'::jsonb,    -- bulldozer heights on this plot: { cellIndex: height }
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS plots_owner ON plots (owner);
