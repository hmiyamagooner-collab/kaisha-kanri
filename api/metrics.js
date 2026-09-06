// Vercel Serverless Function: /api/metrics
// プロダクト（RELA 等）の集計ビューを service_role で読む「読み取り専用」API。
//   - ブラウザからは product / view / from / to だけ受け取る
//   - service_role キーは Vercel 環境変数にのみ置く（ブラウザには絶対に出さない）
//   - PORTAL のログイン必須（Supabase Auth セッションを検証）＋ 管理者ロールのみ
//   - 集計はプロダクト側の analytics ビューで完結。ここでは加工しない
//
// 環境変数:
//   SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY … PORTAL 自身（認証・members）
//   METRICS_RELA_URL / METRICS_RELA_SERVICE_KEY                  … RELA 本番（読み取り元）
//   （将来）METRICS_LEO_URL / METRICS_LEO_SERVICE_KEY            … ゆうしゃレオ

// 閲覧を許可するロール（既存ロール体系。管理者相当）
const ALLOWED_ROLES = ["社長", "秘書"];

// product 名 → 読み取り元 Supabase（URL / service_role キー）の対応表
function productSource(product) {
  const map = {
    rela: { url: process.env.METRICS_RELA_URL, key: process.env.METRICS_RELA_SERVICE_KEY },
    leo: { url: process.env.METRICS_LEO_URL, key: process.env.METRICS_LEO_SERVICE_KEY },
  };
  const s = map[product];
  if (!s || !s.url || !s.key) return null;
  return s;
}

// view 名 → ビュー名・日付列・並び順
const VIEWS = {
  daily: { name: "v_daily_funnel", dateCol: "day", order: "day.asc" },
  utm: { name: "v_utm_funnel", dateCol: "first_day", order: "first_day.desc" },
  retention: { name: "v_retention", dateCol: "cohort_day", order: "cohort_day.asc" },
};

// ---- PORTAL 認証 -------------------------------------------------------------
async function portalUser(token) {
  const url = process.env.SUPABASE_URL;
  const anon =
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anon || !token) return null;
  const res = await fetch(url + "/auth/v1/user", {
    headers: { apikey: anon, Authorization: "Bearer " + token },
  });
  if (!res.ok) return null;
  try {
    return await res.json();
  } catch (e) {
    return null;
  }
}

async function memberForUser(user) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !user) return null;
  const headers = { apikey: key, Authorization: "Bearer " + key };
  if (user.id) {
    const q1 = await fetch(
      url +
        "/rest/v1/members?select=id,name,role,email,auth_user_id&auth_user_id=eq." +
        encodeURIComponent(user.id) +
        "&limit=1",
      { headers }
    );
    if (q1.ok) {
      const rows = await q1.json();
      if (Array.isArray(rows) && rows[0]) return rows[0];
    }
  }
  const email = String(user.email || "").trim().toLowerCase();
  if (!email) return null;
  const q2 = await fetch(
    url +
      "/rest/v1/members?select=id,name,role,email,auth_user_id&email=eq." +
      encodeURIComponent(email) +
      "&limit=1",
    { headers }
  );
  if (!q2.ok) return null;
  const rows = await q2.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

// ---- 集計ビュー読み取り（プロダクト側 analytics スキーマ・service_role） -----------
async function readView(src, view, from, to) {
  const v = VIEWS[view];
  const params = new URLSearchParams();
  params.set("select", "*");
  params.set("order", v.order);
  if (from) params.append(v.dateCol, "gte." + from);
  if (to) params.append(v.dateCol, "lte." + to);
  const res = await fetch(src.url + "/rest/v1/" + v.name + "?" + params.toString(), {
    headers: {
      apikey: src.key,
      Authorization: "Bearer " + src.key,
      // analytics スキーマのビューを読む（PostgREST の schema 指定）
      "Accept-Profile": "analytics",
    },
  });
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, detail: text.slice(0, 300) };
  }
  let rows = [];
  try {
    rows = text ? JSON.parse(text) : [];
  } catch (e) {
    rows = [];
  }
  return { ok: true, rows };
}

// YYYY-MM-DD の緩い検証
function safeDate(s) {
  s = String(s || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    // 認証
    const auth = String(req.headers.authorization || "");
    const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
    if (!token) return res.status(401).json({ ok: false, error: "login_required" });
    const user = await portalUser(token);
    if (!user) return res.status(401).json({ ok: false, error: "invalid_session" });
    const member = await memberForUser(user);
    if (!member || !ALLOWED_ROLES.includes(String(member.role || ""))) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }

    // 入力
    const q = req.query || {};
    const product = String(q.product || "rela").toLowerCase();
    const view = String(q.view || "daily").toLowerCase();
    const from = safeDate(q.from);
    const to = safeDate(q.to);

    if (!VIEWS[view]) return res.status(400).json({ ok: false, error: "bad_view" });
    const src = productSource(product);
    if (!src) return res.status(400).json({ ok: false, error: "unknown_product" });

    const out = await readView(src, view, from, to);
    if (!out.ok) {
      return res.status(502).json({ ok: false, error: "source_read_failed", detail: out.detail });
    }
    return res.status(200).json({ ok: true, product, view, from, to, rows: out.rows });
  } catch (e) {
    return res.status(500).json({ error: "metrics_failed", detail: String(e?.message || e).slice(0, 200) });
  }
}
