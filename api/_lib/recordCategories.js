// 記録できる指標セット（カテゴリ）の定義。業種に縛られない汎用の仕組み。
//  - BUILTIN … コード内の既定（DBが無くても最低限動く。最初の用途＝デイサービス全国ランキング）
//  - DB      … PORTAL Supabase の public.metrics_category。画面「記録とグラフ」から社長・秘書が追加・編集する
//  同じ id があれば DB が優先（既定を上書きできる）。enabled=false の行は非表示。
//  API(/api/records)・円卓(api/openai.js)・画面(records.html は /api/records?meta=1) が同じ loadCategories() を使う。
export const DEFAULT_TENANT = "gooner";
const CACHE_MS = 30000;

export const BUILTIN = {
  dayservice_ranking: {
    label: "デイサービス 全国ランキング",
    periodType: "month",
    hint: "毎月メールで届く全国ランキングの本文",
    items: [
      { key: "全国順位",     unit: "位", lowerIsBetter: true },
      { key: "都道府県順位", unit: "位", lowerIsBetter: true },
      { key: "利用者数",     unit: "人" },
      { key: "稼働率",       unit: "%" },
    ],
  },
};

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
    items.push({
      key,
      unit: String((it && it.unit) || "").trim().slice(0, 10),
      lowerIsBetter: !!(it && (it.lowerIsBetter || it.lower_is_better)),
    });
    if (items.length >= 12) break;
  }
  if (!items.length) return null;
  const label = String(raw.label || "").trim().slice(0, 60) || id;
  return { id, label, periodType, hint: String(raw.hint || "").trim().slice(0, 200), items };
}

let cache = { at: 0, cats: null };
export function invalidateCategories() { cache = { at: 0, cats: null }; }

// 既定 + DB を合成した { id: 定義 } を返す（30秒キャッシュ。DB不通時は既定のみ）
export async function loadCategories(opts) {
  if (!(opts && opts.force) && cache.cats && Date.now() - cache.at < CACHE_MS) return cache.cats;
  const out = {};
  for (const [id, c] of Object.entries(BUILTIN)) {
    const n = normalizeCategory(id, c);
    if (n) out[id] = Object.assign(n, { builtin: true, custom: false, sort: 0 });
  }
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && key) {
    try {
      const headers = { apikey: key };
      if (/^eyJ/.test(String(key))) headers.Authorization = "Bearer " + key;
      const r = await fetch(url + "/rest/v1/metrics_category?select=id,label,period_type,hint,items,sort,enabled&tenant_id=eq." +
        encodeURIComponent(DEFAULT_TENANT) + "&order=sort.asc,label.asc", { headers });
      if (r.ok) {
        const rows = await r.json();
        for (const row of Array.isArray(rows) ? rows : []) {
          const id = String(row.id || "").toLowerCase();
          if (row.enabled === false) { delete out[id]; continue; }
          const n = normalizeCategory(id, { label: row.label, periodType: row.period_type, hint: row.hint, items: row.items });
          if (n) out[n.id] = Object.assign(n, { builtin: !!(out[n.id] && out[n.id].builtin), custom: true, sort: Number(row.sort) || 0 });
        }
      }
    } catch (e) { /* DB不通時は既定のみで続行 */ }
  }
  cache = { at: Date.now(), cats: out };
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
      c.items.map((it) => `${it.key}${it.unit ? "(" + it.unit + ")" : ""}`).join(" / "));
  }
  return lines.join("\n");
}
