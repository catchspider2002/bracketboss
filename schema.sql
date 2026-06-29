-- BracketBoss D1 schema
-- Apply with: wrangler d1 execute bracketboss --file ./schema.sql  (add --remote for production)

CREATE TABLE IF NOT EXISTS groups (
  code       TEXT PRIMARY KEY,   -- 6-char invite code
  name       TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS brackets (
  id         TEXT PRIMARY KEY,   -- uuid
  group_code TEXT NOT NULL,
  user_name  TEXT NOT NULL,
  picks_json TEXT NOT NULL,      -- { slotId: teamName, ... } 32 picks
  odds_json  TEXT,               -- { slotId: { team: decimalOdds } } snapshot at submit (for upset bonus)
  wallet     TEXT,               -- optional Solana address (for cross-device recall)
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_brackets_wallet ON brackets (wallet);
CREATE INDEX IF NOT EXISTS idx_brackets_group ON brackets (group_code);

CREATE TABLE IF NOT EXISTS matches (
  slot_id       TEXT PRIMARY KEY, -- e.g. r32_0, r16_3, qf_1, sf_0, final_0, third_0
  round         TEXT NOT NULL,    -- r32 | r16 | qf | sf | final | third
  slot_index    INTEGER NOT NULL,
  home_slot     TEXT,             -- team name (r32 seeds) or 'winner_of_<feeder>' placeholder
  away_slot     TEXT,
  match_id      TEXT,             -- TxLINE match id once scheduled
  kickoff       TEXT,
  result_winner TEXT,             -- filled on full_time
  result_score  TEXT
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
-- meta keys used: 'locked' ('1' once first knockout kicks off), 'lock_at' (ISO timestamp)
