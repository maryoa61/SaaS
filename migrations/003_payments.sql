-- Step 3: payments (card-to-card, USDT TRC20), per-tenant settings, referrals

CREATE TABLE IF NOT EXISTS tenant_settings (
  tenant_id TEXT NOT NULL,
  key       TEXT NOT NULL,
  value     TEXT NOT NULL,
  PRIMARY KEY (tenant_id, key)
);

CREATE TABLE IF NOT EXISTS deposits (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    TEXT NOT NULL,
  user_id      INTEGER NOT NULL,
  method       TEXT NOT NULL,              -- card | usdt  (zarinpal later)
  amount_cents INTEGER NOT NULL,           -- USD credited to the wallet
  pay_amount   INTEGER NOT NULL,           -- card: toman, usdt: micro-USDT (exact amount used to match the transfer)
  status       TEXT NOT NULL DEFAULT 'awaiting',  -- awaiting | pending_review | paid | rejected | expired
  receipt      TEXT,
  tx_hash      TEXT,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at   INTEGER NOT NULL,
  paid_at      INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dep_usdt_open ON deposits (tenant_id, pay_amount) WHERE method = 'usdt' AND status = 'awaiting';
CREATE UNIQUE INDEX IF NOT EXISTS idx_dep_tx ON deposits (tenant_id, tx_hash) WHERE tx_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dep_user ON deposits (tenant_id, user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_dep_status ON deposits (status, method, expires_at);
