// ══════════════════════════════════════════════════════════════
// §HEADER
// Worker: bosta-delivery-follow-up-worker — EcomModa
// Tool:   متابعة التأجيلات — شحنات بوسطة اللي العميل طلب تأجيلها (واتساب يدوي)
//
// skills: worker-builder v3.9.2 — 15-10-2026
//
// 🔴 **بيقرا من `bosta_webhook_events` (جدول `bosta-webhook-status-receiver-worker`)
//    ومايكتبش فيه ولا حرف ولا فهرس.** الجدول ده تبع أداة تانية، وأي
//    تغيير في شكله بيوقع القايمة هنا — `?action=diag` بيعمل قراءة تجريبية
//    عشان التغيير يبان قبل الموظف.
// 🔴 **بيكتب في جدول واحد خاص بيه: `bosta_delivery_followups`** (حالة المتابعة).
//    ⛔ **ممنوع تخزين اسم أو تليفون أو عنوان عميل** — لا هنا ولا في `logs`
//    (قانون حماية البيانات). الاسم والتليفون بيتجابوا من شوبيفاي وقت العرض بس.
// 🔴 **تعريف «الشحنة المتأجلة المفتوحة» مكانه `OPEN_LIST_CTE` هنا بس.** الصفحة
//    والرئيسية بيعرضوا الرد — مفيش نسخة تانية (درس R1).
// ⛔ **صفر endpoint دخول** (`check_employee`/`register_pin`/…): الدخول من Worker
//    الهب، والموظف بيتبعت `employee` من الجلسة. ومفيش إرسال واتساب من الـ
//    Worker — الإرسال يدوي بالكامل من رقم موظف المتابعة.
// ══════════════════════════════════════════════════════════════
const TOOL_NAME      = 'bosta_delivery_follow_up';
const WORKER_VERSION = '1.0.1';

// ══════════════════════════════════════════════════════════════
// §CONSTANTS
// ══════════════════════════════════════════════════════════════
const POSTPONED_EXCEPTION_CODE = '3';      // «Postponed - the customer requested postponement…»
const STATE_EXCEPTION          = 47;
const FINAL_STATES             = [45, 46, 48];   // Delivered · Returned to business · Terminated

const DEFAULT_WINDOW_DAYS = 3;
const MAX_WINDOW_DAYS     = 14;
const MAX_ROWS            = 400;   // حارس: ~12 شحنة/يوم × 14 يوم ≈ 170 (مقيس 22-09→15-10-2026)

// 🔴 سلسلة السقوف (worker-builder ⑪):
//   ③ ITEMS_PER_QUERY = 25 — **مش مقيس**: الاستعلام فيه lineItems(first:5)+عنوان+عميل
//      وتكلفته الفعلية لسه ما اتقاسش. رقم متحفّظ تحت سقف 50؛ `?action=diag` بيعرض
//      `actualQueryCost` — يتعاد اشتقاقه (700 ÷ تكلفة أوردر واحد) بعد أول قياس حي.
//   مصدر الحالة: شحنات متأجلة مفتوحة (عابرة، عشرات) — مش حالة بتتراكم.
const ITEMS_PER_QUERY = 25;
const MAX_RECORD_ITEMS = 20;     // حارس لصق على record بـ items[]

const STATUSES = ['pending', 'sent', 'replied', 'closed', 'skipped'];
const RESULTS  = ['ok', 'other_day', 'not_requested', 'cancel', 'other', 'no_reply', 'no_wa', 'skip'];
// نتيجة بتقفل المتابعة نهائيًا. أي نتيجة تانية = status 'replied' = «محتاجين تصرّف»
// (ميعاد تاني · مطلبتش تأجيل · إلغاء · رد تاني · مفيش رد) — تاب الصفحة وعدّاد الرئيسية
// بيعدّوا `replied` بالظبط، فمفيش تعريف تاني يفترق.
const CLOSING_RESULTS = new Set(['ok', 'skip', 'no_wa']);

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
  bosta_delivery_follow_up: new Set(['wa_opened', 'followup_result', 'followup_reopen']),
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
// §FOLLOWUP — التعريف الوحيد + جدول الأداة
// ══════════════════════════════════════════════════════════════

// 🔴 SCHEMA_SQL **مصفوفة `.join('\n')`** — عبارة لكل عنصر (درس المستقبل: `db.exec`
//    بيشتغل سطر بسطر). بنستخدم `batch(prepare)` فمفيش اعتماد على ده، بس الشكل
//    ثابت عشان نفس النص يتلزق في D1 Console.
const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS bosta_delivery_followups (id INTEGER PRIMARY KEY AUTOINCREMENT, tracking_number TEXT NOT NULL, event_id INTEGER NOT NULL, order_name TEXT NOT NULL, shopify_order_id TEXT, exception_code TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', result TEXT, note TEXT, sent_by TEXT, sent_at TEXT, result_by TEXT, result_at TEXT, closed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(tracking_number, event_id))`,
  `CREATE INDEX IF NOT EXISTS idx_bdf_status ON bosta_delivery_followups(status)`,
  `CREATE INDEX IF NOT EXISTS idx_bdf_tracking ON bosta_delivery_followups(tracking_number)`,
];
let _schemaReady = false;
async function ensureSchema(db) {
  if (_schemaReady) return;
  await db.batch(SCHEMA_SQL.map(s => db.prepare(s)));
  _schemaReady = true;
}

// ─── §FOLLOWUP::OPEN_LIST_CTE — تعريف «الشحنة المتأجلة المفتوحة» ───
// شحنة **فيها حدث state=47 + exception_code='3' جوّه النافذة**، و**مفيش** عليها
// state IN (45,46,48) ولا bosta_type='RTO' في أي وقت.
// 🔴 مش «آخر حالة = 47/3» — بعد التأجيل الشحنة بتتحرك (24 · 20 · 41)، وده رجّع
//    شحنة واحدة بس من 25 يوم 15-10-2026.
// ⚠️ ?1 = ISO بداية النافذة · الفلتر على received_at عشان يستخدم idx_bwe_received_at.
// ⚠️ pp_count = عدد التأجيلات **جوّه النافذة** مش الكلي.
// ⚠️ `byTracking` بيضيف شرط رقم تتبع (للتحقق في record) على pp قبل التجميع.
// ⛔ ممنوع SELECT * على bosta_webhook_events (فيه raw_payload كبير) — أعمدة صريحة.
function openListCTE({ byTracking = false } = {}) {
  return `WITH pp AS (SELECT tracking_number, MAX(id) last_pp_id, MAX(bosta_timestamp) last_pp_ts, COUNT(*) pp_count FROM bosta_webhook_events WHERE state=${STATE_EXCEPTION} AND exception_code='${POSTPONED_EXCEPTION_CODE}' AND received_at >= ?1${byTracking ? ' AND tracking_number = ?2' : ''} GROUP BY tracking_number), ` +
    `lt AS (SELECT e.tracking_number, e.state, e.description, e.business_reference, e.matched_slot, e.bosta_type, e.delivery_promise_date, e.number_of_attempts, e.shopify_order_id, ROW_NUMBER() OVER (PARTITION BY e.tracking_number ORDER BY e.bosta_timestamp DESC, e.id DESC) rn FROM bosta_webhook_events e JOIN pp USING(tracking_number)), ` +
    `fin AS (SELECT DISTINCT e.tracking_number FROM bosta_webhook_events e JOIN pp USING(tracking_number) WHERE e.state IN (${FINAL_STATES.join(',')}) OR e.bosta_type='RTO'), ` +
    `open_list AS (SELECT lt.*, pp.last_pp_id, pp.last_pp_ts, pp.pp_count FROM lt JOIN pp USING(tracking_number) WHERE lt.rn=1 AND lt.tracking_number NOT IN (SELECT tracking_number FROM fin))`;
}

function windowStartISO(days) {
  return new Date(Date.now() - days * 86400000).toISOString();
}

async function queryOpenList(db, days) {
  const sql = openListCTE() +
    ` SELECT o.*, f.status AS f_status, f.result AS f_result, f.note AS f_note, f.sent_by AS f_sent_by, f.sent_at AS f_sent_at, f.result_by AS f_result_by, f.result_at AS f_result_at ` +
    `FROM open_list o LEFT JOIN bosta_delivery_followups f ON f.tracking_number = o.tracking_number AND f.event_id = o.last_pp_id ` +
    `ORDER BY o.last_pp_ts DESC LIMIT ${MAX_ROWS}`;
  return (await db.prepare(sql).bind(windowStartISO(days)).all()).results;
}

function shapeRow(r, order) {
  return {
    trackingNumber: r.tracking_number,
    eventId:        r.last_pp_id,
    order:          r.business_reference ?? null,
    slot:           r.matched_slot ?? null,
    bostaType:      r.bosta_type ?? null,
    state:          r.state ?? null,
    stateDesc:      r.description ?? null,
    promiseDate:    r.delivery_promise_date ?? null,    // DD-MM-YYYY — الصفحة بتحوّله يدوي (قاعدة ٦)
    attempts:       r.number_of_attempts ?? null,
    lastPostponedAt: r.last_pp_ts ?? null,
    postponeCount:  r.pp_count ?? 1,
    shopifyOrderId: r.shopify_order_id ?? null,
    orderId:        order?.orderId ?? (r.shopify_order_id ? String(r.shopify_order_id).split('/').pop() : null),
    hasOrder:       !!order,
    customer:       order ? { ...order.customer, orderPhone: order.orderPhone } : null,
    total:          order?.total ?? null,
    financial:      order?.financial ?? null,
    cancelled:      order ? order.cancelled : false,
    items:          order?.items ?? [],
    followUp: {
      status:   r.f_status ?? 'pending',
      result:   r.f_result ?? null,
      note:     r.f_note ?? null,
      sentBy:   r.f_sent_by ?? null,
      sentAt:   r.f_sent_at ?? null,
      resultBy: r.f_result_by ?? null,
      resultAt: r.f_result_at ?? null,
    },
  };
}

// ─── §FOLLOWUP::get_followups ───
async function handleGetFollowups(env, url, request) {
  assertEnv(env, 'shopify');
  await ensureSchema(env.DB);
  const days = clampInt(url.searchParams.get('days'), DEFAULT_WINDOW_DAYS, 1, MAX_WINDOW_DAYS);
  const rows = await queryOpenList(env.DB, days);

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
  const counts = { pending: 0, sent: 0, replied: 0, closed: 0, skipped: 0 };
  for (const s of shaped) counts[s.followUp.status] = (counts[s.followUp.status] || 0) + 1;

  return json({
    ok: true, windowDays: days, generatedAt: new Date().toISOString(),
    truncated: rows.length >= MAX_ROWS, cap: MAX_ROWS,
    shopifyError,                       // null = سليم · نص = بيانات العميل غايبة والسبب
    rows: shaped, counts,
    queryCost: costLog,                 // للقياس بس — صفر اعتماد من الواجهة (⑮)
  }, 200, request);
}

// ─── §FOLLOWUP::queue_summary — عدّادات الرئيسية بـ SQL مجمّع بلا شوبيفاي ───
// pending = مالوش صف متابعة أو status=pending · sent = مستني رد
// needsAction = status 'replied' (نتيجة محتاجة تصرّف ولسه ما اتقفلتش)
// ⚠️ الوحدة «شحنة» مش «عميل» — التجميع بالتليفون في الصفحة بس (التليفون من شوبيفاي).
async function handleQueueSummary(env, url, request) {
  await ensureSchema(env.DB);
  const days = clampInt(url.searchParams.get('days'), DEFAULT_WINDOW_DAYS, 1, MAX_WINDOW_DAYS);
  const sql = openListCTE() +
    ` SELECT COUNT(*) AS total, ` +
    `COALESCE(SUM(CASE WHEN f.id IS NULL OR f.status='pending' THEN 1 ELSE 0 END),0) AS pending, ` +
    `COALESCE(SUM(CASE WHEN f.status='sent' THEN 1 ELSE 0 END),0) AS sent, ` +
    `COALESCE(SUM(CASE WHEN f.status='replied' THEN 1 ELSE 0 END),0) AS needs_action ` +
    `FROM open_list o LEFT JOIN bosta_delivery_followups f ON f.tracking_number = o.tracking_number AND f.event_id = o.last_pp_id`;
  const r = await env.DB.prepare(sql).bind(windowStartISO(days)).first();
  return json({
    ok: true, windowDays: days, generatedAt: new Date().toISOString(),
    total: r?.total ?? 0, pending: r?.pending ?? 0, sent: r?.sent ?? 0, needsAction: r?.needs_action ?? 0,
  }, 200, request);
}

// ─── §FOLLOWUP::record ───
// العقد: `items[]` اختياري (مجموعة نفس التليفون) — نتيجة لكل عنصر **بنفس الترتيب**
// في كل الفروع. الواجهة بتطابق بالفهرس.
// idempotent: (tracking_number, event_id) UNIQUE + UPSERT — ضغطتين = صف واحد.
async function recordOne(env, employee, action, item, payload) {
  const { trackingNumber, eventId } = item;
  if (!trackingNumber || !Number.isInteger(eventId))
    return { ok: false, status: 400, error: 'trackingNumber و eventId (رقم صحيح) مطلوبان' };

  // الشحنة لسه في القايمة المفتوحة وعلى نفس حدث التأجيل؟ (أقصى نافذة — مش نافذة العرض)
  const sql = openListCTE({ byTracking: true }) + ' SELECT business_reference, shopify_order_id, last_pp_id FROM open_list';
  const open = await env.DB.prepare(sql).bind(windowStartISO(MAX_WINDOW_DAYS), String(trackingNumber)).first();
  if (!open || open.last_pp_id !== eventId)
    return { ok: false, status: 409, error: 'الشحنة اتقفلت أو جالها تأجيل أحدث — حدّث القايمة' };

  const now = new Date().toISOString();
  const cur = await env.DB.prepare(
    'SELECT status, result, sent_by, sent_at FROM bosta_delivery_followups WHERE tracking_number = ? AND event_id = ?'
  ).bind(trackingNumber, eventId).first();

  // INSERT OR IGNORE ثم UPDATE — الصف بيتعمل مرة واحدة حتى لو الضغطتين اتزامنوا
  await env.DB.prepare(
    `INSERT OR IGNORE INTO bosta_delivery_followups
       (tracking_number, event_id, order_name, shopify_order_id, exception_code, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).bind(trackingNumber, eventId, open.business_reference ?? '—', open.shopify_order_id ?? null,
         POSTPONED_EXCEPTION_CODE, now, now).run();

  let before = cur?.status ?? 'pending', after;
  if (action === 'opened') {
    // لو اتسجّل فتح قبل كده، أو فيه نتيجة أصلاً → ما نرجّعش الحالة للخلف
    if (before === 'pending') {
      await env.DB.prepare(
        `UPDATE bosta_delivery_followups SET status='sent', sent_by=?, sent_at=?, updated_at=? WHERE tracking_number=? AND event_id=? AND status='pending'`
      ).bind(employee, now, now, trackingNumber, eventId).run();
      after = 'sent';
    } else after = before;
  } else if (action === 'result') {
    const { result, note } = payload;
    after = CLOSING_RESULTS.has(result) ? 'closed' : 'replied';
    await env.DB.prepare(
      `UPDATE bosta_delivery_followups SET status=?, result=?, note=?, result_by=?, result_at=?, closed_at=?, updated_at=? WHERE tracking_number=? AND event_id=?`
    ).bind(after, result, note ?? null, employee, now, after === 'closed' ? now : null, now, trackingNumber, eventId).run();
  } else { // reopen
    await env.DB.prepare(
      `UPDATE bosta_delivery_followups SET status='pending', result=NULL, note=NULL, result_by=NULL, result_at=NULL, closed_at=NULL, updated_at=? WHERE tracking_number=? AND event_id=?`
    ).bind(now, trackingNumber, eventId).run();
    after = 'pending';
  }

  // ⚠️ الكتابة في الجدول حصلت — فشل السجل بيرجع logged:false مش 500 (5A ⑦)
  // مفتاح `type` صريح في كل فرع (مفيش متغيّر متفرّع → التشيك يشوف القيم).
  // 🔴 صفر تليفون/اسم/عنوان في الصف.
  const base = {
    tool: TOOL_NAME, employee, orderName: open.business_reference ?? null,
    valueBefore: before, valueAfter: after,
    extra: { trackingNumber, eventId, ...(action === 'result' ? { result: payload.result } : {}) },
  };
  let logged = true;
  try {
    if (action === 'opened')      await writeLog(env.DB, { ...base, type: 'wa_opened' });
    else if (action === 'result') await writeLog(env.DB, { ...base, type: 'followup_result' });
    else                          await writeLog(env.DB, { ...base, type: 'followup_reopen' });
  } catch { logged = false; }

  return { ok: true, status: after, logged };
}

async function handleRecord(env, request) {
  await ensureSchema(env.DB);
  const body = await request.json().catch(() => ({}));
  const employee = String(body.employee || '').trim();
  const action   = String(body.action || '');
  if (!employee) return json({ ok: false, error: 'employee مطلوب' }, 400, request);
  if (!['opened', 'result', 'reopen'].includes(action))
    return json({ ok: false, error: 'action لازم يكون opened أو result أو reopen' }, 400, request);

  const payload = {};
  if (action === 'result') {
    if (!RESULTS.includes(body.result))
      return json({ ok: false, error: `result غير معروف — المسموح: ${RESULTS.join(' · ')}` }, 400, request);
    payload.result = body.result;
    payload.note   = body.note ? String(body.note).slice(0, 500) : null;
  }

  const items = Array.isArray(body.items) && body.items.length
    ? body.items : [{ trackingNumber: body.trackingNumber, eventId: body.eventId }];
  if (items.length > MAX_RECORD_ITEMS)
    return json({ ok: false, error: `الدفعة أكبر من الحد (${items.length} من ${MAX_RECORD_ITEMS})` }, 400, request);

  // نتيجة واحدة لكل عنصر بنفس الترتيب
  const results = [];
  for (const it of items) results.push(await recordOne(env, employee, action, it, payload));

  // 🔴 HTTP 200 دايمًا لما الطلب نفسه سليم — الفشل **جوّه** results[i] (ok:false + status 409/400).
  //    كود 4xx على الرد كله بيخلّي `dcoApi` يرمي «HTTP 409» والواجهة تقول «التسجيل فشل» بدل
  //    «حدّث القايمة»، ويضيّع نتيجة العناصر اللي نجحت في نفس الدفعة.
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

  // D1 + جدول الأداة
  try {
    assertEnv(env);
    await ensureSchema(env.DB);
    const f = await env.DB.prepare('SELECT COUNT(*) AS n FROM bosta_delivery_followups').first();
    push(true, 'D1 — جدول المتابعة', `متصل · ${f?.n ?? 0} صف متابعة`);
  } catch (e) {
    push(false, 'D1 — جدول المتابعة', `FAILED: ${e.message}`, 'binding اسمه `DB` بالحرف في wrangler.toml');
  }

  // 🔴 قراءة تجريبية من جدول المستقبل — أي تغيير في أعمدته يبان هنا قبل الموظف
  try {
    const since = windowStartISO(1);
    const r = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM bosta_webhook_events WHERE state=${STATE_EXCEPTION} AND exception_code='${POSTPONED_EXCEPTION_CODE}' AND received_at >= ?1`
    ).bind(since).first();
    // الاستعلام الكامل نفسه (بيتحقق من كل الأعمدة اللي القايمة معتمدة عليها)
    const open = (await env.DB.prepare(openListCTE() + ' SELECT COUNT(*) AS n FROM open_list').bind(windowStartISO(DEFAULT_WINDOW_DAYS)).first())?.n ?? 0;
    push(true, 'قراءة bosta_webhook_events', `${r?.n ?? 0} تأجيل (كود 3) آخر 24 ساعة · ${open} شحنة مفتوحة في نافذة ${DEFAULT_WINDOW_DAYS} أيام`);
  } catch (e) {
    push(false, 'قراءة bosta_webhook_events', `FAILED: ${e.message}`,
         'الجدول ده تبع Bosta-Webhook-Status-Receiver — لو عمود اتغيّر هناك القايمة هنا بتقع. الأعمدة المعتمدة: id · tracking_number · state · exception_code · bosta_timestamp · received_at · description · business_reference · matched_slot · bosta_type · delivery_promise_date · number_of_attempts · shopify_order_id');
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
        openListCTE() + ' SELECT shopify_order_id FROM open_list WHERE shopify_order_id IS NOT NULL ORDER BY last_pp_ts DESC LIMIT 1'
      ).bind(windowStartISO(MAX_WINDOW_DAYS)).all();
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
      if (action === 'get_followups') return await handleGetFollowups(env, url, request);
      if (action === 'queue_summary') return await handleQueueSummary(env, url, request);
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
