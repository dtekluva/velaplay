-- the shared cast: passers-by players got to know, made permanent for everyone. Each has a look (the game's figure spec),
-- a persona (name, job, mood, interests...), a home (a house's key), a workplace and a hangout. People nobody has
-- spoken to for 30 days, and nobody is close to, move away (status 'moved').
CREATE TABLE IF NOT EXISTS residents (
  id serial PRIMARY KEY,
  name text NOT NULL,
  female boolean NOT NULL,
  elder boolean NOT NULL DEFAULT false,
  spec jsonb NOT NULL,                         -- what they look like
  persona jsonb NOT NULL,                      -- name, job, mood, interests, birthday, hometown, who they like
  home text NOT NULL,                          -- "h:x,z": the house they live in
  work jsonb,                                  -- { x, z, label } or null
  hang jsonb,                                  -- { x, z, label } or null
  status text NOT NULL DEFAULT 'active',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS residents_active ON residents (status);
-- you and someone you know: the stage (contact, friend, ... later), how close you are, and since when
CREATE TABLE IF NOT EXISTS relations (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resident_id integer NOT NULL REFERENCES residents(id) ON DELETE CASCADE,
  stage text NOT NULL DEFAULT 'contact',
  closeness integer NOT NULL DEFAULT 20,
  since timestamptz NOT NULL DEFAULT now(),
  last_contact timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, resident_id)
);
CREATE INDEX IF NOT EXISTS relations_resident ON relations (resident_id);
