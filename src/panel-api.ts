import { safeEq, randomHex } from './crypto';
import { getTenant, getUser } from './db';
import { creditDeposit, getSettings, notifyPaid } from './payments';
import { tg } from './telegram';
import { getToken } from './token';
import type { Env, Tenant } from './types';
import { fmtUsd } from './ui';

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

// ---------- Telegram Mini App auth (initData) ----------
async function hmac(key: string | ArrayBuffer, msg: string): Promise<ArrayBuffer> {
  const raw = typeof key === 'string' ? new TextEncoder().encode(key) : key;
  const k = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
}
const toHex = (b: ArrayBuffer) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

/** Validates Telegram WebApp initData against the bot token. Returns the Telegram user id or null. */
export async function verifyInitData(initData: string, botToken: string): Promise<{ id: number } | null> {
  if (!initData) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const entries = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const checkString = entries.map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = await hmac('WebAppData', botToken);
  if (!safeEq(toHex(await hmac(secret, checkString)), hash)) return null;
  const authDate = Number(p.get('auth_date') ?? 0);
  if (!authDate || Date.now() / 1000 - authDate > 86400) return null;
  try {
    const u = JSON.parse(p.get('user') ?? '');
    return typeof u.id === 'number' ? { id: u.id } : null;
  } catch {
    return null;
  }
}

// ---------- validation helpers ----------
function str(v: unknown, max: number, what: string, required = true): string | null {
  if (v === undefined || v === null || v === '') {
    if (required) throw new HttpError(400, `${what} الزامی است`);
    return null;
  }
  const s = String(v).trim();
  if (!s && required) throw new HttpError(400, `${what} الزامی است`);
  if (s.length > max) throw new HttpError(400, `${what} طولانی است`);
  return s || null;
}
function num(v: unknown, what: string, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${what} نامعتبر است`);
  return n;
}
const pid = (v: string | undefined) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'شناسه نامعتبر است');
  return n;
};

async function assertCategory(env: Env, tenantId: string, id: number | null) {
  if (id === null) return;
  const r = await env.DB.prepare('SELECT 1 AS x FROM categories WHERE tenant_id = ? AND id = ?').bind(tenantId, id).first();
  if (!r) throw new HttpError(400, 'دسته پیدا نشد');
}

async function updateRow(env: Env, table: 'categories' | 'products', tenantId: string, id: number, sets: Record<string, unknown>) {
  const cols = Object.keys(sets);
  if (!cols.length) throw new HttpError(400, 'چیزی برای تغییر نیست');
  const sql = `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE tenant_id = ? AND id = ?`;
  const r = await env.DB.prepare(sql).bind(...cols.map((c) => sets[c]), tenantId, id).run();
  if (!r.meta.changes) throw new HttpError(404, 'پیدا نشد');
}

// ---------- router ----------
export async function handlePanelApi(req: Request, env: Env, ctx: ExecutionContext, parts: string[]): Promise<Response> {
  const tenant = await getTenant(env.DB, parts[1]);
  if (!tenant) return json({ error: 'not found' }, 404);
  const token = await getToken(env, tenant.id, tenant.token_enc);
  const who = await verifyInitData(req.headers.get('X-Init-Data') ?? '', token);
  if (!who || who.id !== tenant.owner_tg_id) return json({ error: 'forbidden' }, 403);

  const [res, id, sub] = parts.slice(2);
  const m = req.method;
  const body: any = m === 'GET' ? {} : await req.json().catch(() => ({}));
  const tid = tenant.id;

  try {
    // GET /overview
    if (res === 'overview' && m === 'GET') {
      const n = async (sql: string) => (await env.DB.prepare(sql).bind(tid).first<{ n: number }>())?.n ?? 0;
      const [users, orders, revenue, pending, low, recent] = await Promise.all([
        n('SELECT COUNT(*) AS n FROM users WHERE tenant_id = ?'),
        n(`SELECT COUNT(*) AS n FROM orders WHERE tenant_id = ? AND status = 'delivered'`),
        n(`SELECT COALESCE(SUM(price_cents), 0) AS n FROM orders WHERE tenant_id = ? AND status = 'delivered'`),
        n(`SELECT COUNT(*) AS n FROM deposits WHERE tenant_id = ? AND status = 'pending_review'`),
        env.DB
          .prepare(
            `SELECT p.id, p.title,
                    (SELECT COUNT(*) FROM product_items i WHERE i.tenant_id = p.tenant_id AND i.product_id = p.id AND i.order_id IS NULL) AS avail
             FROM products p WHERE p.tenant_id = ? AND p.is_active = 1 ORDER BY avail ASC, p.id DESC LIMIT 8`,
          )
          .bind(tid)
          .all(),
        env.DB
          .prepare(
            `SELECT id, title, price_cents, user_id, created_at FROM orders
             WHERE tenant_id = ? AND status = 'delivered' ORDER BY id DESC LIMIT 10`,
          )
          .bind(tid)
          .all(),
      ]);
      return json({ users, orders, revenue_cents: revenue, pending_deposits: pending, low_stock: low.results, recent_orders: recent.results });
    }

    // categories
    if (res === 'categories') {
      if (m === 'GET') {
        const r = await env.DB
          .prepare('SELECT id, parent_id, title, sort, is_active FROM categories WHERE tenant_id = ? ORDER BY sort, id')
          .bind(tid)
          .all();
        return json({ categories: r.results });
      }
      if (m === 'POST' && !id) {
        const title = str(body.title, 60, 'نام دسته')!;
        const parent = body.parent_id ? pid(String(body.parent_id)) : null;
        await assertCategory(env, tid, parent);
        const r = await env.DB
          .prepare('INSERT INTO categories (tenant_id, parent_id, title, sort) VALUES (?, ?, ?, ?)')
          .bind(tid, parent, title, Math.trunc(num(body.sort ?? 0, 'ترتیب', -9999, 9999)))
          .run();
        return json({ id: r.meta.last_row_id });
      }
      if (m === 'PATCH' && id) {
        const cid = pid(id);
        const sets: Record<string, unknown> = {};
        if ('title' in body) sets.title = str(body.title, 60, 'نام دسته');
        if ('sort' in body) sets.sort = Math.trunc(num(body.sort, 'ترتیب', -9999, 9999));
        if ('is_active' in body) sets.is_active = body.is_active ? 1 : 0;
        if ('parent_id' in body) {
          const parent = body.parent_id ? pid(String(body.parent_id)) : null;
          if (parent === cid) throw new HttpError(400, 'دسته نمی‌تواند والد خودش باشد');
          await assertCategory(env, tid, parent);
          sets.parent_id = parent;
        }
        await updateRow(env, 'categories', tid, cid, sets);
        return json({ ok: true });
      }
    }

    // products
    if (res === 'products') {
      if (m === 'GET' && !id) {
        const r = await env.DB
          .prepare(
            `SELECT p.id, p.category_id, p.title, p.description, p.price_cents, p.is_active, p.sales_count,
                    (SELECT COUNT(*) FROM product_items i WHERE i.tenant_id = p.tenant_id AND i.product_id = p.id AND i.order_id IS NULL) AS avail,
                    (SELECT COUNT(*) FROM product_items i WHERE i.tenant_id = p.tenant_id AND i.product_id = p.id AND i.order_id IS NOT NULL) AS sold
             FROM products p WHERE p.tenant_id = ? ORDER BY p.id DESC LIMIT 300`,
          )
          .bind(tid)
          .all();
        return json({ products: r.results });
      }
      if (m === 'POST' && !id) {
        const title = str(body.title, 120, 'نام محصول')!;
        const price = Math.round(num(body.price_usd, 'قیمت', 0.01, 100000) * 100);
        const cat = body.category_id ? pid(String(body.category_id)) : null;
        await assertCategory(env, tid, cat);
        const r = await env.DB
          .prepare('INSERT INTO products (tenant_id, category_id, title, description, price_cents) VALUES (?, ?, ?, ?, ?)')
          .bind(tid, cat, title, str(body.description, 1000, 'توضیحات', false), price)
          .run();
        return json({ id: r.meta.last_row_id });
      }
      if (m === 'PATCH' && id) {
        const p = pid(id);
        const sets: Record<string, unknown> = {};
        if ('title' in body) sets.title = str(body.title, 120, 'نام محصول');
        if ('description' in body) sets.description = str(body.description, 1000, 'توضیحات', false);
        if ('price_usd' in body) sets.price_cents = Math.round(num(body.price_usd, 'قیمت', 0.01, 100000) * 100);
        if ('is_active' in body) sets.is_active = body.is_active ? 1 : 0;
        if ('category_id' in body) {
          const cat = body.category_id ? pid(String(body.category_id)) : null;
          await assertCategory(env, tid, cat);
          sets.category_id = cat;
        }
        await updateRow(env, 'products', tid, p, sets);
        return json({ ok: true });
      }
      if (m === 'POST' && id && sub === 'items') {
        const p = pid(id);
        const exists = await env.DB.prepare('SELECT 1 AS x FROM products WHERE tenant_id = ? AND id = ?').bind(tid, p).first();
        if (!exists) throw new HttpError(404, 'محصول پیدا نشد');
        const items = String(body.text ?? '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);
        if (!items.length) throw new HttpError(400, 'آیتمی وارد نشده');
        if (items.length > 300) throw new HttpError(400, 'حداکثر ۳۰۰ آیتم در هر بار');
        for (let i = 0; i < items.length; i += 50) {
          await env.DB.batch(
            items
              .slice(i, i + 50)
              .map((payload) =>
                env.DB.prepare('INSERT INTO product_items (tenant_id, product_id, payload) VALUES (?, ?, ?)').bind(tid, p, payload.slice(0, 2000)),
              ),
          );
        }
        return json({ added: items.length });
      }
    }

    // deposits
    if (res === 'deposits') {
      if (m === 'GET') {
        const r = await env.DB
          .prepare(
            `SELECT d.id, d.user_id, d.method, d.amount_cents, d.status, d.created_at, u.first_name, u.username
             FROM deposits d LEFT JOIN users u ON u.tenant_id = d.tenant_id AND u.tg_id = d.user_id
             WHERE d.tenant_id = ?
             ORDER BY (d.status = 'pending_review') DESC, d.id DESC LIMIT 40`,
          )
          .bind(tid)
          .all();
        return json({ deposits: r.results });
      }
      if (m === 'POST' && id && (sub === 'approve' || sub === 'reject')) {
        const d = pid(id);
        if (sub === 'approve') {
          const s = await getSettings(env.DB, tid);
          const ok = await creditDeposit(env.DB, tid, d, null, Number(s.referral_percent ?? 0) || 0);
          if (!ok) throw new HttpError(409, 'این درخواست قبلاً بررسی شده');
          ctx.waitUntil(notifyPaid(env, tenant, d).catch(() => {}));
        } else {
          const dep = await env.DB
            .prepare('SELECT user_id, amount_cents FROM deposits WHERE tenant_id = ? AND id = ?')
            .bind(tid, d)
            .first<{ user_id: number; amount_cents: number }>();
          const r = await env.DB
            .prepare(`UPDATE deposits SET status = 'rejected' WHERE tenant_id = ? AND id = ? AND status = 'pending_review'`)
            .bind(tid, d)
            .run();
          if (!r.meta.changes || !dep) throw new HttpError(409, 'این درخواست قبلاً بررسی شده');
          ctx.waitUntil(
            tg(token, 'sendMessage', {
              chat_id: dep.user_id,
              text: `❌ درخواست شارژ ${fmtUsd(dep.amount_cents)} تأیید نشد. در صورت نیاز با پشتیبانی تماس بگیرید.`,
            }).catch(() => {}),
          );
        }
        return json({ ok: true });
      }
    }

    // manual wallet credit
    if (res === 'users' && m === 'POST' && id && sub === 'credit') {
      const uid = pid(id);
      const cents = Math.round(num(body.amount_usd, 'مبلغ', 0.01, 100000) * 100);
      if (!(await getUser(env.DB, tid, uid))) throw new HttpError(404, 'کاربر پیدا نشد (باید یک‌بار /start زده باشد)');
      const key = `panel:${randomHex(8)}`;
      await env.DB.batch([
        env.DB
          .prepare(
            `INSERT INTO wallet_tx (tenant_id, user_id, type, amount_cents, balance_after, ref, idempotency_key)
             SELECT ?1, ?2, 'deposit', ?3, (SELECT balance_cents FROM users WHERE tenant_id = ?1 AND tg_id = ?2) + ?3, 'panel', ?4
             WHERE EXISTS (SELECT 1 FROM users WHERE tenant_id = ?1 AND tg_id = ?2)`,
          )
          .bind(tid, uid, cents, key),
        env.DB
          .prepare(
            `UPDATE users SET balance_cents = balance_cents + ?3
             WHERE tenant_id = ?1 AND tg_id = ?2
               AND EXISTS (SELECT 1 FROM wallet_tx WHERE tenant_id = ?1 AND idempotency_key = ?4)`,
          )
          .bind(tid, uid, cents, key),
      ]);
      const u = await getUser(env.DB, tid, uid);
      ctx.waitUntil(
        tg(token, 'sendMessage', {
          chat_id: uid,
          text: `✅ کیف پول شما ${fmtUsd(cents)} شارژ شد.\n💰 موجودی: ${fmtUsd(u?.balance_cents ?? 0)}`,
        }).catch(() => {}),
      );
      return json({ balance_usd: (u?.balance_cents ?? 0) / 100 });
    }

    // settings
    if (res === 'settings') {
      if (m === 'GET') return json(await readSettings(env, tenant));
      if (m === 'POST') {
        await writeSettings(env, tenant, body);
        return json({ ok: true });
      }
    }

    return json({ error: 'not found' }, 404);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error('panel api error', e);
    return json({ error: 'خطای داخلی' }, 500);
  }
}

// ---------- settings ----------
const KV_KEYS = ['card_number', 'card_holder', 'usdt_trc20_address', 'min_deposit_usd', 'referral_percent'] as const;

async function readSettings(env: Env, tenant: Tenant) {
  const kv = await getSettings(env.DB, tenant.id);
  return {
    ...kv,
    usd_to_toman: tenant.usd_to_toman,
    support_hours: tenant.support_hours,
    welcome_text: tenant.welcome_text,
  };
}

async function writeSettings(env: Env, tenant: Tenant, body: any) {
  const ops: D1PreparedStatement[] = [];
  for (const k of KV_KEYS) {
    if (!(k in body)) continue;
    const v = String(body[k] ?? '').trim();
    if (!v) {
      ops.push(env.DB.prepare('DELETE FROM tenant_settings WHERE tenant_id = ? AND key = ?').bind(tenant.id, k));
      continue;
    }
    if (k === 'usdt_trc20_address' && !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(v)) throw new HttpError(400, 'آدرس TRON نامعتبر است');
    if (k === 'card_number' && !/^[0-9\s-]{12,24}$/.test(v)) throw new HttpError(400, 'شماره کارت نامعتبر است');
    if (k === 'card_holder' && v.length > 80) throw new HttpError(400, 'نام صاحب کارت طولانی است');
    if (k === 'min_deposit_usd') num(v, 'حداقل شارژ', 0.01, 10000);
    if (k === 'referral_percent') num(v, 'درصد پاداش', 0, 50);
    ops.push(
      env.DB
        .prepare('INSERT INTO tenant_settings (tenant_id, key, value) VALUES (?, ?, ?) ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value')
        .bind(tenant.id, k, v),
    );
  }

  const sets: string[] = [];
  const vals: unknown[] = [];
  const rate = String(body.usd_to_toman ?? '').trim();
  if (rate) {
    sets.push('usd_to_toman = ?');
    vals.push(Math.round(num(rate, 'نرخ دلار', 1000, 10_000_000)));
  }
  const hours = String(body.support_hours ?? '').trim();
  if (hours) {
    sets.push('support_hours = ?');
    vals.push(str(hours, 200, 'ساعت پشتیبانی'));
  }
  const welcome = String(body.welcome_text ?? '').trim();
  if (welcome) {
    sets.push('welcome_text = ?');
    vals.push(str(welcome, 500, 'متن خوش‌آمدگویی'));
  }
  if (sets.length) ops.push(env.DB.prepare(`UPDATE tenants SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, tenant.id));
  if (ops.length) await env.DB.batch(ops);
}
