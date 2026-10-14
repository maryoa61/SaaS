import type { Category, Product, Tenant, User } from './types';

export const getTenant = (db: D1Database, id: string) =>
  db.prepare('SELECT * FROM tenants WHERE id = ?').bind(id).first<Tenant>();

export const getUser = (db: D1Database, tenantId: string, tgId: number) =>
  db.prepare('SELECT * FROM users WHERE tenant_id = ? AND tg_id = ?').bind(tenantId, tgId).first<User>();

export async function upsertUser(
  db: D1Database,
  tenantId: string,
  from: { id: number; first_name?: string; username?: string },
  referrerId: number | null,
): Promise<User> {
  const row = await db
    .prepare(
      `INSERT INTO users (tenant_id, tg_id, first_name, username, referrer_id) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, tg_id) DO UPDATE SET
         first_name = excluded.first_name, username = excluded.username, last_seen = unixepoch()
       RETURNING *`,
    )
    .bind(tenantId, from.id, from.first_name ?? null, from.username ?? null, referrerId)
    .first<User>();
  return row!;
}

export const setState = (db: D1Database, tenantId: string, tgId: number, state: string | null, data: string | null = null) =>
  db
    .prepare('UPDATE users SET state = ?, state_data = ? WHERE tenant_id = ? AND tg_id = ?')
    .bind(state, data, tenantId, tgId)
    .run();

export const getCategory = (db: D1Database, tenantId: string, id: number) =>
  db.prepare('SELECT * FROM categories WHERE tenant_id = ? AND id = ? AND is_active = 1').bind(tenantId, id).first<Category>();

export async function listCategories(db: D1Database, tenantId: string, parentId: number | null) {
  const r = await db
    .prepare('SELECT * FROM categories WHERE tenant_id = ? AND parent_id IS ? AND is_active = 1 ORDER BY sort, id')
    .bind(tenantId, parentId)
    .all<Category>();
  return r.results;
}

export async function countProducts(db: D1Database, tenantId: string, categoryId: number | null) {
  const r = await db
    .prepare('SELECT COUNT(*) AS n FROM products WHERE tenant_id = ? AND category_id IS ? AND is_active = 1')
    .bind(tenantId, categoryId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

export async function listProducts(db: D1Database, tenantId: string, categoryId: number | null, limit: number, offset: number) {
  const r = await db
    .prepare(
      `SELECT * FROM products WHERE tenant_id = ? AND category_id IS ? AND is_active = 1
       ORDER BY sort, id LIMIT ? OFFSET ?`,
    )
    .bind(tenantId, categoryId, limit, offset)
    .all<Product>();
  return r.results;
}

export const getProduct = (db: D1Database, tenantId: string, id: number) =>
  db.prepare('SELECT * FROM products WHERE tenant_id = ? AND id = ? AND is_active = 1').bind(tenantId, id).first<Product>();

export async function topProducts(db: D1Database, tenantId: string, limit = 10) {
  const r = await db
    .prepare('SELECT * FROM products WHERE tenant_id = ? AND is_active = 1 ORDER BY sales_count DESC, id DESC LIMIT ?')
    .bind(tenantId, limit)
    .all<Product>();
  return r.results;
}

export async function searchProducts(db: D1Database, tenantId: string, q: string, limit = 10) {
  const like = `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
  const r = await db
    .prepare(
      `SELECT * FROM products WHERE tenant_id = ? AND is_active = 1 AND title LIKE ? ESCAPE '\\'
       ORDER BY sales_count DESC, id DESC LIMIT ?`,
    )
    .bind(tenantId, like, limit)
    .all<Product>();
  return r.results;
}
