import { countProducts, getCategory, getProduct, listCategories, listProducts, searchProducts, topProducts } from './db';
import type { Product, Tenant } from './types';
import { esc, fmtToman, fmtUsd } from './ui';

type Btn = { text: string; callback_data: string } | { text: string; url: string };
export interface View {
  text: string;
  reply_markup: { inline_keyboard: Btn[][] };
}

export const PAGE_SIZE = 8;
const MENU: Btn = { text: '🏠 منو', callback_data: 'm' };

const productRow = (p: Product): Btn[] => [
  {
    text: `${p.title} — ${fmtUsd(p.price_cents)}${p.stock === 0 ? ' ❌' : ''}`,
    callback_data: `p:${p.id}`,
  },
];

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
  const inStock = p.stock === null || p.stock > 0;
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
