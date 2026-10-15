-- reputation from the daily goals: points, the streak of days with all three done, and what's been claimed today
CREATE TABLE IF NOT EXISTS progress (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  rep integer NOT NULL DEFAULT 0,
  streak integer NOT NULL DEFAULT 0,
  full_day date,                               -- the last day all three goals were done
  day date,                                    -- the day "claimed" is for
  claimed text[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);
