-- Step 2: items (auto-delivery stock), orders, wallet ledger

CREATE TABLE IF NOT EXISTS product_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  TEXT NOT NULL,
  product_id INTEGER NOT NULL,
  payload    TEXT NOT NULL,
  order_id   INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_items_avail ON product_items (tenant_id, product_id, order_id);
CREATE INDEX IF NOT EXISTS idx_items_order ON product_items (order_id);

CREATE TABLE IF NOT EXISTS orders (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id         TEXT NOT NULL,
  user_id           INTEGER NOT NULL,
  product_id        INTEGER NOT NULL,
  title             TEXT NOT NULL,
  price_cents       INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',
  fail_reason       TEXT,
  delivered_payload TEXT,
  idem_key          TEXT NOT NULL,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_idem ON orders (tenant_id, user_id, idem_key);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders (tenant_id, user_id, status, id DESC);

CREATE TABLE IF NOT EXISTS wallet_tx (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       TEXT NOT NULL,
  user_id         INTEGER NOT NULL,
  type            TEXT NOT NULL,
  amount_cents    INTEGER NOT NULL,
  balance_after   INTEGER,
  ref             TEXT,
  idempotency_key TEXT,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wtx_idem ON wallet_tx (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wtx_user ON wallet_tx (tenant_id, user_id, id DESC);
