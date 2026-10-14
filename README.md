# Store Bot — مرحله ۱ (هسته چند مستاجری)

## راه‌اندازی
```bash
npm install
npx wrangler d1 create store-bot          # database_id را در wrangler.toml بگذار
npm run db:init                           # ساخت جدول‌ها
openssl rand -base64 32 | npx wrangler secret put MASTER_KEY
npx wrangler secret put ADMIN_SECRET      # یک رشته‌ی تصادفی طولانی
npm run deploy
```

## ثبت فروشگاه (مستاجر) جدید
```bash
curl -X POST https://<WORKER>.workers.dev/admin/tenants \
  -H "Authorization: Bearer <ADMIN_SECRET>" -H "content-type: application/json" \
  -d '{"bot_token":"123:ABC","owner_tg_id":111111111}'
# -> {"id":"a1b2c3d4e5f6","bot":"@MyShopBot"}
```

## افزودن دسته و محصول (موقت، تا پنل مرحله ۶)
```bash
T=a1b2c3d4e5f6
curl -X POST https://<WORKER>.workers.dev/admin/tenants/$T/categories \
  -H "Authorization: Bearer <ADMIN_SECRET>" -d '{"title":"بازی ها"}'
curl -X POST https://<WORKER>.workers.dev/admin/tenants/$T/products \
  -H "Authorization: Bearer <ADMIN_SECRET>" \
  -d '{"title":"Clash of Clans - Pile","price_usd":7.93,"category_id":1,"stock":10}'
```
