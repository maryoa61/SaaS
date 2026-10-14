-- Multi-tenant store bot: step 1 schema (every table carries tenant_id)

CREATE TABLE IF NOT EXISTS tenants (
  id            TEXT PRIMARY KEY,
  owner_tg_id   INTEGER NOT NULL,
  bot_username  TEXT NOT NULL UNIQUE,
  token_enc     TEXT NOT NULL,
  webhook_secret TEXT NOT NULL,
  support_hours TEXT NOT NULL DEFAULT 'پاسخگویی از ۹ صبح تا ۹ شب',
  usd_to_toman  INTEGER NOT NULL DEFAULT 275000,
  welcome_text  TEXT NOT NULL DEFAULT 'به فروشگاه ما خوش آمدید 👋',
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS users (
  tenant_id     TEXT NOT NULL,
  tg_id         INTEGER NOT NULL,
  first_name    TEXT,
  username      TEXT,
  balance_cents INTEGER NOT NULL DEFAULT 0,
  referrer_id   INTEGER,
  state         TEXT,
  state_data    TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen     INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (tenant_id, tg_id)
);

CREATE TABLE IF NOT EXISTS categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  TEXT NOT NULL,
  parent_id  INTEGER,
  title      TEXT NOT NULL,
  sort       INTEGER NOT NULL DEFAULT 0,
  is_active  INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_categories_tree ON categories (tenant_id, parent_id, sort);

CREATE TABLE IF NOT EXISTS products (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    TEXT NOT NULL,
  category_id  INTEGER,
  title        TEXT NOT NULL,
  description  TEXT,
  price_cents  INTEGER NOT NULL,
  stock        INTEGER,              -- NULL = unlimited
  sales_count  INTEGER NOT NULL DEFAULT 0,
  sort         INTEGER NOT NULL DEFAULT 0,
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_products_cat ON products (tenant_id, category_id, is_active, sort);
CREATE INDEX IF NOT EXISTS idx_products_top ON products (tenant_id, is_active, sales_count DESC);


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
