-- texts between players: kept for accounts (so they reach you if you were away); guests' only travel live
CREATE TABLE IF NOT EXISTS messages (
  id bigserial PRIMARY KEY,
  sender uuid REFERENCES users(id) ON DELETE CASCADE,
  sender_name text NOT NULL,
  recipient uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body text NOT NULL,
  read boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_recipient ON messages (recipient, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_sender ON messages (sender, created_at DESC);
