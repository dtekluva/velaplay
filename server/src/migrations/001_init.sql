-- accounts, characters and per-player cloud saves
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  password_hash text NOT NULL,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower ON users (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS users_display_name_lower ON users (lower(display_name));

-- what your scout looks like (the same fields the game's buildFigure() takes)
CREATE TABLE IF NOT EXISTS characters (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  spec jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- your land, homes, furniture and money: the game's existing save, now in the cloud
CREATE TABLE IF NOT EXISTS saves (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
