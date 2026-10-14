import { decrypt, encrypt, randomHex, safeEq } from './crypto';
import { getTenant } from './db';
import { handleUpdate } from './handlers';
import { tg } from './telegram';
import type { Env } from './types';

// token cache per isolate: tenantId -> { enc, token }
const tokenCache = new Map<string, { enc: string; token: string }>();

async function getToken(env: Env, tenantId: string, enc: string) {
  const hit = tokenCache.get(tenantId);
  if (hit && hit.enc === enc) return hit.token;
  const token = await decrypt(env.MASTER_KEY, enc);
  tokenCache.set(tenantId, { enc, token });
  return token;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split('/').filter(Boolean);

    if (req.method === 'POST' && parts[0] === 'wh' && parts[1]) return webhook(req, env, ctx, parts[1]);
    if (parts[0] === 'admin') return admin(req, env, url, parts);
    return new Response('ok');
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
async function admin(req: Request, env: Env, url: URL, parts: string[]) {
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
    } catch {
      return json({ error: 'bot already registered' }, 409);
    }

    await tg(body.bot_token, 'setWebhook', {
      url: `${url.origin}/wh/${id}`,
      secret_token: secret,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true,
    });
    return json({ id, bot: `@${me.username}` });
  }

  // POST /admin/tenants/:id/categories  { title, parent_id?, sort? }
  // POST /admin/tenants/:id/products    { title, price_usd, category_id?, description?, stock?, sort? }
  if (parts[1] === 'tenants' && parts[2] && parts.length === 4) {
    const tenantId = parts[2];
    if (!(await getTenant(env.DB, tenantId))) return json({ error: 'tenant not found' }, 404);

    if (parts[3] === 'categories') {
      if (!body.title) return json({ error: 'title required' }, 400);
      const r = await env.DB.prepare('INSERT INTO categories (tenant_id, parent_id, title, sort) VALUES (?, ?, ?, ?)')
        .bind(tenantId, body.parent_id ?? null, body.title, body.sort ?? 0)
        .run();
      return json({ id: r.meta.last_row_id });
    }
    if (parts[3] === 'products') {
      if (!body.title || typeof body.price_usd !== 'number') return json({ error: 'title and price_usd required' }, 400);
      const r = await env.DB.prepare(
        'INSERT INTO products (tenant_id, category_id, title, description, price_cents, stock, sort) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
        .bind(
          tenantId,
          body.category_id ?? null,
          body.title,
          body.description ?? null,
          Math.round(body.price_usd * 100),
          body.stock ?? null,
          body.sort ?? 0,
        )
        .run();
      return json({ id: r.meta.last_row_id });
    }
  }
  return new Response('not found', { status: 404 });
}
