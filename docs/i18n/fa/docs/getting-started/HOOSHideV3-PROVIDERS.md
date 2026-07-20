# ارائه‌دهنده‌های اضافه‌شده توسط فورک hooshidev3

این مستند، چهار provider جدیدی را که توسط فورک hooshidev3 به OmniRoute اضافه شده‌اند، توضیح می‌دهد. تمام این provider ها در branch `feature/merge-v3.8.49` ادغام شده‌اند.

## فهرست ارائه‌دهنده‌ها

| Provider         | نوع                 | احراز هویت                   | Tool Calling                   | Thinking              |
| ---------------- | ------------------- | ---------------------------- | ------------------------------ | --------------------- |
| `zai-web-free`   | Web (Captcha)       | Guest JWT + Aliyun CaptchaV3 | ❌ (پشتیبانی نمی‌شود)          | ✅ (glm-4.7)          |
| `zai-web-token`  | Web (Captcha + JWT) | User-supplied Z.AI JWT       | ❌ (پشتیبانی نمی‌شود)          | ✅ (تمام مدل‌های GLM) |
| `xiaomimimo-web` | Web (Cookie)        | Three browser cookies        | ❌ (حذف شد — پشتیبانی نمی‌شود) | ✅ (mimo-v2.5-pro)    |
| `kilo-free`      | API (OpenRouter)    | بدون احراز هویت              | ✅ (از طریق DefaultExecutor)   | بستگی به مدل دارد     |

## 1. zai-web-free — Z.AI Web Free (Captcha-based)

### نحوه کار

- **Endpoint**: `https://chat.z.ai/api/v2/chat/completions`
- **احراز هویت**:
  1. Guest JWT از `/api/v1/auths/guest` دریافت می‌شود
  2. userId از JWT decode می‌شود
  3. captcha_verify_param از Aliyun CaptchaV3 تولید می‌شود (نصف device token مصرف می‌کند)
  4. HMAC-SHA256 روی prompt محاسبه شده در هدر `X-Signature` ارسال می‌شود
- **مدل پیش‌فرض**: `glm-4.7` (تنها مدل در دسترس برای Guest JWT)
- **Context length**: ۱۳۱,۰۷۲ توکن

### تنظیم Captcha

Aliyun AccessKey و SecretKey از سه منبع خوانده می‌شوند (با اولویت نزولی):

1. **Environment variables**: `OMNIROUTE_ZAI_ALIYUN_ACCESS_KEY` و `OMNIROUTE_ZAI_ALIYUN_SECRET_KEY`
2. **Dashboard**: پنل "Aliyun Captcha Keys" در تنظیمات provider
3. **Default values**: مقادیر عمومی که در AliyunCaptcha.js سرو شده‌اند (ship به‌صورت پیش‌فرض)

### استراتژی‌های Captcha

| استراتژی                       | توضیح                              | زمان اجرا | قابلیت اطمینان |
| ------------------------------ | ---------------------------------- | --------- | -------------- |
| `auto` (پیش‌فرض در Go)         | A → B → C با fallback chain        | متوسط     | بالا           |
| `a_only` (پیش‌فرض در این فورک) | فقط A (retries) — سریع‌ترین        | کم        | متوسط          |
| `b_only`                       | فقط B (fresh token via Playwright) | متوسط     | بالا           |
| `c_only`                       | فقط C (full browser captcha)       | زیاد      | بسیار بالا     |
| `a_then_c`                     | A → C (skip B)                     | متوسط     | بالا           |
| `a_then_b`                     | A → B (no browser fallback)        | کم        | متوسط          |

### Device Token Pool

- Device tokens توسط Playwright از chat.z.ai جمع‌آوری می‌شوند
- TTL: ~۲۵ دقیقه
- استراتژی consume: `DELETE...ORDER BY id LIMIT 1 RETURNING token` (atomic، جلوگیری از race condition)
- Auto-refresh daemon هر ۵ دقیقه tokens جدید اضافه می‌کند

### فعال/غیرفعال کردن

```bash
# غیرفعال کردن (عرضه 503 با پیام توضیحی)
OMNIROUTE_ZAI_WEB_FREE_DISABLED=1

# یا
OMNIROUTE_ZAI_WEB_FREE_ENABLED=0
```

## 2. zai-web-token — Z.AI Web Token (Personal JWT)

مشابه `zai-web-free` ولی به‌جای Guest JWT، از JWT شخصی کاربر استفاده می‌کند:

- **مدل‌های در دسترس**: `glm-5.2`, `GLM-5.1`, `GLM-5-Turbo`, `GLM-5v-Turbo` (Vision), `glm-4.7`
- **نحوه دریافت JWT**:
  1. به [chat.z.ai](https://chat.z.ai) لاگین کنید
  2. DevTools → Application → Local Storage → key `token`
  3. مقدار JWT را در فیلد credential paste کنید

> **نکته**: JWT شخصی قابل auto-refresh نیست. وقتی منقضی شود، باید دوباره از chat.z.ai کپی کنید.

## 3. xiaomimimo-web — Xiaomi MiMo AI Studio

- **Endpoint**: `https://aistudio.xiaomimimo.com/open-apis/bot/chat`
- **احراز هویت**: سه cookie از `aistudio.xiaomimimo.com`:
  - `serviceToken`
  - `userId`
  - `xiaomichatbot_ph` (به‌عنوان cookie و query param ارسال می‌شود)
- **مدل‌ها**:
  - `mimo-v2.5-pro` (۱M context, thinking)
  - `mimo-v2.5` (۱M context, vision)
  - `mimo-v2-flash` (۲۵۶K context)
- **Tool Calling**: ❌ (پشتیبانی نمی‌شود — endpoint وب آن را قبول نمی‌کند)
- **Multi-turn memory**: از طریق `providerSessionRegistry` پیاده‌سازی شده

### نحوه دریافت cookies

1. به [aistudio.xiaomimimo.com](https://aistudio.xiaomimimo.com) لاگین کنید
2. DevTools → Application → Cookies → `aistudio.xiaomimimo.com`
3. هر سه cookie را به‌صورت `name=value; name=value; name=value` در فیلد credential paste کنید

## 4. kilo-free — Kilo Free (OpenRouter)

ساده‌ترین provider جدید:

- **Endpoint**: `https://api.kilo.ai/api/openrouter/chat/completions`
- **احراز هویت**: بدون (anonymous API key: `Authorization: Bearer anonymous`)
- **Tool Calling**: ✅ (توسط OpenRouter pass-through)
- **مدل پیش‌فرض**: `kilo-auto/free` (auto-routing به بهترین backend free)
- **Live model discovery**: از `/api/openrouter/models` (model های free با پسوند `:free`)

### مدل‌های free curated

| Model ID                                             | توضیح                              |
| ---------------------------------------------------- | ---------------------------------- |
| `kilo-auto/free`                                     | Auto-routing (virtual)             |
| `tencent/hy3:free`                                   | Tencent HY3                        |
| `stepfun/step-3.7-flash:free`                        | StepFun Step 3.7 Flash             |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | NVIDIA Nemotron 3 Nano (Reasoning) |
| `nvidia/nemotron-3-super-120b-a12b:free`             | NVIDIA Nemotron 3 Super 120B       |
| `nvidia/nemotron-3-ultra-550b-a55b:free`             | NVIDIA Nemotron 3 Ultra 550B       |
| `nvidia/nemotron-3.5-content-safety:free`            | NVIDIA Nemotron 3.5 Content Safety |
| `cohere/north-mini-code:free`                        | Cohere North Mini Code             |
| `kwaipilot/kat-coder-pro-v2.5:free`                  | Kwai Pilot Kat Coder Pro v2.5      |
| `poolside/laguna-m.1:free`                           | Poolside Laguna M.1                |
| `poolside/laguna-xs-2.1:free`                        | Poolside Laguna XS 2.1             |

> **نکته**: لیست کامل مدل‌های free به‌صورت live از `/models` استخراج می‌شود. لیست بالا صرفاً نمونه‌ی نمایشی است.

## عیب‌یابی

### zai-web-free: "captcha generation timeout after 90s"

- استراتژی را به `b_only` یا `c_only` تغییر دهید
- بررسی کنید که device token pool خالی نباشد (داشبورد → Refresh Device Tokens)
- Aliyun AccessKey/SecretKey را بررسی کنید

### zai-web-token: "401 Unauthorized"

- JWT شخصی منقضی شده. دوباره از chat.z.ai کپی کنید
- مطمئن شوید که فقط مقدار JWT را paste کرده‌اید (نه `token=` prefix)

### xiaomimimo-web: "401 cookies may have expired"

- Cookies را دوباره از aistudio.xiaomimimo.com کپی کنید
- مطمئن شوید که هر سه cookie را شامل می‌شود

### kilo-free: "404 model not found"

- از مدل `kilo-auto/free` استفاده کنید (auto-routing)
- یا یک مدل `:free` معتبر از لیست بالا انتخاب کنید

## مشارکت

برای گزارش باگ یا درخواست feature جدید، از [GitHub Issues](https://github.com/hooshidev3/OmniRoute/issues) استفاده کنید.
