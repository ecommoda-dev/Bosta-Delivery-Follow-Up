<div dir="rtl" style="text-align: right;">

# متابعة التأجيلات — `Bosta-Delivery-Follow-Up` (Worker)

**بتعمل إيه:** قايمة يومية بشحنات بوسطة اللي العميل طلب **تأجيلها** (`exception_code = 3`) ولسه ما اتقفلتش.
موظف متابعة الشحن بيبعت لكل عميل رسالة واتساب **يدوي من رقمه هو**، والأداة بتسجّل النتيجة بس.
**الإصدار:** `2.0.0` (`WORKER_VERSION`)

> 🔴 **الريبو ده Worker وبس.** الواجهة `Bosta-Delivery-Follow-Up.html` عايشة في ريبو الهب
> `Delivery-COD-Operations-Center` (نفس نمط `Courier-Names` / `Partial-Delivery`). أي تعديل على الشاشة بيتعمل هناك.
> ⛔ **مفيش إرسال واتساب من الـ Worker** — لا API ولا Cloud API. الرسالة بتتفتح بزرار `api.whatsapp.com` في الواجهة.

> 🔴 **v2.0.0 (15-10-2026) — بيلغي أي وصف تحت لحالات المتابعة/النتايج/`eventId`/`days`:** القايمة = كل شحنة تحت التوصيل (آخر حدث مش 45/46/48 ولا RTO) وأعلى `number_of_attempts` ≥ 1، نشاط آخر `WINDOW_DAYS = 60` يوم (`openListCTE()`). الأداة **إرسال بس**: `record` = `{employee, items:[{trackingNumber}], message}` → صف في `bosta_followup_sends` (الجدول القديم `bosta_delivery_followups` متساب ومابيتقراش). `get_sends?trackingNumber=` للتفاصيل. `queue_summary` = `{total, unsent, sent}`. نص الرسالة بيتخزّن باسم مستبدل بـ`{name}` وأرقام الموبايل بتتشال (`sanitizeMessage`). ضغطة مزدوجة (نفس الموظف ١٥ ث) = `deduped`. `log type`: `wa_opened` بس. اتفحص على SQLite حقيقي (٤٨ بند) + شوبيفاي وهمية؛ ما اتجرّبش على D1 الحقيقي.

## الروابط

```
الـ Worker : https://bosta-delivery-follow-up-worker.ecommoda-dev.workers.dev
tool في D1 : bosta_delivery_follow_up   ← wa_opened · followup_result · followup_reopen
السر       : مجموعة delivery_cod_ops (الـ Worker العاشر)
```

## الـ Endpoints

| `?action=` | النوع | بيعمل إيه |
|---|---|---|
| `get_config` | GET | `{ version }` لحارس النسخة |
| `diag` | GET | الأسرار (أسماء/أطوال/بصمة) · D1 · **قراءة تجريبية من `bosta_webhook_events`** · OAuth · `read_orders` · **بيانات العميل راجعة ولا `null`** · `throttleStatus` و`actualQueryCost` |
| `get_followups&days=N` | GET | القايمة + بيانات شوبيفاي + حالة المتابعة (افتراضي 3 أيام، أقصى 14) |
| `queue_summary&days=N` | GET | عدّادات الرئيسية بـ SQL مجمّع **بلا شوبيفاي** |
| `record` | POST | `{ employee, action: opened\|result\|reopen, trackingNumber, eventId \| items[], result?, note? }` |
| `get_logs` · `get_logs_count` · `get_logs_export` | GET | من §SHARED |

بلا endpoints دخول — الدخول من Worker الهب والموظف بيتبعت `employee` من الجلسة.

## 🔴 تعريف القايمة — مكانه `openListCTE()` في `index.js` بس

شحنة **فيها حدث `state=47 AND exception_code='3'` في آخر N أيام**، و**مفيش** عليها `state IN (45,46,48)` ولا `bosta_type='RTO'` في أي وقت.

- 🔴 **مش «آخر حالة = 47/3»** — بعد التأجيل الشحنة بتتحرك (24 · 20 · 41)؛ ده رجّع شحنة واحدة بس من 25 يوم (15-10-2026).
- الوحدة = **(رقم تتبع × حدث تأجيل)** — `event_id` = `bosta_webhook_events.id` لآخر تأجيل. تأجيل جديد = صف متابعة جديد.
- `queue_summary` و`get_followups` و`record` (تحقق) بيبنوا من **نفس** الـ CTE — مفيش تعريف تاني. ⛔ ماتكررش التعريف في الواجهة ولا في الـ shell.
- `postponeCount` = عدد التأجيلات **جوّه النافذة** مش الكلي.
- صف مالوش متابعة = `pending` **بالـ LEFT JOIN وقت القراءة** (مفيش INSERT عند العرض)؛ الصف بيتعمل عند أول `record`.

## جدول الأداة `bosta_delivery_followups`

بيتعمل لوحده (`CREATE TABLE IF NOT EXISTS` عند أول نداء) — أو سطر واحد في D1 Console (`SCHEMA_SQL` في `index.js`).

- `status`: `pending` · `sent` · `replied` · `closed` · `skipped`
- `result`: `ok` · `other_day` · `not_requested` · `cancel` · `other` · `no_reply` · `no_wa` · `skip`
  - `ok`/`skip`/`no_wa` → `closed` · الباقي → `replied`. «محتاجين تصرّف» = `replied` (أي نتيجة غير الثلاثة المقفولة).
- `UNIQUE(tracking_number, event_id)` + `INSERT OR IGNORE` → **ضغطتين على «فتح واتساب» = صف واحد**، و`opened` مابترجّعش حالة متقدمة للخلف.
- 🔴 **ممنوع تخزين اسم/تليفون/عنوان** — هنا ولا في `logs` (قانون حماية البيانات، مهلة التوفيق ~31-10/1-11-2026). `sent_to` **مش موجود** عمدًا.

## قواعد

1. ⛔ **`bosta_webhook_events` قراءة بس** — لا كتابة ولا schema ولا فهرس. جدول أداة تانية (`Bosta-Webhook-Status-Receiver`)؛ أي عمود يتغيّر هناك بيوقع القايمة هنا. الأعمدة المعتمدة: `id` · `tracking_number` · `state` · `exception_code` · `bosta_timestamp` · `received_at` · `description` · `business_reference` · `matched_slot` · `bosta_type` · `delivery_promise_date` · `number_of_attempts` · `shopify_order_id`. ⛔ ممنوع `SELECT *` عليه (فيه `raw_payload`).
2. **«علّم متشيلش»:** أوردر ملغي على شوبيفاي (`cancelled`) · مالوش `shopify_order_id` · مفيش موبايل صالح → بيتعرض بعلامة مش بيختفي.
3. **فشل شوبيفاي مايسقّطش القايمة:** الرد فيه `shopifyError` والصفوف بتتعرض بدون بيانات عميل — والواجهة بتحذّر. (الفشل الصامت ممنوع.)
4. **`record` — العقد:** `items[]` اختياري (مجموعة نفس التليفون)، والرد `results[]` **نتيجة لكل عنصر بنفس الترتيب**. الرد **HTTP 200 دايمًا** لو الطلب نفسه سليم (400 بس لـ body باظ) — والفشل جوّه `results[i]` (`ok:false` + `status`)؛ شحنة اتقفلت أو جالها تأجيل أحدث = `status:409` «حدّث القايمة». ⛔ مش 4xx على الرد كله: `dcoApi` بيرميه «HTTP 409» ويضيّع نتايج العناصر اللي نجحت. فشل `writeLog` بعد الكتابة = `logged:false` مش 500.
5. `deliveryPromiseDate` بيرجع **خام `DD-MM-YYYY`** — الواجهة بتحوّله يدوي (`new Date()` عليه ممنوع) ومابتذكرهوش لو فات.
6. `ITEMS_PER_QUERY = 25` **غير مقيس** — اشتقّه من `actualQueryCost` في `diag` بعد أول قياس حي.
7. CORS Option B (الرد فيه أسماء وتليفونات).

## الفحص

```bash
node check-log-values.mjs     # exit 0 قبل التسليم
```
اختبار السلوك اتعمل على SQLite حقيقي + شوبيفاي وهمية: التعريف (تسليم/مرتجع/RTO بيطلعوا بره، تأجيلين = شحنة واحدة، خارج النافذة، كود تاني) · idempotency · 409 · لا بيانات عميل في `logs`.
⚠️ **ما اتجرّبش على D1 ولا شوبيفاي الحقيقيين.**

## قبل ما الأداة تشتغل (خطوات يدوية — خارج الكود)

1. إنشاء Worker `bosta-delivery-follow-up-worker` من الريبو (Workers Builds · `main`) + `Build watch paths` = `index.js` و`wrangler.toml` (**chip لكل واحد**).
2. الأسرار: `WORKER_SECRET` = **قيمة مجموعة `delivery_cod_ops`** · `CLIENT_ID` · `CLIENT_SECRET` → **Promote**.
3. الـ Custom App محتاج **Protected customer data** (اسم/تليفون) — `?action=diag` بيقول.
4. 🔴 **Rule 7:** تسجيل `tool = bosta_delivery_follow_up` و`type` ∈ (`wa_opened` · `followup_result` · `followup_reopen`) في `ecommoda-constants` §7 **قبل أول `writeLog`** (يعني قبل أول استخدام حقيقي).
5. تسجيل العضوية في `secret-groups.md` (المجموعة بقت 10 Workers).

## بصمة المهارات

| المهارة | الإصدار |
|---|---|
| ecommoda-worker-builder | **v3.9.2** |

> `ecommoda-constants` ما اتراجعتش في التمريرة دي — لو اتكتب الـ `tool`/`type` غلط في §7 هتبان في `log_value_alerts`.

آخر تحديث: 15-10-2026 — v1.0.1 (`getAccessToken`: تنضيف `CLIENT_ID`/`CLIENT_SECRET`/`SHOP_DOMAIN` من المسافات + رسالة فشل OAuth فيها سبب شوبيفاي بدل «400» وبس — اتكشف من أول `diag` حقيقي) · v1.0.0 (الإصدار الأول)

</div>
