# Store Bot — مرحله ۱ تا ۳ + پنل مدیریت

## نصب تازه
```bash
npm install
npx wrangler d1 create store-bot          # database_id را در wrangler.toml بگذار
npm run db:init                           # schema.sql (همه‌ی جدول‌ها)
openssl rand -base64 32 | npx wrangler secret put MASTER_KEY
npx wrangler secret put ADMIN_SECRET
npm run deploy
```

## پنل مدیریت فروشنده (مینی‌اپ تلگرام)
بدون migration جدید. بعد از دیپلوی، در بات به‌عنوان مدیر (owner) دستور `/panel` را بفرست؛ دکمه‌ی «باز کردن پنل» و دکمه‌ی منوی «🛠 پنل» ساخته می‌شود.
امکانات: نمای کلی (کاربران، سفارش‌ها، فروش، موجودی کم)، محصولات (افزودن/ویرایش/غیرفعال، افزودن موجودی تحویلی)، دسته‌ها، تأیید/رد شارژها و شارژ دستی کاربر، تنظیمات (کارت، USDT، رفرال، نرخ دلار، متن‌ها).
امنیت: هر درخواست API با `initData` امضاشده‌ی تلگرام (HMAC با توکن همان بات) بررسی می‌شود و فقط `owner_tg_id` همان مستاجر دسترسی دارد.
اگر ظاهر پنل را تغییر دادی (`panel/index.html`)، این را اجرا کن تا `src/panel_html.ts` ساخته شود: `node scripts/build-panel.mjs`

## ارتقا به مرحله ۳ (پرداخت‌ها)
۱. محتوای `migrations/003_payments.sql` را یک‌بار در Console دیتابیس D1 اجرا کن.
۲. فایل‌های `src/` را جایگزین کن و commit بزن.
۳. در `wrangler.toml` مقدار cron را برای تشخیص خودکار پرداخت USDT این‌طور بگذار:
```toml
[triggers]
crons = ["*/2 * * * *"]
```
۴. (اختیاری) برای محدودیت کمتر TronGrid، یک API key رایگان از trongrid.io بگیر و با Type = Secret با نام `TRONGRID_KEY` ثبت کن.
۵. تنظیم روش‌های پرداخت (برای هر مستاجر):
```bash
curl -X POST $W/admin/tenants/$T/settings -H "Authorization: Bearer $A" -H "content-type: application/json" \
  -d '{"card_number":"6037-XXXX-XXXX-XXXX","card_holder":"نام صاحب کارت","usdt_trc20_address":"T...","min_deposit_usd":1,"referral_percent":5}'
```
هر روشی که تنظیم نشود، در بات نمایش داده نمی‌شود. `referral_percent` پیش‌فرض ۰ است (غیرفعال).

## ارتقا از مرحله ۱ به ۲
۱. محتوای `migrations/002_orders.sql` را یک‌بار در Console دیتابیس D1 اجرا کن.
۲. فایل‌های `src/` را جایگزین کن و commit بزن.
۳. (اختیاری) برای آزادسازی خودکار سفارش‌های نیمه‌تمام، این را به `wrangler.toml` اضافه کن:
```toml
[triggers]
crons = ["*/10 * * * *"]
```

## دستورات ادمین (موقت، تا پنل مرحله ۶)
```bash
W="https://<worker>.workers.dev"; A="<ADMIN_SECRET>"; T="<tenant id>"

# افزودن موجودی تحویلی (هر خط = یک آیتم)
curl -X POST $W/admin/tenants/$T/products/1/items -H "Authorization: Bearer $A" \
  -H "content-type: application/json" \
  -d '{"items":["user1@mail.com:pass1","user2@mail.com:pass2"]}'

# شارژ کیف پول کاربر (کاربر باید قبلاً /start زده باشد)
curl -X POST $W/admin/tenants/$T/users/<tg_id>/credit -H "Authorization: Bearer $A" \
  -d '{"amount_usd":10}'
```
موجودی هر محصول = تعداد آیتم‌های فروخته‌نشده‌ی آن.
