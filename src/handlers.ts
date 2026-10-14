import { getUser, setState, upsertUser } from './db';
import { TgError, tg } from './telegram';
import type { Env, Tenant } from './types';
import { BTN, MAIN_KB, esc, fmtToman, fmtUsd } from './ui';
import { categoryView, mainMenuView, productView, searchView, topView, type View } from './views';

export async function handleUpdate(env: Env, tenant: Tenant, token: string, update: any): Promise<void> {
  if (update.message) return onMessage(env, tenant, token, update.message);
  if (update.callback_query) return onCallback(env, tenant, token, update.callback_query);
}

const sendView = (token: string, chatId: number, v: View) =>
  tg(token, 'sendMessage', { chat_id: chatId, text: v.text, parse_mode: 'HTML', reply_markup: v.reply_markup });

async function onMessage(env: Env, tenant: Tenant, token: string, msg: any) {
  if (!msg.from || msg.chat?.type !== 'private' || typeof msg.text !== 'string') return;
  const text: string = msg.text.trim();
  const chatId: number = msg.chat.id;
  const uid: number = msg.from.id;

  // referral payload: /start ref_<tg_id>
  let referrer: number | null = null;
  const m = text.match(/^\/start\s+ref_(\d+)$/);
  if (m) {
    const rid = Number(m[1]);
    if (rid !== uid && (await getUser(env.DB, tenant.id, rid))) referrer = rid;
  }
  const user = await upsertUser(env.DB, tenant.id, msg.from, referrer);

  const send = (t: string, markup?: unknown) =>
    tg(token, 'sendMessage', { chat_id: chatId, text: t, parse_mode: 'HTML', reply_markup: markup });

  // Menu buttons / commands always win over any pending state.
  if (text.startsWith('/start')) {
    await setState(env.DB, tenant.id, uid, null);
    await send(`${esc(tenant.welcome_text)}`, MAIN_KB);
    return sendView(token, chatId, await categoryView(env.DB, tenant.id, 0, 0));
  }
  if (text === BTN.shop) {
    await setState(env.DB, tenant.id, uid, null);
    return void (await sendView(token, chatId, await categoryView(env.DB, tenant.id, 0, 0)));
  }
  if (text === BTN.wallet) {
    await setState(env.DB, tenant.id, uid, null);
    await send(
      `💰 <b>کیف پول شما</b>\n\n💵 موجودی: <b>${fmtUsd(user.balance_cents)}</b>\n≈ ${fmtToman(user.balance_cents, tenant.usd_to_toman)}`,
      {
        inline_keyboard: [
          [{ text: '➕ افزایش موجودی', callback_data: 'w:add' }],
          [{ text: '🎁 دعوت دوستان', callback_data: 'w:inv' }],
          [{ text: '🏠 منو', callback_data: 'm' }],
        ],
      },
    );
    return;
  }
  if (text === BTN.orders) {
    await setState(env.DB, tenant.id, uid, null);
    await send('📦 <b>سفارش‌های من</b>\n\nهنوز سفارشی ثبت نکرده‌اید.', {
      inline_keyboard: [[{ text: '🏠 منو', callback_data: 'm' }]],
    });
    return;
  }
  if (text === BTN.support) {
    await setState(env.DB, tenant.id, uid, null);
    await send(`💬 <b>پشتیبانی</b>\n\n${esc(tenant.support_hours)}`, {
      inline_keyboard: [[{ text: '🏠 منو', callback_data: 'm' }]],
    });
    return;
  }
  if (text === BTN.search) {
    await setState(env.DB, tenant.id, uid, 'search');
    await send('🔍 نام محصول را بفرستید:', { inline_keyboard: [[{ text: '🏠 منو', callback_data: 'm' }]] });
    return;
  }

  if (user.state === 'search') {
    await setState(env.DB, tenant.id, uid, null);
    return void (await sendView(token, chatId, await searchView(env.DB, tenant.id, text.slice(0, 64))));
  }

  await send('از منوی پایین یکی از گزینه‌ها را انتخاب کنید 👇', MAIN_KB);
}

async function show(token: string, cq: any, v: View) {
  const chat_id = cq.message.chat.id;
  try {
    await tg(token, 'editMessageText', {
      chat_id,
      message_id: cq.message.message_id,
      text: v.text,
      parse_mode: 'HTML',
      reply_markup: v.reply_markup,
    });
  } catch (e) {
    if (e instanceof TgError && /not modified/i.test(e.message)) return;
    await sendView(token, chat_id, v);
  }
}

async function onCallback(env: Env, tenant: Tenant, token: string, cq: any) {
  const data: string = cq.data ?? '';
  const ack = (text?: string, alert = false) =>
    tg(token, 'answerCallbackQuery', { callback_query_id: cq.id, text, show_alert: alert }).catch(() => {});

  if (!cq.message) return void (await ack());

  // Actions that answer with an alert
  if (data.startsWith('b:')) return void (await ack('ثبت سفارش در مرحله بعد فعال می‌شود 🛠', true));
  if (data === 'w:add') return void (await ack('شارژ کیف پول در مرحله بعد فعال می‌شود 🛠', true));

  void ack();
  const [kind, a, b] = data.split(':');

  switch (kind) {
    case 'noop':
      return;
    case 'm':
      return show(token, cq, mainMenuView(tenant));
    case 'c':
      return show(token, cq, await categoryView(env.DB, tenant.id, Number(a) || 0, Number(b) || 0));
    case 'p':
      return show(token, cq, await productView(env.DB, tenant, Number(a)));
    case 'top':
      return show(token, cq, await topView(env.DB, tenant.id));
    case 's':
      await setState(env.DB, tenant.id, cq.from.id, 'search');
      await tg(token, 'sendMessage', {
        chat_id: cq.message.chat.id,
        text: '🔍 نام محصول را بفرستید:',
        reply_markup: { inline_keyboard: [[{ text: '🏠 منو', callback_data: 'm' }]] },
      });
      return;
    case 'w': {
      if (a !== 'inv') return;
      const link = `https://t.me/${tenant.bot_username}?start=ref_${cq.from.id}`;
      await tg(token, 'sendMessage', {
        chat_id: cq.message.chat.id,
        text: `🎁 <b>دعوت دوستان</b>\n\nلینک اختصاصی شما:\n${link}`,
        parse_mode: 'HTML',
      });
      return;
    }
  }
}
