// Vercel Serverless Function: /api/records
// 「円卓に投げると、記録してグラフになる」の記録API（仕様メモ 2026-09-22）。
//   GET    /api/records?meta=1                          … 記録できる指標の定義（カテゴリ・項目・単位）
//   GET    /api/records?category=X&from=YYYY-MM&to=YYYY-MM … 記録の一覧（period 昇順）
//   POST   /api/records  {category, period, items:[{item,value,unit}], source, raw_text, overwrite}
//            … 保存（同じ period の記録が既にあり overwrite が無ければ state:"exists" を返して確認を促す）
//   DELETE /api/records  {id}                            … 1件削除
// 認証: PORTAL のログイン（Supabase Auth セッション）＋ 管理者ロール（社長・秘書）のみ。
// データ: PORTAL 自身の Supabase の public.metrics_record（RLS 有効・ポリシー無し＝service_role のみ）。
import { CATEGORIES, DEFAULT_TENANT, categoryOf, normPeriod } from "./_lib/recordCategories.js";

const ALLOWED_ROLES = ["社長", "秘書"];
const TABLE = "metrics_record";

function applyCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// ---- PORTAL 認証（api/metrics.js と同じ流儀）------------------------------------
function svc() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const headers = { apikey: key, "Content-Type": "application/json" };
  if (/^eyJ/.test(String(key))) headers.Authorization = "Bearer " + key;
  return { url, key, headers };
}

async function portalUser(token) {
  const url = process.env.SUPABASE_URL;
  const anon =
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anon || !token) return null;
  const res = await fetch(url + "/auth/v1/user", { headers: { apikey: anon, Authorization: "Bearer " + token } });
  if (!res.ok) return null;
  try { return await res.json(); } catch (e) { return null; }
}

async function memberForUser(user) {
  const s = svc();
  if (!s || !user) return null;
  const sel = "select=id,name,role,email,auth_user_id&limit=1";
  if (user.id) {
    const q1 = await fetch(s.url + "/rest/v1/members?" + sel + "&auth_user_id=eq." + encodeURIComponent(user.id), { headers: s.headers });
    if (q1.ok) { const rows = await q1.json(); if (Array.isArray(rows) && rows[0]) return rows[0]; }
  }
  const email = String(user.email || "").trim().toLowerCase();
  if (!email) return null;
  const q2 = await fetch(s.url + "/rest/v1/members?" + sel + "&email=eq." + encodeURIComponent(email), { headers: s.headers });
  if (!q2.ok) return null;
  const rows = await q2.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function requireAdmin(req, res) {
  const auth = String(req.headers.authorization || "");
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) { res.status(401).json({ ok: false, error: "login_required" }); return null; }
  const user = await portalUser(token);
  if (!user) { res.status(401).json({ ok: false, error: "invalid_session" }); return null; }
  const member = await memberForUser(user);
  if (!member || !ALLOWED_ROLES.includes(String(member.role || ""))) {
    res.status(403).json({ ok: false, error: "forbidden" }); return null;
  }
  return member;
}

// ---- ユーティリティ ---------------------------------------------------------------
function parseBody(req) {
  const b = req.body;
  if (!b) return {};
  if (typeof b === "string") { try { return JSON.parse(b); } catch (e) { return {}; } }
  return b;
}

// "1,234位" / "98.5%" / "３２" のような表記も数値にする（全角数字・桁区切り・単位を除去）
function toNumber(v) {
  if (typeof v === "number") return isFinite(v) ? v : NaN;
  let s = String(v == null ? "" : v).trim();
  s = s.replace(/[０-９．－]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  s = s.replace(/[,，\s]/g, "").replace(/[^0-9.+-]/g, "");
  if (!s || s === "-" || s === "+") return NaN;
  const n = Number(s);
  return isFinite(n) ? n : NaN;
}

function fmtNum(n) {
  n = Number(n);
  if (!isFinite(n)) return "–";
  return Number.isInteger(n) ? n.toLocaleString("ja-JP") : n.toLocaleString("ja-JP", { maximumFractionDigits: 2 });
}

function periodLabel(p, periodType) {
  const m = String(p).match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
  if (!m) return p;
  return periodType === "day" && m[3] ? `${m[1]}年${Number(m[2])}月${Number(m[3])}日` : `${m[1]}年${Number(m[2])}月`;
}

async function pg(s, path, init) {
  const r = await fetch(s.url + "/rest/v1/" + path, Object.assign({ headers: s.headers }, init || {}));
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  return { ok: r.ok, status: r.status, data, text };
}

// ---- 一覧 ---------------------------------------------------------------------------
async function handleList(req, res, s) {
  const q = req.query || {};
  const category = String(q.category || "").trim();
  const params = new URLSearchParams();
  params.set("select", "id,category,item,period,value,unit,source,confirmed_by,created_at,updated_at");
  params.set("tenant_id", "eq." + DEFAULT_TENANT);
  if (category) params.set("category", "eq." + category);
  const from = String(q.from || "").trim(), to = String(q.to || "").trim();
  if (from) params.append("period", "gte." + from);
  if (to) params.append("period", "lte." + to);
  params.set("order", "period.asc,item.asc");
  params.set("limit", String(Math.min(5000, Math.max(1, Number(q.limit) || 2000))));
  const r = await pg(s, TABLE + "?" + params.toString());
  if (!r.ok) return res.status(502).json({ ok: false, error: "db_read_failed", detail: r.text.slice(0, 300) });
  return res.status(200).json({ ok: true, rows: Array.isArray(r.data) ? r.data : [], categories: CATEGORIES, tenant: DEFAULT_TENANT });
}

// ---- 保存（確認済みの内容のみ。同 period の既存があれば overwrite 指定が要る）--------
async function handleSave(req, res, s, member) {
  const b = parseBody(req);
  const category = String(b.category || "").trim();
  const cat = categoryOf(category);
  if (!cat) return res.status(400).json({ ok: false, error: "unknown_category", categories: Object.keys(CATEGORIES) });
  const period = normPeriod(b.period, cat.periodType);
  if (!period) return res.status(400).json({ ok: false, error: "bad_period", detail: cat.periodType === "day" ? "YYYY-MM-DD で指定してください" : "YYYY-MM で指定してください" });

  const allowedItems = new Map(cat.items.map((it) => [it.key, it]));
  const items = [];
  const rejected = [];
  for (const raw of Array.isArray(b.items) ? b.items : []) {
    const key = String((raw && raw.item) || "").trim();
    const def = allowedItems.get(key);
    const value = toNumber(raw && raw.value);
    if (!def) { if (key) rejected.push({ item: key, reason: "unknown_item" }); continue; }
    if (!isFinite(value)) { rejected.push({ item: key, reason: "not_a_number" }); continue; }
    items.push({ item: key, value, unit: String((raw && raw.unit) || def.unit || "").trim().slice(0, 10) });
  }
  if (!items.length) return res.status(400).json({ ok: false, error: "no_items", rejected });

  const source = ["email", "manual", "entaku"].includes(String(b.source || "")) ? String(b.source) : "manual";
  const rawText = String(b.raw_text || "").slice(0, 20000);
  const overwrite = b.overwrite === true;

  // 既存チェック（同 tenant/category/period で、今回の item に重なるもの）
  const chk = new URLSearchParams();
  chk.set("select", "id,item,value,unit,updated_at");
  chk.set("tenant_id", "eq." + DEFAULT_TENANT);
  chk.set("category", "eq." + category);
  chk.set("period", "eq." + period);
  chk.set("item", "in.(" + items.map((it) => '"' + it.item.replace(/"/g, '\\"') + '"').join(",") + ")");
  const ex = await pg(s, TABLE + "?" + chk.toString());
  if (!ex.ok) return res.status(502).json({ ok: false, error: "db_read_failed", detail: ex.text.slice(0, 300) });
  const existing = Array.isArray(ex.data) ? ex.data : [];
  if (existing.length && !overwrite) {
    return res.status(200).json({
      ok: false, state: "exists", category, period, periodLabel: periodLabel(period, cat.periodType),
      existing: existing.map((r) => ({ item: r.item, value: Number(r.value), unit: r.unit || "" })),
      detail: periodLabel(period, cat.periodType) + " の記録が既にあります。上書きしますか？",
    });
  }

  // upsert（unique: tenant_id,category,item,period）
  const now = new Date().toISOString();
  const rows = items.map((it) => ({
    tenant_id: DEFAULT_TENANT, category, item: it.item, period, value: it.value, unit: it.unit,
    source, raw_text: rawText || null, confirmed_by: String(member.name || member.email || "").slice(0, 80), updated_at: now,
  }));
  const up = await pg(s, TABLE + "?on_conflict=tenant_id,category,item,period", {
    method: "POST",
    headers: Object.assign({}, s.headers, { Prefer: "resolution=merge-duplicates,return=representation" }),
    body: JSON.stringify(rows),
  });
  if (!up.ok) return res.status(502).json({ ok: false, error: "db_write_failed", detail: up.text.slice(0, 300) });

  // 前回（直前の period）との比較
  const prevQ = new URLSearchParams();
  prevQ.set("select", "item,period,value,unit");
  prevQ.set("tenant_id", "eq." + DEFAULT_TENANT);
  prevQ.set("category", "eq." + category);
  prevQ.set("period", "lt." + period);
  prevQ.set("order", "period.desc");
  prevQ.set("limit", String(cat.items.length * 12));
  const pv = await pg(s, TABLE + "?" + prevQ.toString());
  const prevRows = pv.ok && Array.isArray(pv.data) ? pv.data : [];
  const compare = items.map((it) => {
    const def = allowedItems.get(it.item) || {};
    const prev = prevRows.find((r) => r.item === it.item);
    if (!prev) return { item: it.item, value: it.value, unit: it.unit, prev_period: null, prev_value: null, diff: null, better: null };
    const diff = it.value - Number(prev.value);
    const better = diff === 0 ? null : (def.lowerIsBetter ? diff < 0 : diff > 0);
    return { item: it.item, value: it.value, unit: it.unit, prev_period: prev.period, prev_value: Number(prev.value), diff, better };
  });
  const parts = compare.map((c) => {
    const base = `${c.item} ${fmtNum(c.value)}${c.unit}`;
    if (c.prev_period == null) return base + "（初回）";
    const sign = c.diff > 0 ? "+" : c.diff < 0 ? "−" : "±";
    const tag = c.better === null ? "変わらず" : (c.better ? "改善" : "悪化");
    return `${base}（${periodLabel(c.prev_period, cat.periodType)}比 ${sign}${fmtNum(Math.abs(c.diff))}${c.unit}・${tag}）`;
  });
  const summary = `${periodLabel(period, cat.periodType)} の「${cat.label}」を記録しました。` + parts.join("、") + "。";

  return res.status(200).json({
    ok: true, state: "saved", category, period, periodLabel: periodLabel(period, cat.periodType),
    saved: Array.isArray(up.data) ? up.data : rows, overwritten: existing.length, rejected, compare, summary,
  });
}

// ---- 削除 ---------------------------------------------------------------------------
async function handleDelete(req, res, s) {
  const b = parseBody(req);
  const id = Number(b.id || (req.query && req.query.id));
  if (!isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "bad_id" });
  const r = await pg(s, TABLE + "?id=eq." + id + "&tenant_id=eq." + DEFAULT_TENANT, {
    method: "DELETE", headers: Object.assign({}, s.headers, { Prefer: "return=representation" }),
  });
  if (!r.ok) return res.status(502).json({ ok: false, error: "db_delete_failed", detail: r.text.slice(0, 300) });
  return res.status(200).json({ ok: true, deleted: Array.isArray(r.data) ? r.data.length : 0 });
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    if (req.method === "GET" && req.query && String(req.query.meta || "") === "1") {
      return res.status(200).json({ ok: true, categories: CATEGORIES, tenant: DEFAULT_TENANT });
    }
    const member = await requireAdmin(req, res);
    if (!member) return;
    const s = svc();
    if (!s) return res.status(500).json({ ok: false, error: "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY is not configured" });
    if (req.method === "GET") return await handleList(req, res, s);
    if (req.method === "POST") return await handleSave(req, res, s, member);
    if (req.method === "DELETE") return await handleDelete(req, res, s);
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "server_error", detail: String((e && e.message) || e).slice(0, 300) });
  }
}
