-- La Zabawa · WC 2026 Predictor
-- Run this entire file in Supabase → SQL Editor

-- Tables
CREATE TABLE users (
  username       TEXT PRIMARY KEY,
  color          TEXT NOT NULL DEFAULT '#0077c8',
  role           TEXT NOT NULL DEFAULT 'member',
  pin            TEXT NOT NULL,
  champion_pick  TEXT,
  top_scorer_pick TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE predictions (
  username    TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  match_id    TEXT NOT NULL,
  home_score  SMALLINT NOT NULL,
  away_score  SMALLINT NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (username, match_id)
);

CREATE TABLE match_results (
  match_id    TEXT PRIMARY KEY,
  home_score  SMALLINT NOT NULL,
  away_score  SMALLINT NOT NULL
);

CREATE TABLE app_settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- Enable Row Level Security
ALTER TABLE users         ENABLE ROW LEVEL SECURITY;
ALTER TABLE predictions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE match_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_settings  ENABLE ROW LEVEL SECURITY;

-- Allow all operations via anon key (game context — PIN auth is handled in app code)
CREATE POLICY "allow_all" ON users         FOR ALL USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "allow_all" ON predictions   FOR ALL USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "allow_all" ON match_results FOR ALL USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "allow_all" ON app_settings  FOR ALL USING (TRUE) WITH CHECK (TRUE);

CREATE TABLE chat (
  id          BIGSERIAL PRIMARY KEY,
  username    TEXT NOT NULL,
  message     TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#0077c8',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE chat ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all" ON chat FOR ALL USING (TRUE) WITH CHECK (TRUE);

-- Enable Realtime for live leaderboard + chat updates
ALTER PUBLICATION supabase_realtime ADD TABLE predictions;
ALTER PUBLICATION supabase_realtime ADD TABLE match_results;
ALTER PUBLICATION supabase_realtime ADD TABLE chat;
