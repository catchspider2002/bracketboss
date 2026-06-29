-- Run once on an existing database that was created before the wallet column:
--   wrangler d1 execute bracketboss --remote --file ./migrations/0001_add_wallet.sql
-- (omit --remote to apply to your local dev database)
ALTER TABLE brackets ADD COLUMN wallet TEXT;
CREATE INDEX IF NOT EXISTS idx_brackets_wallet ON brackets (wallet);
