import {
  countOrders,
  countProducts,
  getCategory,
  getOrder,
  getProduct,
  listCategories,
  listOrders,
  listProducts,
  searchProducts,
  topProducts,
} from './db';
import type { Product, Tenant } from './types';
import { esc, fmtDate, fmtToman, fmtUsd } from './ui';

type Btn = { text: string; callback_data: string } | { text: string; url: string };
export interface View {
  text: string;
  reply_markup: { inline_keyboard: Btn[][] };
}

export const PAGE_SIZE = 8;
const MENU: Btn = { text: '🏠 منو', callback_data: 'm' };

const productRow = (p: Product): Btn[] => [
  {
    text: `${p.title} — ${fmtUsd(p.price_cents)}${p.avail <= 0 ? ' ❌' : ''}`,
    callback_data: `p:${p.id}`,
  },
];

function pager(prefix: string, page: number, pages: number): Btn[] {
  const nav: Btn[] = [];
  if (page > 0) nav.push({ text: '«', callback_data: `${prefix}:${page - 1}` });
  nav.push({ text: `${page + 1}/${pages}`, callback_data: 'noop' });
  if (page < pages - 1) nav.push({ text: '»', callback_data: `${prefix}:${page + 1}` });
  return nav;
}

export function mainMenuView(tenant: Tenant): View {
  return {
    text: `🏠 <b>منوی اصلی</b>\n\n${esc(tenant.welcome_text)}`,
    reply_markup: { inline_keyboard: [[{ text: '🛍 فروشگاه', callback_data: 'c:0:0' }]] },
  };
}

export async function categoryView(db: D1Database, tenantId: string, catId: number, page: number): Promise<View> {
  const cat = catId ? await getCategory(db, tenantId, catId) : null;
  const parentKey = catId || null;
  const [subs, total] = await Promise.all([listCategories(db, tenantId, parentKey), countProducts(db, tenantId, parentKey)]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const prods = await listProducts(db, tenantId, parentKey, PAGE_SIZE, p * PAGE_SIZE);

  const rows: Btn[][] = [];
  if (!catId) rows.push([{ text: '🔥 پرفروش‌ترین‌ها', callback_data: 'top' }]);
  for (let i = 0; i < subs.length; i += 2) {
    rows.push(subs.slice(i, i + 2).map((c) => ({ text: c.title, callback_data: `c:${c.id}:0` })));
  }
  for (const pr of prods) rows.push(productRow(pr));

  if (pages > 1) {
    const nav: Btn[] = [];
    if (p > 0) nav.push({ text: '«', callback_data: `c:${catId}:${p - 1}` });
    nav.push({ text: `${p + 1}/${pages}`, callback_data: 'noop' });
    if (p < pages - 1) nav.push({ text: '»', callback_data: `c:${catId}:${p + 1}` });
    rows.push(nav);
  }

  const last: Btn[] = [];
  if (!catId) last.push({ text: '🔍 جستجو', callback_data: 's' });
  else last.push({ text: '⬅️ بازگشت', callback_data: `c:${cat?.parent_id ?? 0}:0` });
  last.push(MENU);
  rows.push(last);

  let text: string;
  if (!catId) text = '🗂 <b>دسته‌بندی‌ها</b>';
  else text = `📋 <b>${esc(cat?.title ?? 'دسته‌بندی')}</b>`;
  if (!subs.length && !prods.length) text += '\n\nهنوز محصولی در این بخش ثبت نشده است.';
  else if (prods.length) text += '\n\nبرای مشاهده جزئیات، یک محصول انتخاب کنید:';
  if (pages > 1) text += `\n\nصفحه ${p + 1} از ${pages}`;

  return { text, reply_markup: { inline_keyboard: rows } };
}

export async function productView(db: D1Database, tenant: Tenant, id: number): Promise<View> {
  const p = await getProduct(db, tenant.id, id);
  if (!p) {
    return {
      text: 'این محصول دیگر در دسترس نیست.',
      reply_markup: { inline_keyboard: [[{ text: '⬅️ بازگشت', callback_data: 'c:0:0' }, MENU]] },
    };
  }
  const inStock = p.avail > 0;
  let text = `📦 <b>${esc(p.title)}</b>\n`;
  if (p.description) text += `\n${esc(p.description)}\n`;
  text += `\n💵 قیمت: <b>${fmtUsd(p.price_cents)}</b> (≈ ${fmtToman(p.price_cents, tenant.usd_to_toman)})`;
  text += `\n${inStock ? '✅ موجود' : '❌ ناموجود'}`;

  const rows: Btn[][] = [];
  if (inStock) rows.push([{ text: '🛒 خرید', callback_data: `b:${p.id}` }]);
  rows.push([{ text: '⬅️ بازگشت', callback_data: `c:${p.category_id ?? 0}:0` }, MENU]);
  return { text, reply_markup: { inline_keyboard: rows } };
}

export async function topView(db: D1Database, tenantId: string): Promise<View> {
  const prods = await topProducts(db, tenantId);
  const rows = prods.map(productRow);
  rows.push([{ text: '⬅️ بازگشت', callback_data: 'c:0:0' }, MENU]);
  return {
    text: `🔥 <b>پرفروش‌ترین‌ها</b>\n\n${prods.length ? 'آنچه همه می‌خرند:' : 'هنوز محصولی ثبت نشده است.'}`,
    reply_markup: { inline_keyboard: rows },
  };
}

export async function searchView(db: D1Database, tenantId: string, q: string): Promise<View> {
  const prods = await searchProducts(db, tenantId, q);
  const rows = prods.map(productRow);
  rows.push([{ text: '🔍 جستجوی جدید', callback_data: 's' }, MENU]);
  return {
    text: prods.length ? `🔍 نتایج برای «${esc(q)}»:` : `🔍 محصولی برای «${esc(q)}» پیدا نشد.`,
    reply_markup: { inline_keyboard: rows },
  };
}

// ---- purchase flow ----
export function confirmView(tenant: Tenant, p: Product, balanceCents: number, nonce: string): View {
  const enough = balanceCents >= p.price_cents;
  let text =
    `🛒 <b>تأیید خرید</b>\n\n📦 ${esc(p.title)}\n` +
    `💵 قیمت: <b>${fmtUsd(p.price_cents)}</b> (≈ ${fmtToman(p.price_cents, tenant.usd_to_toman)})\n` +
    `💰 موجودی شما: <b>${fmtUsd(balanceCents)}</b>`;
  if (!enough) text += `\n\n❌ موجودی کافی نیست (کسری: ${fmtUsd(p.price_cents - balanceCents)}).`;

  const rows: Btn[][] = [];
  rows.push(
    enough
      ? [{ text: '✅ تأیید و پرداخت', callback_data: `y:${p.id}:${nonce}` }]
      : [{ text: '➕ افزایش موجودی', callback_data: 'w:add' }],
  );
  rows.push([{ text: '⬅️ بازگشت', callback_data: `p:${p.id}` }, MENU]);
  return { text, reply_markup: { inline_keyboard: rows } };
}

export function insufficientView(p: Product | null, balanceCents: number): View {
  const need = p ? p.price_cents - balanceCents : 0;
  return {
    text:
      `❌ <b>موجودی کیف پول کافی نیست</b>\n\n` +
      (p ? `💵 قیمت: ${fmtUsd(p.price_cents)}\n` : '') +
      `💰 موجودی شما: ${fmtUsd(balanceCents)}` +
      (need > 0 ? `\nکسری: <b>${fmtUsd(need)}</b>` : ''),
    reply_markup: {
      inline_keyboard: [
        [{ text: '➕ افزایش موجودی', callback_data: 'w:add' }],
        [{ text: '⬅️ بازگشت', callback_data: p ? `p:${p.id}` : 'c:0:0' }, MENU],
      ],
    },
  };
}

const MAX_PAYLOAD = 3000;
const payloadBlock = (payload: string) =>
  `<pre>${esc(payload.length > MAX_PAYLOAD ? payload.slice(0, MAX_PAYLOAD) + '\n…' : payload)}</pre>`;

export function successView(title: string, priceCents: number, payload: string, balanceCents: number, orderId: number): View {
  return {
    text:
      `✅ <b>خرید موفق</b> (سفارش #${orderId})\n\n📦 ${esc(title)}\n💵 ${fmtUsd(priceCents)}\n\n` +
      `🔑 اطلاعات تحویلی:\n${payloadBlock(payload)}\n💰 موجودی باقی‌مانده: ${fmtUsd(balanceCents)}`,
    reply_markup: {
      inline_keyboard: [[{ text: '📦 سفارش‌های من', callback_data: 'os:0' }, MENU]],
    },
  };
}

// ---- orders ----
export async function ordersView(db: D1Database, tenantId: string, tgId: number, page: number): Promise<View> {
  const total = await countOrders(db, tenantId, tgId);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const orders = await listOrders(db, tenantId, tgId, PAGE_SIZE, p * PAGE_SIZE);

  const rows: Btn[][] = orders.map((o) => [
    { text: `#${o.id} ${o.title} — ${fmtUsd(o.price_cents)}`, callback_data: `o:${o.id}` },
  ]);
  if (pages > 1) rows.push(pager('os', p, pages));
  rows.push([MENU]);

  return {
    text: total
      ? `📦 <b>سفارش‌های من</b>\n\nبرای مشاهده‌ی اطلاعات هر سفارش، آن را انتخاب کنید:${pages > 1 ? `\n\nصفحه ${p + 1} از ${pages}` : ''}`
      : '📦 <b>سفارش‌های من</b>\n\nهنوز سفارشی ثبت نکرده‌اید.',
    reply_markup: { inline_keyboard: rows },
  };
}

export async function orderDetailView(db: D1Database, tenantId: string, tgId: number, orderId: number): Promise<View> {
  const o = await getOrder(db, tenantId, tgId, orderId);
  const back: Btn[] = [{ text: '⬅️ بازگشت', callback_data: 'os:0' }, MENU];
  if (!o) return { text: 'سفارش پیدا نشد.', reply_markup: { inline_keyboard: [back] } };
  return {
    text:
      `📦 <b>سفارش #${o.id}</b>\n\n${esc(o.title)}\n💵 ${fmtUsd(o.price_cents)}\n🕒 ${fmtDate(o.created_at)}\n\n` +
      `🔑 اطلاعات تحویلی:\n${payloadBlock(o.delivered_payload ?? '')}`,
    reply_markup: { inline_keyboard: [back] },
  };
}

// ---- wallet top-up ----
export function depositMethodsView(s: Record<string, string>): View {
  const rows: Btn[][] = [];
  if (s.card_number) rows.push([{ text: '💳 کارت به کارت', callback_data: 'd:m:card' }]);
  if (s.usdt_trc20_address) rows.push([{ text: '🪙 تتر (USDT - TRC20)', callback_data: 'd:m:usdt' }]);
  const any = rows.length > 0;
  rows.push([MENU]);
  return {
    text: any
      ? '➕ <b>افزایش موجودی</b>\n\nروش پرداخت را انتخاب کنید:'
      : '➕ <b>افزایش موجودی</b>\n\nفعلاً روش پرداختی فعال نیست. با پشتیبانی تماس بگیرید.',
    reply_markup: { inline_keyboard: rows },
  };
}

export function depositAmountPrompt(minUsd: number): View {
  return {
    text: `💵 مبلغ شارژ را به <b>دلار</b> بفرستید (فقط عدد، مثلاً 10).\nحداقل: ${fmtUsd(Math.round(minUsd * 100))}`,
    reply_markup: { inline_keyboard: [[{ text: '❌ انصراف', callback_data: 'dx:0' }]] },
  };
}
