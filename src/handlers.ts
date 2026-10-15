import { randomHex } from './crypto';
import { getProduct, getUser, setState, upsertUser } from './db';
import {
  createCardDeposit,
  createUsdtDeposit,
  creditDeposit,
  getDeposit,
  getSettings,
  notifyPaid,
  parseAmount,
  pollUsdt,
} from './payments';
import { purchase } from './purchase';
import { TgError, tg } from './telegram';
import type { Env, Tenant, User } from './types';
import { BTN, MAIN_KB, esc, fmtToman, fmtUsd } from './ui';
import {
  categoryView,
  confirmView,
  depositAmountPrompt,
  depositMethodsView,
  insufficientView,
  mainMenuView,
  orderDetailView,
  ordersView,
  productView,
  searchView,
  successView,
  topView,
  type View,
} from './views';

export async function handleUpdate(env: Env, tenant: Tenant, token: string, update: any, origin: string): Promise<void> {
  if (update.message) return onMessage(env, tenant, token, update.message, origin);
  if (update.callback_query) return onCallback(env, tenant, token, update.callback_query);
}

const say = (token: string, chatId: number, text: string, markup?: unknown) =>
  tg(token, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', reply_markup: markup });

const sendView = (token: string, chatId: number, v: View) => say(token, chatId, v.text, v.reply_markup);

const MENU_ROW = [{ text: '🏠 منو', callback_data: 'm' }];

async function onMessage(env: Env, tenant: Tenant, token: string, msg: any, origin: string) {
  if (!msg.from || msg.chat?.type !== 'private') return;
  const text: string = typeof msg.text === 'string' ? msg.text.trim() : '';
  const hasPhoto = Array.isArray(msg.photo) && msg.photo.length > 0;
  if (!text && !hasPhoto) return;
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
  const send = (t: string, markup?: unknown) => say(token, chatId, t, markup);

  // Owner-only: open the management mini app
  if (text === '/panel') {
    if (uid !== tenant.owner_tg_id) return void (await send('این دستور فقط برای مدیر فروشگاه است.'));
    const url = `${origin}/app/${tenant.id}`;
    await tg(token, 'setChatMenuButton', { chat_id: uid, menu_button: { type: 'web_app', text: '🛠 پنل', web_app: { url } } }).catch(() => {});
    return void (await send('🛠 <b>پنل مدیریت فروشگاه</b>', { inline_keyboard: [[{ text: 'باز کردن پنل', web_app: { url } }]] }));
  }

  // Menu buttons / commands always win over any pending state.
  if (text.startsWith('/start')) {
    await setState(env.DB, tenant.id, uid, null);
    await send(`${esc(tenant.welcome_text)}`, MAIN_KB);
    return void (await sendView(token, chatId, await categoryView(env.DB, tenant.id, 0, 0)));
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
          MENU_ROW,
        ],
      },
    );
    return;
  }
  if (text === BTN.orders) {
    await setState(env.DB, tenant.id, uid, null);
    return void (await sendView(token, chatId, await ordersView(env.DB, tenant.id, uid, 0)));
  }
  if (text === BTN.support) {
    await setState(env.DB, tenant.id, uid, null);
    await send(`💬 <b>پشتیبانی</b>\n\n${esc(tenant.support_hours)}`, { inline_keyboard: [MENU_ROW] });
    return;
  }
  if (text === BTN.search) {
    await setState(env.DB, tenant.id, uid, 'search');
    await send('🔍 نام محصول را بفرستید:', { inline_keyboard: [MENU_ROW] });
    return;
  }

  // ---- pending states ----
  const st = user.state ?? '';
  if (st === 'search' && text) {
    await setState(env.DB, tenant.id, uid, null);
    return void (await sendView(token, chatId, await searchView(env.DB, tenant.id, text.slice(0, 64))));
  }
  if (st.startsWith('dep:') && text) return depositAmount(env, tenant, token, chatId, user, st.slice(4), text);
  if (st.startsWith('dep_receipt:')) return depositReceipt(env, tenant, token, msg, user, Number(st.split(':')[1]), text);

  if (!text) return;
  await send('از منوی پایین یکی از گزینه‌ها را انتخاب کنید 👇', MAIN_KB);
}

// ---- wallet top-up: amount step ----
async function depositAmount(env: Env, tenant: Tenant, token: string, chatId: number, user: User, method: string, text: string) {
  const s = await getSettings(env.DB, tenant.id);
  const minUsd = Number(s.min_deposit_usd ?? 1) || 1;
  const usd = parseAmount(text);
  if (usd === null || usd < minUsd || usd > 1000) {
    return void (await sendView(token, chatId, depositAmountPrompt(minUsd)));
  }
  const cents = Math.round(usd * 100);

  if (method === 'card' && s.card_number) {
    const toman = Math.ceil((usd * tenant.usd_to_toman) / 1000) * 1000;
    const id = await createCardDeposit(env.DB, tenant.id, user.tg_id, cents, toman);
    await setState(env.DB, tenant.id, user.tg_id, `dep_receipt:${id}`);
    await say(
      token,
      chatId,
      `💳 <b>کارت به کارت</b>\n\n💵 مبلغ شارژ: <b>${fmtUsd(cents)}</b>\n💰 مبلغ قابل پرداخت: <b>${toman.toLocaleString('en-US')} تومان</b>\n\n` +
        `شماره کارت:\n<code>${esc(s.card_number)}</code>\n` +
        (s.card_holder ? `به نام: ${esc(s.card_holder)}\n` : '') +
        `\nپس از واریز، <b>عکس رسید</b> یا کد پیگیری را همین‌جا بفرستید.`,
      { inline_keyboard: [[{ text: '❌ انصراف', callback_data: `dx:${id}` }]] },
    );
    return;
  }

  if (method === 'usdt' && s.usdt_trc20_address) {
    const { id, micro } = await createUsdtDeposit(env.DB, tenant.id, user.tg_id, cents);
    await setState(env.DB, tenant.id, user.tg_id, null);
    await say(
      token,
      chatId,
      `🪙 <b>پرداخت با USDT (شبکه TRC20)</b>\n\n💵 مبلغ شارژ: <b>${fmtUsd(cents)}</b>\n\n` +
        `دقیقاً این مقدار را واریز کنید:\n<code>${(micro / 1e6).toFixed(6)}</code> USDT\n\n` +
        `آدرس کیف پول:\n<code>${esc(s.usdt_trc20_address)}</code>\n\n` +
        `⚠️ فقط شبکه‌ی TRC20. مقدار باید دقیقاً همین عدد باشد تا خودکار شناسایی شود.\n⏳ مهلت: ۶۰ دقیقه`,
      {
        inline_keyboard: [
          [{ text: '🔄 بررسی پرداخت', callback_data: `dc:${id}` }],
          [{ text: '❌ انصراف', callback_data: `dx:${id}` }],
        ],
      },
    );
    return;
  }

  await setState(env.DB, tenant.id, user.tg_id, null);
  await say(token, chatId, 'این روش پرداخت فعال نیست.', { inline_keyboard: [MENU_ROW] });
}

// ---- wallet top-up: card receipt step ----
async function depositReceipt(env: Env, tenant: Tenant, token: string, msg: any, user: User, id: number, text: string) {
  const chatId: number = msg.chat.id;
  const dep = await getDeposit(env.DB, tenant.id, id, user.tg_id);
  if (!dep || dep.method !== 'card' || dep.status !== 'awaiting') {
    await setState(env.DB, tenant.id, user.tg_id, null);
    return void (await say(token, chatId, 'این درخواست دیگر فعال نیست.', { inline_keyboard: [MENU_ROW] }));
  }
  const hasPhoto = Array.isArray(msg.photo) && msg.photo.length > 0;
  const receipt: string = hasPhoto ? msg.photo[msg.photo.length - 1].file_id : text.slice(0, 200);

  const upd = await env.DB
    .prepare(`UPDATE deposits SET status = 'pending_review', receipt = ? WHERE id = ? AND tenant_id = ? AND status = 'awaiting'`)
    .bind(receipt, id, tenant.id)
    .run();
  if (!upd.meta.changes) return;
  await setState(env.DB, tenant.id, user.tg_id, null);
  await say(token, chatId, '✅ رسید دریافت شد. بعد از بررسی، کیف پول شما شارژ می‌شود.', { inline_keyboard: [MENU_ROW] });

  const who = `${user.first_name ? esc(user.first_name) : ''}${user.username ? ` @${esc(user.username)}` : ''} (${user.tg_id})`;
  const caption =
    `💳 <b>درخواست شارژ #${id}</b>\n👤 ${who}\n💵 ${fmtUsd(dep.amount_cents)} ≈ ${dep.pay_amount.toLocaleString('en-US')} تومان` +
    (hasPhoto ? '' : `\n\nرسید: ${esc(receipt)}`);
  const markup = {
    inline_keyboard: [
      [
        { text: '✅ تأیید', callback_data: `da:${id}` },
        { text: '❌ رد', callback_data: `dr:${id}` },
      ],
    ],
  };
  await (hasPhoto
    ? tg(token, 'sendPhoto', { chat_id: tenant.owner_tg_id, photo: receipt, caption, parse_mode: 'HTML', reply_markup: markup })
    : tg(token, 'sendMessage', { chat_id: tenant.owner_tg_id, text: caption, parse_mode: 'HTML', reply_markup: markup })
  ).catch((e) => console.error('owner notify failed', e));
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
  const uid: number = cq.from.id;
  const [kind, a, b] = data.split(':');

  // --- owner: approve / reject card receipts ---
  if (kind === 'da' || kind === 'dr') {
    if (uid !== tenant.owner_tg_id) return void (await ack('دسترسی ندارید', true));
    const id = Number(a);
    const dep = await getDeposit(env.DB, tenant.id, id);
    if (!dep) return void (await ack('پیدا نشد', true));
    const done = (label: string) =>
      tg(token, 'editMessageReplyMarkup', {
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
        reply_markup: { inline_keyboard: [[{ text: label, callback_data: 'noop' }]] },
      }).catch(() => {});

    if (kind === 'da') {
      const s = await getSettings(env.DB, tenant.id);
      const ok = await creditDeposit(env.DB, tenant.id, id, null, Number(s.referral_percent ?? 0) || 0);
      if (!ok) return void (await ack('این درخواست قبلاً بررسی شده', true));
      await ack('✅ تأیید شد');
      await done('✅ تأیید شد');
      await notifyPaid(env, tenant, id);
    } else {
      const r = await env.DB
        .prepare(`UPDATE deposits SET status = 'rejected' WHERE id = ? AND tenant_id = ? AND status = 'pending_review'`)
        .bind(id, tenant.id)
        .run();
      if (!r.meta.changes) return void (await ack('این درخواست قبلاً بررسی شده', true));
      await ack('رد شد');
      await done('❌ رد شد');
      await say(token, dep.user_id, `❌ درخواست شارژ ${fmtUsd(dep.amount_cents)} تأیید نشد. در صورت نیاز با پشتیبانی تماس بگیرید.`).catch(() => {});
    }
    return;
  }

  // --- user: check USDT payment now ---
  if (kind === 'dc') {
    const id = Number(a);
    const dep = await getDeposit(env.DB, tenant.id, id, uid);
    if (!dep) return void (await ack());
    if (dep.status === 'paid') return void (await ack('✅ قبلاً تأیید شده'));
    if (dep.status === 'awaiting') {
      await pollUsdt(env, { depositId: id });
      const d2 = await getDeposit(env.DB, tenant.id, id, uid);
      if (d2?.status === 'paid') return void (await ack('✅ پرداخت تأیید شد'));
    }
    return void (await ack('هنوز پرداختی دریافت نشد. چند دقیقه بعد دوباره بررسی کنید.', true));
  }

  // --- buy: confirmation screen ---
  if (kind === 'b') {
    const [p, u] = await Promise.all([getProduct(env.DB, tenant.id, Number(a)), getUser(env.DB, tenant.id, uid)]);
    if (!p || p.avail <= 0) {
      await ack('این محصول ناموجود است', true);
      return show(token, cq, await productView(env.DB, tenant, Number(a)));
    }
    void ack();
    return show(token, cq, confirmView(tenant, p, u?.balance_cents ?? 0, randomHex(4)));
  }

  // --- buy: execute ---
  if (kind === 'y') {
    if (!b || !/^[0-9a-f]{8}$/.test(b)) return void (await ack());
    const res = await purchase(env.DB, tenant.id, uid, Number(a), b);
    if (res.ok) {
      void ack();
      return show(token, cq, successView(res.title, res.priceCents, res.payload, res.balanceCents, res.orderId));
    }
    switch (res.reason) {
      case 'duplicate':
        return void (await ack('در حال پردازش…'));
      case 'insufficient': {
        void ack();
        const p = await getProduct(env.DB, tenant.id, Number(a));
        return show(token, cq, insufficientView(p, res.balanceCents ?? 0));
      }
      default:
        await ack('این محصول ناموجود است', true);
        return show(token, cq, await productView(env.DB, tenant, Number(a)));
    }
  }

  void ack();
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
    case 'os':
      return show(token, cq, await ordersView(env.DB, tenant.id, uid, Number(a) || 0));
    case 'o':
      return show(token, cq, await orderDetailView(env.DB, tenant.id, uid, Number(a)));
    case 's':
      await setState(env.DB, tenant.id, uid, 'search');
      await say(token, cq.message.chat.id, '🔍 نام محصول را بفرستید:', { inline_keyboard: [MENU_ROW] });
      return;
    case 'd': {
      // d:m:<method>  -> ask for the amount
      if (a !== 'm' || (b !== 'card' && b !== 'usdt')) return;
      const s = await getSettings(env.DB, tenant.id);
      const enabled = b === 'card' ? !!s.card_number : !!s.usdt_trc20_address;
      if (!enabled) return show(token, cq, depositMethodsView(s));
      await setState(env.DB, tenant.id, uid, `dep:${b}`);
      return show(token, cq, depositAmountPrompt(Number(s.min_deposit_usd ?? 1) || 1));
    }
    case 'dx': {
      await env.DB
        .prepare(`UPDATE deposits SET status = 'expired' WHERE id = ? AND tenant_id = ? AND user_id = ? AND status = 'awaiting'`)
        .bind(Number(a) || 0, tenant.id, uid)
        .run();
      await setState(env.DB, tenant.id, uid, null);
      return show(token, cq, mainMenuView(tenant));
    }
    case 'w': {
      if (a === 'add') return show(token, cq, depositMethodsView(await getSettings(env.DB, tenant.id)));
      if (a !== 'inv') return;
      const s = await getSettings(env.DB, tenant.id);
      const pct = Number(s.referral_percent ?? 0) || 0;
      const link = `https://t.me/${tenant.bot_username}?start=ref_${uid}`;
      await say(
        token,
        cq.message.chat.id,
        `🎁 <b>دعوت دوستان</b>\n\nلینک اختصاصی شما:\n${link}` +
          (pct > 0 ? `\n\nبا اولین شارژ هر دوستی که با لینک شما وارد شود، ${pct}٪ مبلغ شارژ او به کیف پول شما اضافه می‌شود.` : ''),
      );
      return;
    }
  }
}
