export const BTN = {
  shop: '🛍 فروشگاه',
  wallet: '💰 کیف پول',
  orders: '📦 سفارش‌های من',
  support: '💬 پشتیبانی',
  search: '🔍 جستجو',
} as const;

export const MAIN_KB = {
  keyboard: [
    [{ text: BTN.shop }, { text: BTN.wallet }],
    [{ text: BTN.orders }, { text: BTN.support }],
    [{ text: BTN.search }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const fmtUsd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export const fmtToman = (cents: number, rate: number) =>
  `${Math.round((cents / 100) * rate).toLocaleString('en-US')} تومان`;

export const fmtDate = (unixSeconds: number) =>
  new Date(unixSeconds * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
