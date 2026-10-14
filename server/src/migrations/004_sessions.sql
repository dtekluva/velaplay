-- the visit log: one row per time someone is in the world (guest or account), kept up to date while they play
CREATE TABLE IF NOT EXISTS sessions (
  id bigserial PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  name text NOT NULL,
  guest boolean NOT NULL,
  device text NOT NULL DEFAULT 'desktop',
  started_at timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  ended boolean NOT NULL DEFAULT false,
  metres integer NOT NULL DEFAULT 0,
  areas text[] NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS sessions_started ON sessions (started_at DESC);
