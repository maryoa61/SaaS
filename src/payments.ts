import { getTenant, getUser } from './db';
import { getToken } from './token';
import { tg } from './telegram';
import type { Deposit, Env, Tenant } from './types';
import { fmtUsd } from './ui';

const USDT_TRC20 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

// ---------- settings ----------
export async function getSettings(db: D1Database, tenantId: string): Promise<Record<string, string>> {
  const r = await db
    .prepare('SELECT key, value FROM tenant_settings WHERE tenant_id = ?')
    .bind(tenantId)
    .all<{ key: string; value: string }>();
  return Object.fromEntries(r.results.map((x) => [x.key, x.value]));
}

/** "۱۰", "10,5", "10.5" -> number | null (USD, max 2 decimals) */
export function parseAmount(input: string): number | null {
  const s = input
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[٫,،]/g, '.')
    .replace(/\s/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ---------- deposits ----------
export const getDeposit = (db: D1Database, tenantId: string, id: number, userId?: number) =>
  userId === undefined
    ? db.prepare('SELECT * FROM deposits WHERE tenant_id = ? AND id = ?').bind(tenantId, id).first<Deposit>()
    : db.prepare('SELECT * FROM deposits WHERE tenant_id = ? AND id = ? AND user_id = ?').bind(tenantId, id, userId).first<Deposit>();

export async function createCardDeposit(db: D1Database, tenantId: string, userId: number, cents: number, toman: number) {
  const row = await db
    .prepare(
      `INSERT INTO deposits (tenant_id, user_id, method, amount_cents, pay_amount, expires_at)
       VALUES (?, ?, 'card', ?, ?, unixepoch() + 86400) RETURNING id`,
    )
    .bind(tenantId, userId, cents, toman)
    .first<{ id: number }>();
  return row!.id;
}

/** exact amount = cents*10000 micro-USDT + a tiny unique suffix (<0.01 USDT) so each open deposit is identifiable */
export async function createUsdtDeposit(db: D1Database, tenantId: string, userId: number, cents: number) {
  const base = cents * 10000;
  for (let i = 0; i < 8; i++) {
    const micro = base + 1 + Math.floor(Math.random() * 9999);
    try {
      const row = await db
        .prepare(
          `INSERT INTO deposits (tenant_id, user_id, method, amount_cents, pay_amount, expires_at)
           VALUES (?, ?, 'usdt', ?, ?, unixepoch() + 3600) RETURNING id`,
        )
        .bind(tenantId, userId, cents, micro)
        .first<{ id: number }>();
      return { id: row!.id, micro };
    } catch {
      // unique collision with another open deposit -> pick another suffix
    }
  }
  throw new Error('could not allocate a unique amount');
}

/**
 * Atomically credit a deposit (and the referrer's bonus on the user's first paid deposit).
 * Every statement is gated on the deposit still being awaiting/pending_review, and the final
 * statement flips it to 'paid' -- so running this twice can never credit twice.
 */
export async function creditDeposit(
  db: D1Database,
  tenantId: string,
  depositId: number,
  txHash: string | null,
  referralPercent: number,
): Promise<boolean> {
  const key = `dep:${depositId}`;
  const bonusKey = `refbonus:${depositId}`;
  const open = `('awaiting','pending_review')`;
  try {
    const res = await db.batch([
      // 1) ledger row for the deposit (the marker)
      db
        .prepare(
          `INSERT INTO wallet_tx (tenant_id, user_id, type, amount_cents, balance_after, ref, idempotency_key)
           SELECT d.tenant_id, d.user_id, 'deposit', d.amount_cents,
                  (SELECT balance_cents FROM users u WHERE u.tenant_id = d.tenant_id AND u.tg_id = d.user_id) + d.amount_cents,
                  ?3, ?4
           FROM deposits d WHERE d.id = ?1 AND d.tenant_id = ?2 AND d.status IN ${open}`,
        )
        .bind(depositId, tenantId, String(depositId), key),
      // 2) credit the user
      db
        .prepare(
          `UPDATE users SET balance_cents = balance_cents + (SELECT amount_cents FROM deposits WHERE id = ?1)
           WHERE tenant_id = ?2 AND tg_id = (SELECT user_id FROM deposits WHERE id = ?1)
             AND (SELECT status FROM deposits WHERE id = ?1) IN ${open}
             AND EXISTS (SELECT 1 FROM wallet_tx WHERE tenant_id = ?2 AND idempotency_key = ?3)`,
        )
        .bind(depositId, tenantId, key),
      // 3) referral bonus row (only for the referred user's first paid deposit)
      db
        .prepare(
          `INSERT INTO wallet_tx (tenant_id, user_id, type, amount_cents, balance_after, ref, idempotency_key)
           SELECT d.tenant_id, u.referrer_id, 'referral', d.amount_cents * ?3 / 100,
                  (SELECT balance_cents FROM users r WHERE r.tenant_id = d.tenant_id AND r.tg_id = u.referrer_id) + d.amount_cents * ?3 / 100,
                  ?4, ?5
           FROM deposits d JOIN users u ON u.tenant_id = d.tenant_id AND u.tg_id = d.user_id
           WHERE d.id = ?1 AND d.tenant_id = ?2 AND d.status IN ${open}
             AND u.referrer_id IS NOT NULL AND d.amount_cents * ?3 / 100 > 0
             AND NOT EXISTS (SELECT 1 FROM deposits x WHERE x.tenant_id = d.tenant_id AND x.user_id = d.user_id AND x.status = 'paid')
             AND EXISTS (SELECT 1 FROM users r WHERE r.tenant_id = d.tenant_id AND r.tg_id = u.referrer_id)`,
        )
        .bind(depositId, tenantId, Math.max(0, Math.floor(referralPercent)), String(depositId), bonusKey),
      // 4) credit the referrer
      db
        .prepare(
          `UPDATE users SET balance_cents = balance_cents + (SELECT amount_cents FROM wallet_tx WHERE tenant_id = ?1 AND idempotency_key = ?3)
           WHERE tenant_id = ?1 AND tg_id = (SELECT user_id FROM wallet_tx WHERE tenant_id = ?1 AND idempotency_key = ?3)
             AND (SELECT status FROM deposits WHERE id = ?2) IN ${open}`,
        )
        .bind(tenantId, depositId, bonusKey),
      // 5) mark paid
      db
        .prepare(
          `UPDATE deposits SET status = 'paid', tx_hash = ?3, paid_at = unixepoch()
           WHERE id = ?1 AND tenant_id = ?2 AND status IN ${open}
             AND EXISTS (SELECT 1 FROM wallet_tx WHERE tenant_id = ?2 AND idempotency_key = ?4)`,
        )
        .bind(depositId, tenantId, txHash, key),
    ]);
    return (res[4].meta.changes ?? 0) === 1;
  } catch (e) {
    console.error('creditDeposit failed', depositId, e);
    return false;
  }
}

export async function notifyPaid(env: Env, tenant: Tenant, depositId: number) {
  const token = await getToken(env, tenant.id, tenant.token_enc);
  const d = await getDeposit(env.DB, tenant.id, depositId);
  if (!d) return;
  const u = await getUser(env.DB, tenant.id, d.user_id);
  await tg(token, 'sendMessage', {
    chat_id: d.user_id,
    text: `✅ شارژ کیف پول تأیید شد\n\n💵 ${fmtUsd(d.amount_cents)}\n💰 موجودی: ${fmtUsd(u?.balance_cents ?? 0)}`,
  }).catch(() => {});

  const b = await env.DB
    .prepare('SELECT user_id, amount_cents FROM wallet_tx WHERE tenant_id = ? AND idempotency_key = ?')
    .bind(tenant.id, `refbonus:${depositId}`)
    .first<{ user_id: number; amount_cents: number }>();
  if (b) {
    await tg(token, 'sendMessage', {
      chat_id: b.user_id,
      text: `🎁 پاداش دعوت: ${fmtUsd(b.amount_cents)} به کیف پول شما اضافه شد.`,
    }).catch(() => {});
  }
}

export const expireDeposits = (db: D1Database) =>
  db.prepare(`UPDATE deposits SET status = 'expired' WHERE status = 'awaiting' AND expires_at < unixepoch()`).run();

// ---------- USDT (TRC20) auto-detection via TronGrid ----------
async function fetchTrc20(env: Env, addr: string, minTimestampMs: number) {
  const url =
    `https://api.trongrid.io/v1/accounts/${addr}/transactions/trc20` +
    `?only_to=true&only_confirmed=true&limit=200&contract_address=${USDT_TRC20}&min_timestamp=${minTimestampMs}`;
  const r = await fetch(url, { headers: env.TRONGRID_KEY ? { 'TRON-PRO-API-KEY': env.TRONGRID_KEY } : {} });
  if (!r.ok) throw new Error(`trongrid ${r.status}`);
  const j = (await r.json()) as { data?: Array<{ transaction_id: string; value: string; block_timestamp: number; to: string }> };
  return (j.data ?? [])
    .filter((t) => t.to === addr)
    .map((t) => ({ id: t.transaction_id, value: String(t.value), ts: t.block_timestamp }));
}

/** Match open USDT deposits against incoming transfers. Returns how many were credited. */
export async function pollUsdt(env: Env, opts: { depositId?: number } = {}): Promise<number> {
  const rows = opts.depositId
    ? await env.DB.prepare(`SELECT * FROM deposits WHERE id = ? AND method = 'usdt' AND status = 'awaiting'`).bind(opts.depositId).all<Deposit>()
    : await env.DB
        .prepare(`SELECT * FROM deposits WHERE method = 'usdt' AND status = 'awaiting' AND expires_at > unixepoch() LIMIT 100`)
        .all<Deposit>();

  const byTenant = new Map<string, Deposit[]>();
  for (const d of rows.results) {
    const list = byTenant.get(d.tenant_id) ?? [];
    list.push(d);
    byTenant.set(d.tenant_id, list);
  }

  let credited = 0;
  for (const [tenantId, deps] of byTenant) {
    const tenant = await getTenant(env.DB, tenantId);
    if (!tenant) continue;
    const settings = await getSettings(env.DB, tenantId);
    const addr = settings.usdt_trc20_address;
    if (!addr) continue;

    let transfers: Awaited<ReturnType<typeof fetchTrc20>>;
    try {
      transfers = await fetchTrc20(env, addr, Math.min(...deps.map((d) => d.created_at)) * 1000);
    } catch (e) {
      console.error('trongrid fetch failed', tenantId, e);
      continue;
    }

    const pct = Number(settings.referral_percent ?? 0) || 0;
    for (const d of deps) {
      const t = transfers.find((x) => x.value === String(d.pay_amount) && x.ts >= d.created_at * 1000);
      if (!t) continue;
      if (await creditDeposit(env.DB, tenantId, d.id, t.id, pct)) {
        credited++;
        await notifyPaid(env, tenant, d.id);
      }
    }
  }
  return credited;
}
