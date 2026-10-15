export interface Env {
  DB: D1Database;
  MASTER_KEY: string;
  ADMIN_SECRET: string;
  /** optional TronGrid API key (higher rate limits) */
  TRONGRID_KEY?: string;
}

export interface Tenant {
  id: string;
  owner_tg_id: number;
  bot_username: string;
  token_enc: string;
  webhook_secret: string;
  support_hours: string;
  usd_to_toman: number;
  welcome_text: string;
}

export interface User {
  tenant_id: string;
  tg_id: number;
  first_name: string | null;
  username: string | null;
  balance_cents: number;
  referrer_id: number | null;
  state: string | null;
  state_data: string | null;
}

export interface Category {
  id: number;
  tenant_id: string;
  parent_id: number | null;
  title: string;
  sort: number;
}

export interface Product {
  id: number;
  tenant_id: string;
  category_id: number | null;
  title: string;
  description: string | null;
  price_cents: number;
  sales_count: number;
  /** number of unsold items in product_items (computed in queries) */
  avail: number;
}

export interface Order {
  id: number;
  tenant_id: string;
  user_id: number;
  product_id: number;
  title: string;
  price_cents: number;
  status: 'pending' | 'delivered' | 'failed';
  delivered_payload: string | null;
  created_at: number;
}

export interface Deposit {
  id: number;
  tenant_id: string;
  user_id: number;
  method: 'card' | 'usdt';
  amount_cents: number;
  pay_amount: number;
  status: 'awaiting' | 'pending_review' | 'paid' | 'rejected' | 'expired';
  receipt: string | null;
  tx_hash: string | null;
  created_at: number;
  expires_at: number;
  paid_at: number | null;
}
