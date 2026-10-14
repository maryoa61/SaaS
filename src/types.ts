export interface Env {
  DB: D1Database;
  MASTER_KEY: string;
  ADMIN_SECRET: string;
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
  stock: number | null;
  sales_count: number;
}
