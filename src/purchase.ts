import { getProduct, getUser } from './db';

export type PurchaseResult =
  | { ok: true; orderId: number; title: string; priceCents: number; payload: string; balanceCents: number }
  | { ok: false; reason: 'not_found' | 'out_of_stock' | 'insufficient' | 'duplicate'; balanceCents?: number };

/**
 * Safe purchase flow (D1 has no interactive transactions, so we use
 * "reserve -> atomic charge batch -> release on failure"):
 *
 *  1. insert a pending order (unique nonce => double taps are ignored)
 *  2. reserve one unsold item for that order (single UPDATE ... RETURNING)
 *  3. ONE db.batch (a transaction): a wallet_tx row is inserted only if balance >= price;
 *     that row is the "success marker" that the balance debit, the order delivery and the
 *     sales counter are all conditioned on.
 *  4. if not charged -> release the item and mark the order failed.
 *
 * A crash can never lose money: money moves only inside step 3, which is atomic.
 * A crash before step 3 leaves a pending order + reserved item, which releaseStalePending() frees.
 */
export async function purchase(
  db: D1Database,
  tenantId: string,
  tgId: number,
  productId: number,
  nonce: string,
): Promise<PurchaseResult> {
  const product = await getProduct(db, tenantId, productId);
  if (!product) return { ok: false, reason: 'not_found' };
  const price = product.price_cents;

  // 1. pending order
  const order = await db
    .prepare(
      `INSERT INTO orders (tenant_id, user_id, product_id, title, price_cents, status, idem_key)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)
       ON CONFLICT(tenant_id, user_id, idem_key) DO NOTHING
       RETURNING id`,
    )
    .bind(tenantId, tgId, productId, product.title, price, nonce)
    .first<{ id: number }>();
  if (!order) return { ok: false, reason: 'duplicate' };
  const orderId = order.id;

  // 2. reserve an item
  const item = await db
    .prepare(
      `UPDATE product_items SET order_id = ?1
       WHERE id = (SELECT id FROM product_items WHERE tenant_id = ?2 AND product_id = ?3 AND order_id IS NULL ORDER BY id LIMIT 1)
         AND order_id IS NULL
       RETURNING id`,
    )
    .bind(orderId, tenantId, productId)
    .first<{ id: number }>();
  if (!item) {
    await db.prepare(`UPDATE orders SET status = 'failed', fail_reason = 'out_of_stock' WHERE id = ? AND status = 'pending'`).bind(orderId).run();
    return { ok: false, reason: 'out_of_stock' };
  }

  // 3. atomic charge + deliver
  const marker = `order:${orderId}`;
  await db.batch([
    db
      .prepare(
        `INSERT INTO wallet_tx (tenant_id, user_id, type, amount_cents, balance_after, ref, idempotency_key)
         SELECT ?1, ?2, 'purchase', 0 - ?3,
                (SELECT balance_cents FROM users WHERE tenant_id = ?1 AND tg_id = ?2) - ?3, ?4, ?5
         WHERE (SELECT balance_cents FROM users WHERE tenant_id = ?1 AND tg_id = ?2) >= ?3`,
      )
      .bind(tenantId, tgId, price, String(orderId), marker),
    db
      .prepare(
        `UPDATE users SET balance_cents = balance_cents - ?3
         WHERE tenant_id = ?1 AND tg_id = ?2
           AND EXISTS (SELECT 1 FROM wallet_tx WHERE tenant_id = ?1 AND idempotency_key = ?4)`,
      )
      .bind(tenantId, tgId, price, marker),
    db
      .prepare(
        `UPDATE orders SET status = 'delivered',
                delivered_payload = (SELECT payload FROM product_items WHERE order_id = ?1 LIMIT 1)
         WHERE id = ?1
           AND EXISTS (SELECT 1 FROM wallet_tx WHERE tenant_id = ?2 AND idempotency_key = ?3)`,
      )
      .bind(orderId, tenantId, marker),
    db
      .prepare(
        `UPDATE products SET sales_count = sales_count + 1
         WHERE tenant_id = ?1 AND id = ?2
           AND EXISTS (SELECT 1 FROM wallet_tx WHERE tenant_id = ?1 AND idempotency_key = ?3)`,
      )
      .bind(tenantId, productId, marker),
  ]);

  // 4. outcome
  const res = await db
    .prepare('SELECT status, delivered_payload FROM orders WHERE id = ?')
    .bind(orderId)
    .first<{ status: string; delivered_payload: string | null }>();
  const user = await getUser(db, tenantId, tgId);
  const balance = user?.balance_cents ?? 0;

  if (res?.status === 'delivered' && res.delivered_payload !== null) {
    return { ok: true, orderId, title: product.title, priceCents: price, payload: res.delivered_payload, balanceCents: balance };
  }

  await db.batch([
    db
      .prepare(`UPDATE product_items SET order_id = NULL WHERE order_id = ?1 AND EXISTS (SELECT 1 FROM orders WHERE id = ?1 AND status = 'pending')`)
      .bind(orderId),
    db.prepare(`UPDATE orders SET status = 'failed', fail_reason = 'insufficient' WHERE id = ? AND status = 'pending'`).bind(orderId),
  ]);
  return { ok: false, reason: 'insufficient', balanceCents: balance };
}

/** Free items reserved by orders that never reached the charge step (e.g. a crashed request). */
export async function releaseStalePending(db: D1Database) {
  await db.batch([
    db.prepare(
      `UPDATE product_items SET order_id = NULL
       WHERE order_id IN (SELECT id FROM orders WHERE status = 'pending' AND created_at < unixepoch() - 300)`,
    ),
    db.prepare(`UPDATE orders SET status = 'failed', fail_reason = 'timeout' WHERE status = 'pending' AND created_at < unixepoch() - 300`),
  ]);
}
