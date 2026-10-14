# Store Bot — مرحله ۱ و ۲

## نصب تازه
```bash
npm install
npx wrangler d1 create store-bot          # database_id را در wrangler.toml بگذار
npm run db:init                           # schema.sql (همه‌ی جدول‌ها)
openssl rand -base64 32 | npx wrangler secret put MASTER_KEY
npx wrangler secret put ADMIN_SECRET
npm run deploy
```

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
