import { encrypt, randomHex, safeEq } from './crypto';
import { getTenant, getUser } from './db';
import { handleUpdate } from './handlers';
import { expireDeposits, pollUsdt } from './payments';
import { releaseStalePending } from './purchase';
import { tg } from './telegram';
import { getToken } from './token';
import type { Env } from './types';
import { fmtUsd } from './ui';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split('/').filter(Boolean);

    if (req.method === 'POST' && parts[0] === 'wh' && parts[1]) return webhook(req, env, ctx, parts[1]);
    if (parts[0] === 'admin') return admin(req, env, ctx, url, parts);
    return new Response('ok');
  },

  // Cron (see wrangler.toml [triggers]): free stale reservations, expire old deposits, detect USDT payments
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        await releaseStalePending(env.DB);
        await expireDeposits(env.DB);
        await pollUsdt(env);
      })().catch((e) => console.error('cron failed', e)),
    );
  },
};

async function webhook(req: Request, env: Env, ctx: ExecutionContext, tenantId: string) {
  const tenant = await getTenant(env.DB, tenantId);
  if (!tenant) return new Response('not found', { status: 404 });

  const secret = req.headers.get('X-Telegram-Bot-Api-Secret-Token') ?? '';
  if (!safeEq(secret, tenant.webhook_secret)) return new Response('forbidden', { status: 403 });

  const update = await req.json().catch(() => null);
  if (!update) return new Response('bad request', { status: 400 });

  const token = await getToken(env, tenant.id, tenant.token_enc);
  // Reply 200 immediately; process in background so Telegram never retries slow updates.
  ctx.waitUntil(handleUpdate(env, tenant, token, update).catch((e) => console.error('update failed', tenant.id, e)));
  return new Response('ok');
}

// ---- Temporary admin API (replaced by the seller panel in step 6) ----
async function admin(req: Request, env: Env, ctx: ExecutionContext, url: URL, parts: string[]) {
  if (!env.ADMIN_SECRET || env.ADMIN_SECRET.length < 16) return new Response('admin disabled', { status: 503 });
  const auth = req.headers.get('Authorization') ?? '';
  if (!safeEq(auth, `Bearer ${env.ADMIN_SECRET}`)) return new Response('forbidden', { status: 403 });
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const body: any = await req.json().catch(() => ({}));

  // POST /admin/tenants  { bot_token, owner_tg_id, usd_to_toman?, support_hours?, welcome_text? }
  if (parts[1] === 'tenants' && parts.length === 2) {
    if (!body.bot_token || !body.owner_tg_id) return json({ error: 'bot_token and owner_tg_id required' }, 400);
    const me = await tg<{ username: string }>(body.bot_token, 'getMe').catch(() => null);
    if (!me) return json({ error: 'invalid bot token' }, 400);

    const id = randomHex(6);
    const secret = randomHex(24);
    try {
      await env.DB.prepare(
        `INSERT INTO tenants (id, owner_tg_id, bot_username, token_enc, webhook_secret, usd_to_toman, support_hours, welcome_text)
         VALUES (?, ?, ?, ?, ?, COALESCE(?, 275000), COALESCE(?, 'پاسخگویی از ۹ صبح تا ۹ شب'), COALESCE(?, 'به فروشگاه ما خوش آمدید 👋'))`,
      )
        .bind(
          id,
          body.owner_tg_id,
          me.username,
          await encrypt(env.MASTER_KEY, body.bot_token),
          secret,
          body.usd_to_toman ?? null,
          body.support_hours ?? null,
          body.welcome_text ?? null,
        )
        .run();
    } catch (e) {
      const msg = String(e);
      const dup = /UNIQUE/i.test(msg);
      return json({ error: dup ? 'bot already registered' : msg }, dup ? 409 : 500);
    }

    await tg(body.bot_token, 'setWebhook', {
      url: `${url.origin}/wh/${id}`,
      secret_token: secret,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true,
    });
    return json({ id, bot: `@${me.username}` });
  }

  if (parts[1] !== 'tenants' || !parts[2]) return new Response('not found', { status: 404 });
  const tenantId = parts[2];
  const tenant = await getTenant(env.DB, tenantId);
  if (!tenant) return json({ error: 'tenant not found' }, 404);

  // POST /admin/tenants/:id/settings
  //   { card_number?, card_holder?, usdt_trc20_address?, min_deposit_usd?, referral_percent? }
  if (parts[3] === 'settings' && parts.length === 4) {
    const allowed = ['card_number', 'card_holder', 'usdt_trc20_address', 'min_deposit_usd', 'referral_percent'];
    const entries = Object.entries(body).filter(([k]) => allowed.includes(k));
    if (!entries.length) return json({ error: 'no valid keys', allowed }, 400);
    if (body.usdt_trc20_address && !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(String(body.usdt_trc20_address))) {
      return json({ error: 'invalid TRON address' }, 400);
    }
    await env.DB.batch(
      entries.map(([k, v]) =>
        env.DB.prepare(
          'INSERT INTO tenant_settings (tenant_id, key, value) VALUES (?, ?, ?) ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value',
        ).bind(tenantId, k, String(v)),
      ),
    );
    return json({ ok: true, updated: entries.map(([k]) => k) });
  }

  // POST /admin/tenants/:id/categories  { title, parent_id?, sort? }
  if (parts[3] === 'categories' && parts.length === 4) {
    if (!body.title) return json({ error: 'title required' }, 400);
    const r = await env.DB.prepare('INSERT INTO categories (tenant_id, parent_id, title, sort) VALUES (?, ?, ?, ?)')
      .bind(tenantId, body.parent_id ?? null, body.title, body.sort ?? 0)
      .run();
    return json({ id: r.meta.last_row_id });
  }

  // POST /admin/tenants/:id/products  { title, price_usd, category_id?, description?, sort? }
  if (parts[3] === 'products' && parts.length === 4) {
    if (!body.title || typeof body.price_usd !== 'number') return json({ error: 'title and price_usd required' }, 400);
    const r = await env.DB.prepare(
      'INSERT INTO products (tenant_id, category_id, title, description, price_cents, sort) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(tenantId, body.category_id ?? null, body.title, body.description ?? null, Math.round(body.price_usd * 100), body.sort ?? 0)
      .run();
    return json({ id: r.meta.last_row_id });
  }

  // POST /admin/tenants/:id/products/:pid/items  { items: string[] }  or  { text: "one item per line" }
  if (parts[3] === 'products' && parts[4] && parts[5] === 'items' && parts.length === 6) {
    const pid = Number(parts[4]);
    const prod = await env.DB.prepare('SELECT id FROM products WHERE tenant_id = ? AND id = ?').bind(tenantId, pid).first();
    if (!prod) return json({ error: 'product not found' }, 404);

    let items: string[] = Array.isArray(body.items) ? body.items.map(String) : [];
    if (typeof body.text === 'string') items = items.concat(body.text.split('\n'));
    items = items.map((s) => s.trim()).filter(Boolean);
    if (!items.length) return json({ error: 'no items' }, 400);
    if (items.length > 300) return json({ error: 'max 300 items per request' }, 400);

    for (let i = 0; i < items.length; i += 50) {
      await env.DB.batch(
        items
          .slice(i, i + 50)
          .map((payload) =>
            env.DB.prepare('INSERT INTO product_items (tenant_id, product_id, payload) VALUES (?, ?, ?)').bind(tenantId, pid, payload),
          ),
      );
    }
    const stock = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM product_items WHERE tenant_id = ? AND product_id = ? AND order_id IS NULL',
    )
      .bind(tenantId, pid)
      .first<{ n: number }>();
    return json({ added: items.length, available: stock?.n ?? 0 });
  }

  // POST /admin/tenants/:id/users/:tgId/credit  { amount_usd, key? }
  if (parts[3] === 'users' && parts[4] && parts[5] === 'credit' && parts.length === 6) {
    const uid = Number(parts[4]);
    const amount = Math.round(Number(body.amount_usd) * 100);
    if (!Number.isFinite(amount) || amount <= 0) return json({ error: 'amount_usd must be > 0' }, 400);
    if (!(await getUser(env.DB, tenantId, uid))) return json({ error: 'user not found (they must /start the bot first)' }, 404);

    const key = `admin:${body.key ?? randomHex(8)}`;
    try {
      await env.DB.batch([
        env.DB
          .prepare(
            `INSERT INTO wallet_tx (tenant_id, user_id, type, amount_cents, balance_after, ref, idempotency_key)
             SELECT ?1, ?2, 'deposit', ?3, (SELECT balance_cents FROM users WHERE tenant_id = ?1 AND tg_id = ?2) + ?3, 'admin', ?4
             WHERE EXISTS (SELECT 1 FROM users WHERE tenant_id = ?1 AND tg_id = ?2)`,
          )
          .bind(tenantId, uid, amount, key),
        env.DB
          .prepare(
            `UPDATE users SET balance_cents = balance_cents + ?3
             WHERE tenant_id = ?1 AND tg_id = ?2
               AND EXISTS (SELECT 1 FROM wallet_tx WHERE tenant_id = ?1 AND idempotency_key = ?4)`,
          )
          .bind(tenantId, uid, amount, key),
      ]);
    } catch {
      return json({ error: 'duplicate key' }, 409);
    }

    const u = await getUser(env.DB, tenantId, uid);
    const token = await getToken(env, tenant.id, tenant.token_enc);
    ctx.waitUntil(
      tg(token, 'sendMessage', {
        chat_id: uid,
        text: `✅ کیف پول شما ${fmtUsd(amount)} شارژ شد.\n💰 موجودی: ${fmtUsd(u?.balance_cents ?? 0)}`,
      }).catch(() => {}),
    );
    return json({ balance_usd: (u?.balance_cents ?? 0) / 100 });
  }

  return new Response('not found', { status: 404 });
}
