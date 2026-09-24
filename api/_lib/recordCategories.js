// 記録できる指標セット（カテゴリ）の定義。業種に縛られない汎用の仕組み。
//  - BUILTIN … コード内の既定（DBが無くても最低限動く。最初の用途＝デイサービス全国ランキング）
//  - DB      … PORTAL Supabase の public.metrics_category。画面「記録とグラフ」から社長・秘書が追加・編集する
//  同じ id があれば DB が優先（既定を上書きできる）。enabled=false の行は非表示。
//  API(/api/records)・円卓(api/openai.js)・画面(records.html は /api/records?meta=1) が同じ loadCategories() を使う。
export const DEFAULT_TENANT = "gooner";
const CACHE_MS = 30000;

export const BUILTIN = {
  dayservice_ranking: {
    label: "リハプライド蘇我 全国ランキング",
    periodType: "month",
    hint: "弊社運営のデイサービス「リハプライド蘇我」に毎月メールで届く全国ランキングの本文（この施設の順位だけを追う）",
    items: [
      { key: "全国順位",     unit: "位", lowerIsBetter: true, aliases: ["全国ランキング", "総合順位"] },
      { key: "都道府県順位", unit: "位", lowerIsBetter: true, aliases: ["県内順位", "都内順位", "府内順位", "道内順位", "千葉県内順位", "東京都内順位", "県順位", "エリア順位"] },
      { key: "利用者数",     unit: "人", aliases: ["延べ利用者数", "月間延べ利用者数", "月間利用者数", "利用者"] },
      { key: "稼働率",       unit: "%",  aliases: ["稼動率", "利用率"] },
    ],
  },
  rehapride_monthly: {
    label: "リハプライド蘇我 月次実績",
    periodType: "month",
    hint: "弊社運営のデイサービス「リハプライド蘇我」の毎月の売上・実績報告（売上の目標は月400万円。ランキングのメールとは別）",
    items: [
      { key: "売上",     unit: "円", target: 4000000, aliases: ["売上高", "月間売上", "総売上", "売上金額", "収入", "介護報酬"] },
      { key: "利用者数", unit: "人", aliases: ["延べ利用者数", "月間延べ利用者数", "利用者", "延人数", "延べ人数"] },
      { key: "稼働率",   unit: "%",  aliases: ["稼動率", "利用率"] },
    ],
  },
};

// 項目名の緩やかな照合（メール側の表記揺れを吸収）。完全一致 → 別名一致 → 記号除去後の包含 の順
function normKey(s) {
  return String(s || "").replace(/[\s　（）()【】\[\]「」:：・]/g, "").toLowerCase();
}
export function matchItem(cat, rawKey) {
  if (!cat || !rawKey) return null;
  const raw = String(rawKey).trim();
  const nraw = normKey(raw);
  if (!nraw) return null;
  for (const it of cat.items) if (it.key === raw) return it;
  for (const it of cat.items) {
    if (normKey(it.key) === nraw) return it;
    for (const a of it.aliases || []) if (normKey(a) === nraw) return it;
  }
  for (const it of cat.items) {
    const nk = normKey(it.key);
    if (nk.length >= 2 && (nraw.includes(nk) || nk.includes(nraw))) return it;
    for (const a of it.aliases || []) { const na = normKey(a); if (na.length >= 2 && (nraw.includes(na) || na.includes(nraw))) return it; }
  }
  return null;
}

// 入力（コード既定 / DB行 / 画面からのPOST）を同じ形に正規化する。不正なら null
export function normalizeCategory(id, raw) {
  id = String(id || "").trim().toLowerCase();
  if (!/^[a-z0-9_]{2,40}$/.test(id)) return null;
  raw = raw || {};
  const periodType = (raw.periodType === "day" || raw.period_type === "day") ? "day" : "month";
  const seen = new Set();
  const items = [];
  for (const it of Array.isArray(raw.items) ? raw.items : []) {
    const key = String((it && it.key) || "").trim().slice(0, 30);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    let aliases = it && it.aliases;
    if (typeof aliases === "string") aliases = aliases.split(/[,、，\n]/);
    aliases = (Array.isArray(aliases) ? aliases : []).map((a) => String(a || "").trim().slice(0, 30)).filter((a) => a && a !== key);
    aliases = [...new Set(aliases)].slice(0, 12);
    // 目標値（任意）。"4,000,000" のような桁区切りも許す。空なら null
    const tv = it && it.target;
    let target = null;
    if (tv !== "" && tv != null) { const n = Number(String(tv).replace(/[,，\s]/g, "")); if (isFinite(n)) target = n; }
    items.push({
      key,
      unit: String((it && it.unit) || "").trim().slice(0, 10),
      lowerIsBetter: !!(it && (it.lowerIsBetter || it.lower_is_better)),
      aliases,
      target,
    });
    if (items.length >= 12) break;
  }
  if (!items.length) return null;
  const label = String(raw.label || "").trim().slice(0, 60) || id;
  return { id, label, periodType, hint: String(raw.hint || "").trim().slice(0, 200), items };
}

// PORTAL の service_role キー（名前の揺れを吸収。値はどれか1つ設定されていればよい）
export function serviceKey() {
  return String(
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICEROLE_KEY || ""
  ).trim();
}

// DB へのアクセス方法を決める。
//  service … Vercel に service_role キーがある（RLS を通らない。従来どおり）
//  user    … キーが無いので、ログイン中ユーザーのトークン＋anon キーで RLS（管理者のみ許可）を通す
export function dbAuth(userToken) {
  const url = process.env.SUPABASE_URL;
  if (!url) return null;
  const sk = serviceKey();
  if (sk) {
    const headers = { apikey: sk, "Content-Type": "application/json" };
    if (/^eyJ/.test(sk)) headers.Authorization = "Bearer " + sk;
    return { url, mode: "service", headers };
  }
  const anon = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || "";
  const t = String(userToken || "").trim();
  if (anon && t) return { url, mode: "user", headers: { apikey: anon, Authorization: "Bearer " + t, "Content-Type": "application/json" } };
  return null;
}

let cache = { at: 0, cats: null };
export function invalidateCategories() { cache = { at: 0, cats: null }; }
// 直近の DB 読み込みの診断情報（秘密は含めない。/api/records?meta=1&debug=1 で確認）
export let lastLoadDiag = { at: 0 };

// 既定 + DB を合成した { id: 定義 } を返す（30秒キャッシュ。DB不通時は既定のみ）
export async function loadCategories(opts) {
  opts = opts || {};
  const auth = dbAuth(opts.userToken);
  const cacheable = !!(auth && auth.mode === "service"); // ユーザー経路は人ごとに結果が違い得るのでキャッシュしない
  if (cacheable && !opts.force && cache.cats && Date.now() - cache.at < CACHE_MS) return cache.cats;
  const out = {};
  for (const [id, c] of Object.entries(BUILTIN)) {
    const n = normalizeCategory(id, c);
    if (n) out[id] = Object.assign(n, { builtin: true, custom: false, sort: 0 });
  }
  const k = serviceKey();
  lastLoadDiag = {
    at: Date.now(), hasUrl: !!process.env.SUPABASE_URL, mode: auth ? auth.mode : "none",
    keyKind: !k ? "none" : (/^eyJ/.test(k) ? "jwt" : (/^sb_/.test(k) ? k.slice(0, 9) : "other")),
    // 設定済みの環境変数「名」だけ（値は出さない）。キー名の食い違いを見つけるため
    envNames: Object.keys(process.env).filter((n) => /SUPABASE|^SB_|SERVICE_ROLE|SECRET_KEY/i.test(n)).sort(),
    status: null, rows: null, error: null, bodyHead: null,
  };
  if (auth) {
    try {
      const r = await fetch(auth.url + "/rest/v1/metrics_category?select=id,label,period_type,hint,items,sort,enabled&tenant_id=eq." +
        encodeURIComponent(DEFAULT_TENANT) + "&order=sort.asc,label.asc", { headers: auth.headers });
      lastLoadDiag.status = r.status;
      if (!r.ok) { lastLoadDiag.bodyHead = String(await r.text().catch(() => "")).slice(0, 200); }
      if (r.ok) {
        const rows = await r.json();
        lastLoadDiag.rows = Array.isArray(rows) ? rows.length : -1;
        for (const row of Array.isArray(rows) ? rows : []) {
          const id = String(row.id || "").toLowerCase();
          if (row.enabled === false) { delete out[id]; continue; }
          const n = normalizeCategory(id, { label: row.label, periodType: row.period_type, hint: row.hint, items: row.items });
          if (n) out[n.id] = Object.assign(n, { builtin: !!(out[n.id] && out[n.id].builtin), custom: true, sort: Number(row.sort) || 0 });
        }
      }
    } catch (e) { lastLoadDiag.error = String((e && e.message) || e).slice(0, 200); /* DB不通時は既定のみで続行 */ }
  }
  if (cacheable) cache = { at: Date.now(), cats: out };
  return out;
}

export function categoryOf(cats, id) {
  return (cats && cats[String(id || "").trim().toLowerCase()]) || null;
}

// 期間文字列の検証（'YYYY-MM' または 'YYYY-MM-DD'）
export function normPeriod(s, periodType) {
  s = String(s || "").trim().replace(/\//g, "-");
  const m = s.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/);
  if (!m) return "";
  const y = m[1], mo = String(m[2]).padStart(2, "0"), d = m[3] ? String(m[3]).padStart(2, "0") : "";
  if (periodType === "day") return d ? `${y}-${mo}-${d}` : "";
  return `${y}-${mo}`;
}

// 円卓のシステムプロンプト末尾に載せる説明文（カテゴリ名・手がかり・項目・単位）
export function categoriesPromptBlock(cats) {
  const ids = Object.keys(cats || {});
  if (!ids.length) return "";
  const lines = ["【記録できる指標（record の category と項目。ここに無い指標は記録できない＝record を付けず、『記録とグラフ』で指標セットを追加できると案内）】"];
  for (const id of ids) {
    const c = cats[id];
    lines.push(`・category="${id}"（${c.label}）` + (c.hint ? `｜手がかり: ${c.hint}` : "") +
      `｜period=${c.periodType === "day" ? "YYYY-MM-DD" : "YYYY-MM"}｜項目: ` +
      c.items.map((it) => `${it.key}${it.unit ? "(" + it.unit + ")" : ""}` +
        (it.target != null ? `［目標 ${it.target}${it.unit || ""}］` : "") +
        (it.aliases && it.aliases.length ? `〔別名: ${it.aliases.slice(0, 6).join("・")}〕` : "")).join(" / "));
  }
  lines.push("※ record.items の item には上の項目名をそのまま使う（本文の表記が別名や似た言い方でも、対応する項目名に読み替える。例: 東京都内順位→都道府県順位、月間延べ利用者数→利用者数）。");
  return lines.join("\n");
}

// 記録済みの指標（直近400件・新しい順）を取得。無ければ []
export async function loadRecentRecords(userToken) {
  const auth = dbAuth(userToken);
  if (!auth) return [];
  try {
    const r = await fetch(auth.url + "/rest/v1/metrics_record?select=category,item,period,value,unit&tenant_id=eq." +
      encodeURIComponent(DEFAULT_TENANT) + "&order=period.desc,item.asc&limit=400", { headers: auth.headers });
    if (!r.ok) return [];
    const rows = await r.json();
    return Array.isArray(rows) ? rows.map((x) => Object.assign({}, x, { value: Number(x.value) })) : [];
  } catch (e) { return []; }
}

function fmtN(n) {
  n = Number(n);
  if (!isFinite(n)) return "–";
  return Number.isInteger(n) ? n.toLocaleString("ja-JP") : n.toLocaleString("ja-JP", { maximumFractionDigits: 2 });
}

// 読み取った record の各項目について、前回比・目標比をサーバー側で確定計算する（AIに引き算をさせない）
export function computeComparisons(record, cat, rows) {
  if (!record || !cat) return [];
  return (record.items || []).map((it) => {
    const def = cat.items.find((d) => d.key === it.item) || {};
    const out = { item: it.item, value: it.value, unit: it.unit || def.unit || "", prev_period: null, prev_value: null, diff: null, better: null, target: null, target_diff: null, achievement: null };
    const prev = (rows || []).filter((r) => r.category === record.category && r.item === it.item && (!record.period || r.period < record.period))
      .sort((a, b) => (a.period < b.period ? 1 : -1))[0];
    if (prev) {
      out.prev_period = prev.period; out.prev_value = prev.value; out.diff = it.value - prev.value;
      out.better = out.diff === 0 ? null : (def.lowerIsBetter ? out.diff < 0 : out.diff > 0);
    }
    if (def.target != null && isFinite(def.target)) {
      out.target = Number(def.target); out.target_diff = it.value - out.target;
      out.achievement = def.lowerIsBetter ? (it.value > 0 ? Math.round((out.target / it.value) * 1000) / 10 : null)
                                          : (out.target > 0 ? Math.round((it.value / out.target) * 1000) / 10 : null);
    }
    return out;
  });
}

// 確定計算の結果を、紬への指示に載せる文にする（この数字をそのまま報告させる）
export function comparisonsText(record, cat, comps) {
  const lines = [`■ ${cat.label}（${record.period || "期間未定"}）`];
  for (const c of comps) {
    const parts = [`${c.item} ${fmtN(c.value)}${c.unit}`];
    if (c.prev_period) {
      const s = c.diff > 0 ? "+" : c.diff < 0 ? "−" : "±";
      parts.push(`前回 ${c.prev_period}=${fmtN(c.prev_value)}${c.unit} → ${s}${fmtN(Math.abs(c.diff))}${c.unit}` + (c.better === null ? "（変わらず）" : c.better ? "（改善）" : "（悪化）"));
    } else parts.push("前回: 未記録（比較不可）");
    if (c.target != null) {
      const s = c.target_diff > 0 ? "+" : c.target_diff < 0 ? "−" : "±";
      parts.push(`目標 ${fmtN(c.target)}${c.unit} → ${s}${fmtN(Math.abs(c.target_diff))}${c.unit}` + (c.achievement != null ? `・達成率 ${c.achievement}%` : ""));
    } else parts.push("目標: 未設定");
    lines.push("・" + parts.join("｜"));
  }
  if (record.missing && record.missing.length) lines.push("・読み取れなかった項目: " + record.missing.join("、"));
  return lines.join("\n");
}

// 記録済みの指標（直近）を円卓の文脈に載せる文（分析・前月比・目標との差を、記録にある数字だけで答えさせる）
export function recentRecordsBlock(cats, rows) {
  if (!cats || !Array.isArray(rows) || !rows.length) return "";
  try {
    const by = {};
    for (const row of rows) {
      const c = cats[row.category]; if (!c) continue;
      by[row.category] = by[row.category] || {};
      (by[row.category][row.item] = by[row.category][row.item] || []).push(row);
    }
    const lines = ["【記録済みの指標（直近・新しい順）。分析・前月比・目標との差は、ここにある数字だけを根拠に答える。無い期間は「未記録」と言い、推測で補わない】"];
    for (const [cid, items] of Object.entries(by)) {
      const c = cats[cid];
      lines.push(`■ ${c.label}`);
      for (const [item, list] of Object.entries(items)) {
        const def = c.items.find((i) => i.key === item);
        const tgt = def && def.target != null ? `（目標 ${def.target}${def.unit || ""}）` : "";
        lines.push(`・${item}${tgt}: ` + list.slice(0, 8).map((x) => `${x.period}=${x.value}${x.unit || ""}`).join(", "));
      }
    }
    return lines.join("\n");
  } catch (e) { return ""; }
}
