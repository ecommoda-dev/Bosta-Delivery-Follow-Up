// ══════════════════════════════════════════════════════════════
// §HEADER
// Worker: bosta-delivery-follow-up-worker — EcomModa
// Tool:   متابعة التأجيلات — شحنات بوسطة تحت التوصيل وعليها محاولة توصيل أو أكتر، وإرسال واتساب يدوي
//
// skills: worker-builder v3.9.2 — 15-10-2026
//
// 🔴 **بيقرا من `bosta_webhook_events` (جدول `bosta-webhook-status-receiver-worker`)
//    ومايكتبش فيه ولا حرف ولا فهرس.** الجدول ده تبع أداة تانية، وأي
//    تغيير في شكله بيوقع القايمة هنا — `?action=diag` بيعمل قراءة تجريبية
//    عشان التغيير يبان قبل الموظف.
// 🔴 **بيكتب في جدول واحد خاص بيه: `bosta_followup_sends`** (سجل كل مرة اتفتح فيها واتساب
//    لشحنة: مين · امتى · نص الرسالة). v2.0.0: الأداة **بقت إرسال بس** — اتشالت حالات المتابعة
//    (محتاجين رد/تصرّف/خلصت) ونتايج الرد. جدول `bosta_delivery_followups` القديم **متساب
//    زي ما هو ومابيتقراش** (لا حذف ولا ترحيل — مفيش بيانات فيه لازمة).
//    ⛔ **ممنوع تخزين اسم أو تليفون أو عنوان عميل** — لا هنا ولا في `logs`
//    (قانون حماية البيانات). الاسم والتليفون بيتجابوا من شوبيفاي وقت العرض بس، ونص الرسالة
//    بيتخزّن باسم العميل مستبدل بـ`{name}`.
// 🔴 **تعريف «الشحنة اللي في القايمة» مكانه `openListCTE()` هنا بس.** الصفحة
//    والرئيسية بيعرضوا الرد — مفيش نسخة تانية (درس R1).
// ⛔ **صفر endpoint دخول** (`check_employee`/`register_pin`/…): الدخول من Worker
//    الهب، والموظف بيتبعت `employee` من الجلسة. ومفيش إرسال واتساب من الـ
//    Worker — الإرسال يدوي بالكامل من رقم موظف المتابعة.
// ══════════════════════════════════════════════════════════════
const TOOL_NAME      = 'bosta_delivery_follow_up';
const WORKER_VERSION = '2.3.0';

// ══════════════════════════════════════════════════════════════
// §CONSTANTS
// ══════════════════════════════════════════════════════════════
const STATE_EXCEPTION = 47;               // Exception — بيحمل exception_code/exception_reason
const FINAL_STATES    = [45, 46, 48];    // Delivered · Returned to business · Terminated

// 🔴 v2.0.0 — القايمة = **كل** شحنة تحت التوصيل (آخر حدث مش نهائي ولا RTO) عليها محاولة توصيل أو أكتر.
//    مش «تأجيل بطلب العميل» بس (كان exception_code = 3 في v1.x).
const MIN_ATTEMPTS = 1;
// نافذة النشاط: رقم تتبع ما جاله ولا حدث في آخر N يوم بيطلع بره (حماية الاستعلام من تاريخ الجدول كله).
// ⚠️ معلنة في الرد (`windowDays`) وعلى الشاشة. تغييرها تغيير معنى — لازم ينزل على «عن الأداة» في الصفحة.
const WINDOW_DAYS = 60;
const MAX_ROWS    = 600;   // حارس: تحت التوصيل بمحاولة ≥ 1 ≈ 120 شحنة (مقيس 15-10-2026 من تاب «تحت التوصيل»)

// 🔴 سلسلة السقوف (worker-builder ⑪):
//   ③ ITEMS_PER_QUERY = 25 — **مش مقيس**: الاستعلام فيه lineItems(first:5)+عنوان+عميل
//      وتكلفته الفعلية لسه ما اتقاسش. رقم متحفّظ تحت سقف 50؛ `?action=diag` بيعرض
//      `actualQueryCost` — يتعاد اشتقاقه (700 ÷ تكلفة أوردر واحد) بعد أول قياس حي.
//   مصدر الحالة: شحنات تحت التوصيل (عابرة، عشرات لمئات) — مش حالة بتتراكم بلا سقف.
//   ⚠️ القايمة دلوقتي أكبر من v1.x (كل المحاولات مش التأجيل بس) → حوالي ٥ نداءات شوبيفاي لـ ١٢٠ شحنة بدل نداء واحد.
const ITEMS_PER_QUERY = 25;
const MAX_RECORD_ITEMS = 20;     // حارس لصق على record بـ items[]
const MAX_MESSAGE_LEN  = 1000;   // سقف نص الرسالة المخزّن
const MAX_SENDS_LIST   = 100;    // سقف قايمة مرات الإرسال لرقم تتبع واحد
const SEND_DEDUPE_MS   = 15000;  // نفس الموظف + نفس الرقم خلال المدة دي = ضغطة مزدوجة مش إرسال تاني

// ══════════════════════════════════════════════════════════════
// §CORS — Option B (قايمة صارمة)
// ══════════════════════════════════════════════════════════════
// ⚠️ الرد فيه أسماء وتليفونات عملاء — مفيش wildcard بأي حال.
const ALLOWED_ORIGINS = ['https://ecommoda-dev.github.io'];
function getCORS(request) {
  const origin  = request.headers.get('Origin') || '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
}

// ══════════════════════════════════════════════════════════════
// §HELPERS
// ══════════════════════════════════════════════════════════════
function json(data, status = 200, request = null) {
  const headers = { 'Content-Type': 'application/json' };
  Object.assign(headers, request ? getCORS(request) : { 'Access-Control-Allow-Origin': ALLOWED_ORIGINS[0] });
  return new Response(JSON.stringify(data), { status, headers });
}

const ENV_REQUIRED = {
  shopify: ['SHOP_DOMAIN', 'CLIENT_ID', 'CLIENT_SECRET'],
};
function assertEnv(env, ...groups) {
  const missing = [];
  for (const g of groups) {
    for (const key of (ENV_REQUIRED[g] || [])) {
      if (env[key] === undefined || env[key] === null || String(env[key]).trim() === '') missing.push(key);
    }
  }
  if (!env.DB) missing.push('DB (D1 binding)');
  if (missing.length) {
    throw new Error(
      `متغيرات ناقصة في الـ Worker: ${missing.join('، ')} — ضِفها من ` +
      `Dashboard → Settings → Variables ثم Promote النسخة. (شغّل ?action=diag)`
    );
  }
}

async function secretFingerprint(secret) {
  if (!secret) return null;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return [...new Uint8Array(buf)].slice(0, 4).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─── §HELPERS::time — توقيت القاهرة يتحسب (constants §13) ───
const CAIRO_TZ = 'Africa/Cairo';
const _cairoFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: CAIRO_TZ, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});
function cairoParts(d) {
  const o = {};
  for (const p of _cairoFmt.formatToParts(d)) if (p.type !== 'literal') o[p.type] = p.value;
  if (o.hour === '24') o.hour = '00';
  return o;
}
function cairoDate() { const p = cairoParts(new Date()); return `${p.year}-${p.month}-${p.day}`; }

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : def;
}

// ══════════════════════════════════════════════════════════════
// §SHARED — log block (منسوخ من references/shared-functions.md — بلا auth)
// ══════════════════════════════════════════════════════════════

// ─── §LOG-REG — الحارس الديناميكي لقيم اللوج (الطبقة ٥) ───
// قطعة الأداة دي بس من log-values.json — بتتحدّث معاه في نفس الـ commit.
const LOG_REGISTRY = {
  bosta_delivery_follow_up: new Set(['wa_opened']),
};
const isRegisteredLogValue = (tool, type) => !!LOG_REGISTRY[tool]?.has(type);

const LOG_ALERT_SQL = `
  INSERT INTO log_value_alerts
    (source_tool, tool, type, first_seen, last_seen, hits,
     worker_version, sample_order_name, sample_employee, sample_notes)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(source_tool, tool, type) DO UPDATE SET
    last_seen         = excluded.last_seen,
    hits              = log_value_alerts.hits + excluded.hits,
    worker_version    = excluded.worker_version,
    sample_order_name = excluded.sample_order_name,
    sample_employee   = excluded.sample_employee,
    sample_notes      = excluded.sample_notes,
    status            = CASE WHEN log_value_alerts.status = 'ignored'
                             THEN 'ignored' ELSE 'open' END
`;

async function noteUnregisteredLogValues(db, entries) {
  const byPair = new Map();
  for (const e of entries) {
    const key = `${e.tool}\u0000${e.type}`;
    const acc = byPair.get(key);
    if (acc) { acc.hits++; continue; }
    byPair.set(key, { entry: e, hits: 1 });
  }
  const now = new Date().toISOString();
  for (const { entry, hits } of byPair.values()) {
    try {
      await db.prepare(LOG_ALERT_SQL).bind(
        TOOL_NAME, entry.tool ?? '(بدون tool)', entry.type ?? '(بدون type)',
        now, now, hits, WORKER_VERSION ?? null,
        entry.orderName ?? null, entry.employee ?? null,
        entry.notes ? String(entry.notes).slice(0, 200) : null,
      ).run();
    } catch (e) { /* متعمّد: التنبيه فهرس، وفشله أهون من تعطيل الأداة */ }
  }
}

async function writeLog(db, entry) {
  const unregistered = !isRegisteredLogValue(entry.tool, entry.type);
  const extra = unregistered
    ? { ...(entry.extra || {}), _unregistered: true }
    : entry.extra;

  await db.prepare(`
    INSERT INTO logs
      (timestamp, tool, type, employee, order_id, order_name,
       sku, product_title, delta, value_before, value_after, notes, extra)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    entry.timestamp    ?? new Date().toISOString(),
    entry.tool,
    entry.type,
    entry.employee     ?? null,
    entry.orderId      ?? null,
    entry.orderName    ?? null,
    entry.sku          ?? null,
    entry.productTitle ?? null,
    entry.delta        ?? null,
    entry.valueBefore  ?? null,
    entry.valueAfter   ?? null,
    entry.notes        ?? null,
    extra ? JSON.stringify(extra) : null
  ).run();

  if (unregistered) await noteUnregisteredLogValues(db, [entry]);
}

const LOG_EXPORT_MAX = 2000;

function buildLogFilterSQL(select, {
  tool      = null,
  employee  = null, employees = null,
  type      = null, types     = null,
  search    = null,
  dateFrom  = null, dateTo    = null,
} = {}) {
  let sql = `${select} FROM logs WHERE type NOT IN ('login','logout')`;
  const b = [];

  const emps = Array.isArray(employees) && employees.length ? employees : (employee ? [employee] : []);
  const typs = Array.isArray(types)     && types.length     ? types     : (type     ? [type]     : []);

  if (tool) { sql += ' AND tool = ?'; b.push(tool); }
  if (emps.length) { sql += ` AND employee IN (${emps.map(() => '?').join(',')})`; b.push(...emps); }
  if (typs.length) { sql += ` AND type IN (${typs.map(() => '?').join(',')})`; b.push(...typs); }
  if (search) {
    sql += ' AND (order_name LIKE ? OR notes LIKE ?)';
    b.push(`%${search}%`, `%${search}%`);
  }
  if (dateFrom) { sql += ' AND substr(timestamp, 1, 10) >= ?'; b.push(dateFrom); }
  if (dateTo)   { sql += ' AND substr(timestamp, 1, 10) <= ?'; b.push(dateTo); }
  return { sql, b };
}

const LOG_SORT_COLUMNS = {
  date: 'timestamp', time: 'timestamp', employee: 'employee', orderName: 'order_name',
  result: `json_extract(extra, '$.result')`,
};
function orderByClause(sortBy, sortDir) {
  const col = LOG_SORT_COLUMNS[String(sortBy || '')] || 'timestamp';
  const dir = String(sortDir || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  return col === 'timestamp' ? ` ORDER BY timestamp ${dir}`
                             : ` ORDER BY ${col} ${dir}, timestamp DESC`;
}

async function getLogs(db, { limit = 100, offset = 0, sortBy, sortDir, ...filters } = {}) {
  const { sql, b } = buildLogFilterSQL('SELECT *', filters);
  const q = sql + orderByClause(sortBy, sortDir) + ' LIMIT ? OFFSET ?';
  return (await db.prepare(q).bind(...b, Math.min(limit, 100), Math.max(offset, 0)).all()).results;
}
async function getLogsCount(db, filters = {}) {
  const { sql, b } = buildLogFilterSQL('SELECT COUNT(*) as total', filters);
  const row = await db.prepare(sql).bind(...b).first();
  return row?.total ?? 0;
}
async function getLogsExport(db, filters = {}) {
  const { sql, b } = buildLogFilterSQL('SELECT *', filters);
  return (await db.prepare(sql + ' ORDER BY timestamp DESC LIMIT ?').bind(...b, LOG_EXPORT_MAX).all()).results;
}
function logParamsFrom(url, tool) {
  const csv = (k) => (url.searchParams.get(k) || '').split(',').map(s => s.trim()).filter(Boolean);
  const employees = csv('employees'), types = csv('types');
  return {
    tool,
    employees: employees.length ? employees : null,
    employee:  url.searchParams.get('employee') || null,
    types:     types.length ? types : null,
    type:      url.searchParams.get('type')     || null,
    search:    url.searchParams.get('search')   || null,
    dateFrom:  url.searchParams.get('dateFrom') || null,
    dateTo:    url.searchParams.get('dateTo')   || null,
  };
}

// ══════════════════════════════════════════════════════════════
// §SHOPIFY
// ══════════════════════════════════════════════════════════════
// ⚠️ التوكن مشترك بين كل Workers الستاك — الفشل العابر لازم يتعافى (⑯).
const OAUTH_MAX_ATTEMPTS = 3;

// 🔴 القيم بتتنضّف من المسافات/السطر الجديد (لصق سر من الداشبورد بيجيب `\n` أو مسافة أوقات)،
//    ورسالة الفشل فيها **سبب شوبيفاي** (`invalid_client` …) — «OAuth failed: 400» لوحدها
//    ماكانتش بتفرّق بين سر غلط ودومين غلط وتطبيق مش متثبّت. (الرد مفيهوش أي سر.)
const cleanEnv = (v) => String(v ?? '').trim();

async function getAccessToken(env) {
  let lastErr = null;
  for (let attempt = 1; attempt <= OAUTH_MAX_ATTEMPTS; attempt++) {
    try {
      const resp = await fetch(`https://${cleanEnv(env.SHOP_DOMAIN)}/admin/oauth/access_token`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: cleanEnv(env.CLIENT_ID), client_secret: cleanEnv(env.CLIENT_SECRET), grant_type: 'client_credentials' }),
      });
      if (!resp.ok) {
        const retriable = resp.status === 429 || resp.status >= 500;
        const detail = (await resp.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160);
        lastErr = new Error(`OAuth failed: ${resp.status}${detail ? ' — ' + detail : ''}`);
        if (retriable && attempt < OAUTH_MAX_ATTEMPTS) { await new Promise(r => setTimeout(r, 700 * attempt)); continue; }
        throw lastErr;
      }
      const data = await resp.json();
      if (!data.access_token) throw new Error('No access_token in response');
      return data.access_token;
    } catch (e) {
      lastErr = e;
      if (attempt < OAUTH_MAX_ATTEMPTS) { await new Promise(r => setTimeout(r, 400 * attempt)); continue; }
      throw lastErr;
    }
  }
  throw lastErr || new Error('OAuth: فشل غير معروف');
}

let _lastThrottle = null, _lastQueryCost = null;

async function shopifyGQL(env, token, query, variables = {}, opName = 'shopify', costLog = null) {
  const MAX_ATTEMPTS = 3;
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let resp, text;
    try {
      resp = await fetch(`https://${env.SHOP_DOMAIN}/admin/api/2026-01/graphql.json`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body:    JSON.stringify({ query, variables }),
      });
      text = await resp.text();
    } catch (e) {
      lastErr = new Error(`${opName}: فشل الاتصال بشوبيفاي — ${e.message}`);
      if (attempt < MAX_ATTEMPTS) { await new Promise(r => setTimeout(r, 400 * attempt)); continue; }
      throw lastErr;
    }
    if (!resp.ok) {
      const retriable = resp.status === 429 || resp.status >= 500;
      lastErr = new Error(`${opName}: شوبيفاي ردّت HTTP ${resp.status} — ${text.slice(0, 180)}`);
      if (retriable && attempt < MAX_ATTEMPTS) { await new Promise(r => setTimeout(r, 700 * attempt)); continue; }
      throw lastErr;
    }
    let data;
    try { data = JSON.parse(text); }
    catch { throw new Error(`${opName}: رد شوبيفاي مش JSON صالح — ${text.slice(0, 180)}`); }

    if (Array.isArray(data.errors) && data.errors.length) {
      const codes = data.errors.map(e => e?.extensions?.code).filter(Boolean);
      lastErr = new Error(`${opName}: ${data.errors.map(e => e.message).join(' | ')}` + (codes.length ? ` [${codes.join(',')}]` : ''));
      if (codes.includes('THROTTLED') && attempt < MAX_ATTEMPTS) { await new Promise(r => setTimeout(r, 1200 * attempt)); continue; }
      throw lastErr;
    }
    if (!data.data) throw new Error(`${opName}: رد شوبيفاي بدون data — ${text.slice(0, 180)}`);

    if (data.extensions?.cost) {
      const c = data.extensions.cost;
      if (c.throttleStatus) _lastThrottle = c.throttleStatus;
      _lastQueryCost = { op: opName, requested: c.requestedQueryCost ?? null, actual: c.actualQueryCost ?? null };
      if (costLog) costLog.push({ op: opName, requested: c.requestedQueryCost ?? null, actual: c.actualQueryCost ?? null });
    }
    return data;
  }
  throw lastErr || new Error(`${opName}: فشل غير معروف`);
}

// ─── §SHOPIFY::fetchOrders — بيانات العميل وقت العرض بس (ما بتتخزّنش) ───
// ⚠️ اسم/تليفون/عنوان = Protected customer data. لو الـ Custom App مالوش
//    الصلاحية الحقول بترجع null **بلا خطأ** → الصفحة بتعرض «—»، و`diag` بيمسك ده.
const ORDERS_QUERY = `query FollowUpOrders($ids: [ID!]!) {
  nodes(ids: $ids) { ... on Order {
    id legacyResourceId name cancelledAt displayFinancialStatus
    currentTotalPriceSet { shopMoney { amount } }
    phone
    shippingAddress { firstName name phone city province }
    customer { firstName phone }
    lineItems(first: 5) { nodes { title quantity } }
  } }
}`;

function toOrderGid(id) {
  const s = String(id ?? '').trim();
  if (!s) return null;
  if (s.startsWith('gid://')) return s;
  return /^\d+$/.test(s) ? `gid://shopify/Order/${s}` : null;
}

async function fetchOrders(env, token, shopifyIds, costLog) {
  const gids = [...new Set(shopifyIds.map(toOrderGid).filter(Boolean))];
  const byId = new Map();   // legacyResourceId (نص) → كائن مبسّط
  for (let i = 0; i < gids.length; i += ITEMS_PER_QUERY) {
    const chunk = gids.slice(i, i + ITEMS_PER_QUERY);
    const data  = await shopifyGQL(env, token, ORDERS_QUERY, { ids: chunk }, 'followUpOrders', costLog);
    for (const n of (data.data.nodes || [])) {
      if (!n) continue;
      byId.set(String(n.legacyResourceId), {
        orderId:   String(n.legacyResourceId),
        name:      n.name ?? null,
        cancelled: !!n.cancelledAt,
        financial: n.displayFinancialStatus ?? null,
        total:     n.currentTotalPriceSet?.shopMoney?.amount != null
                     ? Number(n.currentTotalPriceSet.shopMoney.amount) : null,
        orderPhone: n.phone ?? null,
        customer: {
          firstName: (n.shippingAddress?.firstName ?? n.customer?.firstName ?? '').trim() || null,
          fullName:  n.shippingAddress?.name ?? null,
          shipPhone: n.shippingAddress?.phone ?? null,
          custPhone: n.customer?.phone ?? null,
          city:      n.shippingAddress?.city ?? null,
          province:  n.shippingAddress?.province ?? null,
        },
        items: (n.lineItems?.nodes || []).map(l => [l.title ?? null, l.quantity ?? null]),
      });
    }
  }
  return byId;
}

// ══════════════════════════════════════════════════════════════
// §FOLLOWUP — تعريف القايمة + جدول سجل الإرسال
// ══════════════════════════════════════════════════════════════

// 🔴 SCHEMA_SQL **مصفوفة `.join('\n')`** — عبارة لكل عنصر (درس المستقبل: `db.exec`
//    بيشتغل سطر بسطر). بنستخدم `batch(prepare)` فمفيش اعتماد على ده، بس الشكل
//    ثابت عشان نفس النص يتلزق في D1 Console.
// ⛔ ممنوع عمود اسم/تليفون/عنوان. `message` بيتخزّن **بعد** ما الواجهة تستبدل اسم العميل بـ`{name}`
//    وبعد ما `sanitizeMessage` يشيل أي رقم موبايل — الاسم بيرجع وقت العرض من شوبيفاي.
const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS bosta_followup_sends (id INTEGER PRIMARY KEY AUTOINCREMENT, tracking_number TEXT NOT NULL, order_name TEXT NOT NULL, shopify_order_id TEXT, attempts INTEGER, state INTEGER, sent_by TEXT NOT NULL, sent_at TEXT NOT NULL, message TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_bfs_tracking ON bosta_followup_sends(tracking_number)`,
];
let _schemaReady = false;
async function ensureSchema(db) {
  if (_schemaReady) return;
  await db.batch(SCHEMA_SQL.map(s => db.prepare(s)));
  _schemaReady = true;
}

// ─── §FOLLOWUP::OPEN_LIST_CTE — تعريف «الشحنة تحت التوصيل وعليها محاولة توصيل» ───
// شحنة = رقم تتبع **آخر حدث له مش نهائي** (مفيش عليه 45/46/48 ولا RTO في أي وقت) و**أعلى
// `number_of_attempts` عليه ≥ 1**. ده نفس تعريف تاب «الأوردرات تحت التوصيل» في «متابعة شحنات بوسطة»
// (آخر حدث لكل رقم تتبع · استبعاد النهائي والـ RTO) + شرط المحاولات.
// 🔴 مش بيفرّق سبب الفشل (تأجيل · العميل مش موجود · مش بيرد …) — كل شحنة جرّبوا يوصّلوها ولسه ما اتسلّمتش.
// ⚠️ ?1 = ISO بداية نافذة النشاط (`WINDOW_DAYS`): رقم تتبع ما جاله ولا حدث بعدها بيطلع بره — النافذة
//    **معلنة** في الرد (`windowDays`) وفي الشاشة. الفلتر على received_at عشان يستخدم idx_bwe_received_at.
//    🔴 v2.2.0: «RTO» هنا = In-Return = نوعها RTO، أو EXCHANGE/CUSTOMER_RETURN_PICKUP (v2.3.0) وعليها حدث 23 (Picked up from consignee) —
//    نفس تعريف تاب In-Return في «متابعة شحنات بوسطة» (طلب أحمد 25-10-2026).
//    ⚠️ الاستبعاد النهائي/RTO بيتحسب على **كل** تاريخ الرقم مش النافذة بس (JOIN على رقم التتبع).
// ⚠️ `attempts` = MAX(number_of_attempts) على كل أحداث الرقم — أمتن من آخر حدث لو آخر حدث جه بلا القيمة.
// ⚠️ `last_exc_code` / `last_reason` = كود وسبب **آخر حدث Exception (47)** على الرقم — بيحدد صيغة الرسالة
//    (كود 3 = تأجيل بطلب العميل) وبيتعرض في عمود «آخر سبب».
// ⛔ ممنوع SELECT * على bosta_webhook_events (فيه raw_payload كبير) — أعمدة صريحة.
function openListCTE() {
  return `WITH base AS (SELECT tracking_number FROM bosta_webhook_events WHERE received_at >= ?1 AND tracking_number IS NOT NULL AND tracking_number <> '' GROUP BY tracking_number), ` +
    `agg AS (SELECT e.tracking_number, MAX(e.number_of_attempts) AS attempts, MAX(CASE WHEN e.state IN (${FINAL_STATES.join(',')}) THEN 1 ELSE 0 END) AS fin, MAX(CASE WHEN UPPER(COALESCE(e.bosta_type,''))='RTO' OR (UPPER(COALESCE(e.bosta_type,'')) IN ('EXCHANGE','CUSTOMER_RETURN_PICKUP') AND e.state=23) THEN 1 ELSE 0 END) AS rto FROM bosta_webhook_events e JOIN base USING(tracking_number) GROUP BY e.tracking_number), ` +
    `lt AS (SELECT e.tracking_number, e.state, e.description, e.business_reference, e.matched_slot, e.bosta_type, e.delivery_promise_date, e.shopify_order_id, e.cod, e.received_at AS last_at, e.bosta_timestamp AS last_ts, ROW_NUMBER() OVER (PARTITION BY e.tracking_number ORDER BY e.bosta_timestamp DESC, e.received_at DESC, e.id DESC) rn FROM bosta_webhook_events e JOIN base USING(tracking_number)), ` +
    `ex AS (SELECT e.tracking_number, e.exception_code, e.exception_reason, e.received_at AS ex_at, ROW_NUMBER() OVER (PARTITION BY e.tracking_number ORDER BY e.bosta_timestamp DESC, e.received_at DESC, e.id DESC) rn FROM bosta_webhook_events e JOIN base USING(tracking_number) WHERE e.state=${STATE_EXCEPTION}), ` +
    `open_list AS (SELECT lt.tracking_number, lt.state, lt.description, lt.business_reference, lt.matched_slot, lt.bosta_type, lt.delivery_promise_date, lt.shopify_order_id, lt.cod, lt.last_at, lt.last_ts, agg.attempts, ex.exception_code AS last_exc_code, ex.exception_reason AS last_reason, ex.ex_at AS last_exc_at ` +
    `FROM lt JOIN agg ON agg.tracking_number = lt.tracking_number LEFT JOIN ex ON ex.tracking_number = lt.tracking_number AND ex.rn = 1 ` +
    `WHERE lt.rn = 1 AND agg.fin = 0 AND agg.rto = 0 AND COALESCE(agg.attempts, 0) >= ${MIN_ATTEMPTS})`;
}

function windowStartISO() {
  return new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString();
}

// عدد الإرسال لكل رقم تتبع + آخر مرسِل/وقت (من جدول الإرسال)
const SENDS_JOIN =
  ` LEFT JOIN (SELECT tracking_number, COUNT(*) AS n, MAX(id) AS mid FROM bosta_followup_sends GROUP BY tracking_number) sc ON sc.tracking_number = o.tracking_number` +
  ` LEFT JOIN bosta_followup_sends ls ON ls.id = sc.mid`;

async function queryOpenList(db) {
  const sql = openListCTE() +
    ` SELECT o.*, COALESCE(sc.n, 0) AS send_count, ls.sent_by AS last_sent_by, ls.sent_at AS last_sent_at ` +
    `FROM open_list o${SENDS_JOIN} ORDER BY o.last_ts DESC, o.tracking_number LIMIT ${MAX_ROWS}`;
  return (await db.prepare(sql).bind(windowStartISO()).all()).results;
}

function shapeRow(r, order) {
  return {
    trackingNumber: r.tracking_number,
    order:          r.business_reference ?? null,
    slot:           r.matched_slot ?? null,
    bostaType:      r.bosta_type ?? null,
    state:          r.state ?? null,
    stateDesc:      r.description ?? null,
    promiseDate:    r.delivery_promise_date ?? null,    // DD-MM-YYYY — الصفحة بتحوّله يدوي (قاعدة ٦)
    attempts:       r.attempts ?? null,
    lastEventAt:    r.last_at ?? null,                  // received_at لآخر حدث (ISO)
    lastReason:     r.last_reason ?? null,              // سبب آخر Exception (إنجليزي خام — الواجهة بتعرّبه)
    lastExcCode:    r.last_exc_code ?? null,            // '3' = تأجيل بطلب العميل
    codBosta:       r.cod ?? null,
    shopifyOrderId: r.shopify_order_id ?? null,
    orderId:        order?.orderId ?? (r.shopify_order_id ? String(r.shopify_order_id).split('/').pop() : null),
    hasOrder:       !!order,
    customer:       order ? { ...order.customer, orderPhone: order.orderPhone } : null,
    total:          order?.total ?? null,
    financial:      order?.financial ?? null,
    cancelled:      order ? order.cancelled : false,
    items:          order?.items ?? [],
    sends: {
      count:  r.send_count ?? 0,
      lastBy: r.last_sent_by ?? null,
      lastAt: r.last_sent_at ?? null,
    },
  };
}

// ─── §FOLLOWUP::get_followups ───
async function handleGetFollowups(env, request) {
  assertEnv(env, 'shopify');
  await ensureSchema(env.DB);
  const rows = await queryOpenList(env.DB);

  // شوبيفاي: فشلها مايسقّطش القايمة — الصفوف بتتعرض بدون بيانات عميل + تحذير صريح
  let orders = new Map(), shopifyError = null;
  const costLog = [];
  const ids = rows.map(r => r.shopify_order_id).filter(Boolean);
  if (ids.length) {
    try {
      const token = await getAccessToken(env);
      orders = await fetchOrders(env, token, ids, costLog);
    } catch (e) { shopifyError = e.message; }
  }

  const shaped = rows.map(r => {
    const key = r.shopify_order_id ? String(r.shopify_order_id).split('/').pop() : null;
    return shapeRow(r, key ? orders.get(key) : null);
  });
  const sent = shaped.filter(s => s.sends.count > 0).length;

  return json({
    ok: true, windowDays: WINDOW_DAYS, minAttempts: MIN_ATTEMPTS, generatedAt: new Date().toISOString(),
    truncated: rows.length >= MAX_ROWS, cap: MAX_ROWS,
    shopifyError,                       // null = سليم · نص = بيانات العميل غايبة والسبب
    rows: shaped,
    counts: { total: shaped.length, unsent: shaped.length - sent, sent },
    queryCost: costLog,                 // للقياس بس — صفر اعتماد من الواجهة (⑮)
  }, 200, request);
}

// ─── §FOLLOWUP::queue_summary — عدّادات الرئيسية بـ SQL مجمّع بلا شوبيفاي ───
// unsent = شحنة ما اتبعتلهاش ولا رسالة · sent = اتبعتلها مرة على الأقل (الإرسال بيتعدّ من «فتح واتساب»)
// ⚠️ الوحدة «شحنة» مش «عميل» — التجميع بالتليفون في الصفحة بس (التليفون من شوبيفاي).
async function handleQueueSummary(env, request) {
  await ensureSchema(env.DB);
  const sql = openListCTE() +
    ` SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN sc.n IS NULL THEN 1 ELSE 0 END), 0) AS unsent ` +
    `FROM open_list o LEFT JOIN (SELECT tracking_number, COUNT(*) AS n FROM bosta_followup_sends GROUP BY tracking_number) sc ON sc.tracking_number = o.tracking_number`;
  const r = await env.DB.prepare(sql).bind(windowStartISO()).first();
  const total = r?.total ?? 0, unsent = r?.unsent ?? 0;
  return json({
    ok: true, windowDays: WINDOW_DAYS, generatedAt: new Date().toISOString(),
    total, unsent, sent: total - unsent,
  }, 200, request);
}

// ─── §FOLLOWUP::get_sends — تفاصيل كل مرات الإرسال لرقم تتبع (الأحدث فوق) ───
async function handleGetSends(env, url, request) {
  await ensureSchema(env.DB);
  const tn = String(url.searchParams.get('trackingNumber') || '').trim();
  if (!tn) return json({ ok: false, error: 'trackingNumber مطلوب' }, 400, request);
  const { results } = await env.DB.prepare(
    `SELECT id, order_name, attempts, state, sent_by, sent_at, message FROM bosta_followup_sends WHERE tracking_number = ? ORDER BY id DESC LIMIT ${MAX_SENDS_LIST}`
  ).bind(tn).all();
  return json({
    ok: true, trackingNumber: tn,
    sends: results.map(s => ({
      id: s.id, order: s.order_name, attempts: s.attempts, state: s.state,
      sentBy: s.sent_by, sentAt: s.sent_at, message: s.message,
    })),
  }, 200, request);
}

// ─── §FOLLOWUP::get_events — سجل أحداث بوسطة لرقم تتبع (الأحدث فوق) — قراءة بس ───
// أعمدة صريحة من bosta_webhook_events، ⛔ مفيش raw_payload ولا SELECT *.
async function handleGetEvents(env, url, request) {
  const tn = String(url.searchParams.get('trackingNumber') || '').trim();
  if (!tn) return json({ ok: false, error: 'trackingNumber مطلوب' }, 400, request);
  const { results } = await env.DB.prepare(
    `SELECT id, state, description, exception_reason, number_of_attempts, bosta_type, bosta_timestamp, received_at, business_reference ` +
    `FROM bosta_webhook_events WHERE tracking_number = ? ORDER BY bosta_timestamp DESC, received_at DESC, id DESC LIMIT 200`
  ).bind(tn).all();
  return json({ ok: true, trackingNumber: tn, events: results }, 200, request);
}

// ─── §FOLLOWUP::record — تسجيل إن رسالة اتبعتت (فتح واتساب) ───
// 🔴 **كل ضغطة = صف** — الهدف نفسه العدّ («اتبعتت كام مرة»). الحماية من الضغطة المزدوجة: نفس
//    الموظف على نفس الرقم خلال `SEND_DEDUPE_MS` = مش بيتسجّل تاني (`deduped:true`).
// ⚠️ الحقيقة اللي بتتسجّل «الموظف فتح الواتساب بالنص ده» — مفيش طريقة نعرف إن الرسالة اتبعتت فعلاً.
// العقد: `items[]` اختياري (مجموعة نفس التليفون) — نتيجة لكل عنصر **بنفس الترتيب**.
// ⚠️ مفيش شرط إن الشحنة لسه في القايمة — الرسالة اتفتحت فعلاً، والحقيقة بتتسجّل حتى لو الشحنة
//    اتسلّمت في نفس اللحظة (بدل ما نضيّع السجل ونقول 409).

// أي رقم موبايل مصري جوّه النص بيتشال (الواجهة بتبدّل الاسم بـ{name}، ودي حماية تانية لو الموظف كتب رقم).
// ⚠️ best-effort: اسم كتبه الموظف بإيده بشكل غير اللي في الشِل مش بنمسكه — راجع CLAUDE.md.
function sanitizeMessage(raw) {
  return String(raw ?? '').replace(/\r\n/g, '\n').trim()
    .replace(/(?<!\d)(?:\+?20|0)?1[0125]\d{8}(?!\d)/g, '[رقم]')
    .slice(0, MAX_MESSAGE_LEN);
}

async function recordOne(env, employee, trackingNumber, message) {
  const tn = String(trackingNumber ?? '').trim();
  if (!tn) return { ok: false, status: 400, error: 'trackingNumber مطلوب' };

  const ev = await env.DB.prepare(
    `SELECT business_reference, shopify_order_id, state, (SELECT MAX(number_of_attempts) FROM bosta_webhook_events WHERE tracking_number = ?1) AS attempts ` +
    `FROM bosta_webhook_events WHERE tracking_number = ?1 ORDER BY bosta_timestamp DESC, received_at DESC, id DESC LIMIT 1`
  ).bind(tn).first();
  if (!ev) return { ok: false, status: 404, error: 'رقم التتبع مش موجود في أحداث بوسطة' };

  const countSql = 'SELECT COUNT(*) AS n FROM bosta_followup_sends WHERE tracking_number = ?';
  const last = await env.DB.prepare(
    'SELECT sent_at FROM bosta_followup_sends WHERE tracking_number = ? AND sent_by = ? ORDER BY id DESC LIMIT 1'
  ).bind(tn, employee).first();
  if (last && Date.now() - Date.parse(last.sent_at) < SEND_DEDUPE_MS) {
    const n = (await env.DB.prepare(countSql).bind(tn).first())?.n ?? 0;
    return { ok: true, deduped: true, count: n, logged: true };
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO bosta_followup_sends (tracking_number, order_name, shopify_order_id, attempts, state, sent_by, sent_at, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(tn, ev.business_reference ?? '—', ev.shopify_order_id ?? null, ev.attempts ?? null, ev.state ?? null, employee, now, message).run();
  const count = (await env.DB.prepare(countSql).bind(tn).first())?.n ?? 1;

  // ⚠️ الكتابة في الجدول حصلت — فشل السجل بيرجع logged:false مش 500 (5A ⑦). 🔴 صفر تليفون/اسم/عنوان/نص رسالة في الصف.
  let logged = true;
  try {
    await writeLog(env.DB, {
      tool: TOOL_NAME, type: 'wa_opened', employee, orderName: ev.business_reference ?? null,
      valueBefore: String(count - 1), valueAfter: String(count),
      extra: { trackingNumber: tn, attempts: ev.attempts ?? null },
    });
  } catch { logged = false; }

  return { ok: true, count, logged };
}

async function handleRecord(env, request) {
  await ensureSchema(env.DB);
  const body = await request.json().catch(() => ({}));
  const employee = String(body.employee || '').trim();
  if (!employee) return json({ ok: false, error: 'employee مطلوب' }, 400, request);

  const message = sanitizeMessage(body.message);
  if (!message) return json({ ok: false, error: 'message مطلوب (نص الرسالة)' }, 400, request);

  const items = Array.isArray(body.items) && body.items.length ? body.items : [{ trackingNumber: body.trackingNumber }];
  if (items.length > MAX_RECORD_ITEMS)
    return json({ ok: false, error: `الدفعة أكبر من الحد (${items.length} من ${MAX_RECORD_ITEMS})` }, 400, request);

  // نتيجة واحدة لكل عنصر بنفس الترتيب
  const results = [];
  for (const it of items) results.push(await recordOne(env, employee, it?.trackingNumber, message));

  // 🔴 HTTP 200 دايمًا لما الطلب نفسه سليم — الفشل **جوّه** results[i] (ok:false + status 404/400).
  //    كود 4xx على الرد كله بيخلّي `dcoApi` يرمي «HTTP 4xx» ويضيّع نتايج العناصر اللي نجحت في نفس الدفعة.
  return json({ ok: results.every(r => r.ok), results }, 200, request);
}

// ══════════════════════════════════════════════════════════════
// §DIAG — فحص ذاتي بلا أي كتابة (مصفوفة { ok, label, detail, hint })
// ══════════════════════════════════════════════════════════════
async function handleDiag(env, request) {
  const checks = [];
  const push = (ok, label, detail, hint) => checks.push({ ok, label, detail, hint });

  const s = env.WORKER_SECRET;
  const hasSecret = typeof s === 'string' && s.trim() !== '';
  push(hasSecret, 'سر الـ Worker', hasSecret ? `WORKER_SECRET=${String(s).length} حرف` : 'WORKER_SECRET=❌ ناقص',
       'Dashboard → Settings → Variables، وبعدها **Promote**');
  const fp = await secretFingerprint(s);
  push(!!fp, 'بصمة WORKER_SECRET', fp ? `بصمة ${fp} · مجموعة delivery_cod_ops — لازم تطابق باقي الأعضاء` : 'مفيش سر',
       'بصمة مختلفة = المجموعة مكسورة والهب هيرجّع 401 من العضو ده');

  for (const k of ['SHOP_DOMAIN', 'CLIENT_ID', 'CLIENT_SECRET']) {
    const has = typeof env[k] === 'string' && env[k].trim() !== '';
    push(has, k, has ? `${k}=${String(env[k]).length} حرف` : `${k}=❌ ناقص`,
         k === 'SHOP_DOMAIN' ? '`[vars]` في wrangler.toml' : 'سر — Dashboard ثم Promote');
  }

  // D1 + جدول الإرسال
  try {
    assertEnv(env);
    await ensureSchema(env.DB);
    const f = await env.DB.prepare('SELECT COUNT(*) AS n FROM bosta_followup_sends').first();
    push(true, 'D1 — جدول سجل الإرسال', `متصل · ${f?.n ?? 0} مرة إرسال مسجّلة`);
  } catch (e) {
    push(false, 'D1 — جدول سجل الإرسال', `FAILED: ${e.message}`, 'binding اسمه `DB` بالحرف في wrangler.toml');
  }

  // 🔴 قراءة تجريبية من جدول المستقبل — أي تغيير في أعمدته يبان هنا قبل الموظف
  try {
    const since = windowStartISO();
    const r = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM bosta_webhook_events WHERE state=${STATE_EXCEPTION} AND received_at >= ?1`
    ).bind(new Date(Date.now() - 86400000).toISOString()).first();
    // الاستعلام الكامل نفسه (بيتحقق من كل الأعمدة اللي القايمة معتمدة عليها)
    const open = (await env.DB.prepare(openListCTE() + ' SELECT COUNT(*) AS n FROM open_list').bind(since).first())?.n ?? 0;
    push(true, 'قراءة bosta_webhook_events', `${r?.n ?? 0} حدث Exception آخر 24 ساعة · ${open} شحنة تحت التوصيل بمحاولة ≥ ${MIN_ATTEMPTS} (نافذة نشاط ${WINDOW_DAYS} يوم)`);
    push(open <= MAX_ROWS, 'سقف القايمة', `${open} من ${MAX_ROWS}`, 'القايمة بتتقصّ عند السقف — ارفع MAX_ROWS أو قلّل النافذة');
  } catch (e) {
    push(false, 'قراءة bosta_webhook_events', `FAILED: ${e.message}`,
         'الجدول ده تبع Bosta-Webhook-Status-Receiver — لو عمود اتغيّر هناك القايمة هنا بتقع. الأعمدة المعتمدة: id · tracking_number · state · exception_code · exception_reason · bosta_timestamp · received_at · description · business_reference · matched_slot · bosta_type · delivery_promise_date · number_of_attempts · cod · shopify_order_id');
  }

  // شوبيفاي: OAuth + الصلاحيات + بيانات العميل
  let token = null;
  try {
    assertEnv(env, 'shopify');
    token = await getAccessToken(env);
    push(true, 'شوبيفاي OAuth', 'التوكن اتجاب');
  } catch (e) {
    push(false, 'شوبيفاي OAuth', `FAILED: ${e.message}`, 'CLIENT_ID/CLIENT_SECRET/SHOP_DOMAIN + Promote بعد أي سر');
  }
  if (token) {
    try {
      const d = await shopifyGQL(env, token, '{ currentAppInstallation { accessScopes { handle } } }', {}, 'diagScopes');
      const scopes = (d.data.currentAppInstallation?.accessScopes || []).map(x => x.handle);
      push(scopes.includes('read_orders'), 'صلاحية read_orders', scopes.includes('read_orders') ? 'موجودة' : 'ناقصة',
           'القايمة محتاجة قراءة الأوردرات');
    } catch (e) { push(false, 'صلاحيات التطبيق', `FAILED: ${e.message}`); }

    // أوردر معروف من القايمة: التليفون راجع ولا null؟ (Protected customer data)
    try {
      const costLog = [];
      const rows = await env.DB.prepare(
        openListCTE() + ' SELECT shopify_order_id FROM open_list WHERE shopify_order_id IS NOT NULL ORDER BY last_ts DESC LIMIT 1'
      ).bind(windowStartISO()).all();
      const sid = rows.results?.[0]?.shopify_order_id;
      if (!sid) push(true, 'بيانات العميل (Protected customer data)', 'ℹ️ مفيش شحنة مفتوحة لقياسها دلوقتي');
      else {
        const m = await fetchOrders(env, token, [sid], costLog);
        const o = [...m.values()][0];
        const hasName = !!(o?.customer.firstName || o?.customer.fullName);
        const hasPhone = !!(o?.customer.shipPhone || o?.orderPhone || o?.customer.custPhone);
        push(!!o && hasName && hasPhone, 'بيانات العميل (Protected customer data)',
             !o ? 'الأوردر مرجعش من شوبيفاي' : `الاسم ${hasName ? '✅' : '❌ null'} · التليفون ${hasPhone ? '✅' : '❌ null'}`,
             'null على أوردر معروف = الـ Custom App مالوش صلاحية Protected customer data (اسم/تليفون)');
      }
    } catch (e) { push(false, 'بيانات العميل', `FAILED: ${e.message}`); }
  }

  // ⑮ الرقمين منفصلين
  push(true, 'throttleStatus (الرصيد المتبقي)', _lastThrottle ? JSON.stringify(_lastThrottle) : 'ℹ️ لسه مفيش نداء قيس');
  push(true, 'actualQueryCost (آخر نداء)', _lastQueryCost ? JSON.stringify(_lastQueryCost) : 'ℹ️ لسه مفيش نداء قيس',
       `ITEMS_PER_QUERY=${ITEMS_PER_QUERY} غير مقيس — اشتقّه من الرقم ده (700 ÷ تكلفة أوردر واحد)`);

  const origin = request.headers.get('Origin') || '(بلا Origin)';
  push(ALLOWED_ORIGINS.includes(origin), 'الـ Origin', `${origin} · المسموح: ${ALLOWED_ORIGINS.join(', ')}`);

  return json({ ok: checks.every(c => c.ok), version: WORKER_VERSION, tool: TOOL_NAME, cairoDate: cairoDate(), checks }, 200, request);
}

// ══════════════════════════════════════════════════════════════
// §HANDLER
// ══════════════════════════════════════════════════════════════
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: getCORS(request) });

    // 🔴 حارس السر الغايب قبل فحص الـ auth ("Bearer undefined" كان بيعدّي)
    if (typeof env.WORKER_SECRET !== 'string' || !env.WORKER_SECRET.trim())
      return json({ ok: false, error: 'WORKER_SECRET غير مضبوط على الـ Worker', step: 'env' }, 500, request);

    const auth = request.headers.get('Authorization');
    if (!auth || auth !== `Bearer ${env.WORKER_SECRET}`)
      return json({ error: 'Unauthorized' }, 401, request);

    const url    = new URL(request.url);
    const action = url.searchParams.get('action') || '';

    try {
      if (action === 'get_config')
        return json({ ok: true, version: WORKER_VERSION, WORKER_VERSION, tool: TOOL_NAME }, 200, request);
      if (action === 'diag') return await handleDiag(env, request);

      assertEnv(env);

      // ─── §FOLLOWUP ───────────────────────────────────────
      if (action === 'get_followups') return await handleGetFollowups(env, request);
      if (action === 'queue_summary') return await handleQueueSummary(env, request);
      if (action === 'get_sends')     return await handleGetSends(env, url, request);
      if (action === 'get_events')    return await handleGetEvents(env, url, request);
      if (action === 'record') {
        if (request.method !== 'POST') return json({ error: 'POST required' }, 405, request);
        return await handleRecord(env, request);
      }

      // ─── §LOG-ENDPOINTS ──────────────────────────────────
      if (action === 'get_logs') {
        const params = logParamsFrom(url, TOOL_NAME);
        const entries = await getLogs(env.DB, {
          ...params,
          sortBy: url.searchParams.get('sortBy'), sortDir: url.searchParams.get('sortDir'),
          limit:  parseInt(url.searchParams.get('limit')  || '100', 10),
          offset: parseInt(url.searchParams.get('offset') || '0', 10),
        });
        return json({ ok: true, entries }, 200, request);
      }
      if (action === 'get_logs_count') {
        return json({ ok: true, total: await getLogsCount(env.DB, logParamsFrom(url, TOOL_NAME)) }, 200, request);
      }
      if (action === 'get_logs_export') {
        const params = logParamsFrom(url, TOOL_NAME);
        const [entries, total] = await Promise.all([getLogsExport(env.DB, params), getLogsCount(env.DB, params)]);
        return json({ ok: true, entries, cap: LOG_EXPORT_MAX, total, truncated: total > entries.length }, 200, request);
      }

      return json({ error: `Unknown action: ${action}` }, 404, request);
    } catch (e) {
      return json({ ok: false, error: e.message }, 500, request);
    }
  },
};
