// Vercel Serverless Function: /api/anthropic-status
// Anthropic(Claude) の利用額・トークンをポータルの「Claude状態」に出す（読み取り専用）。
//   ゆうしゃレオ等が使う Claude API の組織全体の利用を、Admin API(Usage & Cost)で取得する。
//   Adminキーは Vercel 環境変数のみ。ブラウザには出さない。
// 環境変数: ANTHROPIC_ADMIN_KEY（sk-ant-admin... 組織管理者が発行するAdmin APIキー）
//
// Admin API:
//   Cost:  GET https://api.anthropic.com/v1/organizations/cost_report
//   Usage: GET https://api.anthropic.com/v1/organizations/usage_report/messages
//   ヘッダ: x-api-key: <admin key> / anthropic-version: 2023-06-01

const API_BASE = "https://api.anthropic.com/v1/organizations";
const CONSOLE_USAGE = "https://console.anthropic.com/settings/usage";

function applyCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// UTCの「7日前の0時」を RFC3339 で返す
function startingAt(daysAgo) {
  const ms = Date.now() - daysAgo * 24 * 3600 * 1000;
  return new Date(ms).toISOString().slice(0, 10) + "T00:00:00Z";
}

function admHeaders(key) {
  return { "x-api-key": key, "anthropic-version": "2023-06-01" };
}

// data[].results[] を全ページ集めて返す（7日/1日バケットなら通常1ページ）
async function fetchAllResults(url, key) {
  const out = [];
  let next = null;
  for (let i = 0; i < 12; i++) {
    const u = next ? url + "&page=" + encodeURIComponent(next) : url;
    const r = await fetch(u, { headers: admHeaders(key) });
    const text = await r.text();
    if (!r.ok) return { ok: false, status: r.status, detail: text.slice(0, 300) };
    let data = {};
    try { data = JSON.parse(text); } catch (e) { return { ok: false, status: 0, detail: "bad_json" }; }
    const buckets = Array.isArray(data.data) ? data.data : [];
    for (const b of buckets) {
      const rows = Array.isArray(b.results) ? b.results : [];
      for (const row of rows) out.push(row);
    }
    if (data.has_more && data.next_page) { next = data.next_page; continue; }
    break;
  }
  return { ok: true, rows: out };
}

// ネストした数値を全部足す（cache_creation が {..:n,..:n} のことがある）
function sumNumbers(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (v && typeof v === "object") {
    let s = 0;
    for (const k of Object.keys(v)) s += sumNumbers(v[k]);
    return s;
  }
  return 0;
}

async function fetchCostUsd(key, days) {
  const url = API_BASE + "/cost_report?starting_at=" + encodeURIComponent(startingAt(days));
  const res = await fetchAllResults(url, key);
  if (!res.ok) return { available: false, reason: "cost_" + (res.status || "err"), detail: res.detail };
  let total = 0, currency = "USD";
  for (const row of res.rows) {
    const amt = Number(row && row.amount);
    if (Number.isFinite(amt)) total += amt;
    if (row && row.currency) currency = row.currency;
  }
  return { available: true, days, usd: Math.round(total * 100) / 100, currency };
}

async function fetchTokens(key, days) {
  const url =
    API_BASE + "/usage_report/messages?starting_at=" +
    encodeURIComponent(startingAt(days)) + "&bucket_width=1d";
  const res = await fetchAllResults(url, key);
  if (!res.ok) return { available: false, reason: "usage_" + (res.status || "err"), detail: res.detail };
  let input = 0, output = 0;
  for (const row of res.rows) {
    input += sumNumbers(row && row.uncached_input_tokens);
    input += sumNumbers(row && row.cache_read_input_tokens);
    input += sumNumbers(row && row.cache_creation);          // オブジェクトのことがある
    input += sumNumbers(row && row.cache_creation_input_tokens);
    output += sumNumbers(row && row.output_tokens);
  }
  return { available: true, days, input, output, total: input + output };
}

// Anthropic(Claude)の残高切れ検知：通常APIキー(ANTHROPIC_API_KEY)で最小Messagesを叩く。
//   残高不足なら 400 で「credit balance is too low」等が返る（ゆうしゃレオ等の停止に直結）。
async function checkAnthropicCredit() {
  const key = String(process.env.ANTHROPIC_API_KEY || "").trim();
  if (!key) return { available: false, state: "no_key" };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
      signal: ctrl.signal,
    });
    if (r.ok) return { available: true, state: "ok" };
    const text = (await r.text()) || "";
    const low = /credit balance is too low|insufficient|billing|quota|payment/i.test(text);
    if (r.status === 401) return { available: true, state: "bad_key" };
    if ((r.status === 400 || r.status === 402 || r.status === 429) && low) return { available: true, state: "no_credits" };
    return { available: true, state: "error", status: r.status };
  } catch (e) {
    return { available: false, state: "unknown", reason: String((e && e.message) || e).slice(0, 80) };
  } finally {
    clearTimeout(t);
  }
}

// 信号機レベル: 残あり=ok(緑) / 残り僅か=low(橙) / 切れ・無効=out(赤) / 不明=unknown
function anthLevel(credit, cost) {
  const st = credit && credit.state;
  if (st === "no_credits" || st === "bad_key") return "out";
  if (st === "ok") {
    const thr = Number(process.env.ANTHROPIC_ALERT_USD || 0);
    if (thr > 0 && cost && cost.available && Number(cost.usd) >= thr) return "low";
    return "ok";
  }
  return "unknown";
}

async function handleStatus(res) {
  const key = String(process.env.ANTHROPIC_ADMIN_KEY || "").trim();
  const credit = await checkAnthropicCredit();
  if (!key) {
    return res.status(200).json({
      ok: false, state: "no_key", label: "キー未設定",
      detail: "Vercelの環境変数 ANTHROPIC_ADMIN_KEY（Admin APIキー sk-ant-admin...）が未設定です。設定すると利用額・トークンを表示します。",
      credit, level: anthLevel(credit, null), billingUrl: CONSOLE_USAGE, at: new Date().toISOString(),
    });
  }
  const [cost, tokens] = await Promise.all([fetchCostUsd(key, 7), fetchTokens(key, 7)]);

  // どちらも 401 ならキー不正
  if ((cost.reason === "cost_401") || (tokens.reason === "usage_401")) {
    return res.status(200).json({
      ok: false, state: "bad_key", label: "キー無効",
      detail: "ANTHROPIC_ADMIN_KEY が無効か、Admin権限がありません。組織のAdmin APIキーを確認してください。",
      billingUrl: CONSOLE_USAGE, at: new Date().toISOString(),
    });
  }

  const okData = cost.available || tokens.available;
  return res.status(200).json({
    ok: !!okData,
    state: okData ? "ok" : "error",
    label: okData ? "接続OK" : "取得失敗",
    detail: okData
      ? "AnthropicのAdmin APIに接続でき、組織全体の直近7日の利用を取得しました。"
      : "Admin APIから利用データを取得できませんでした（権限/期間をご確認ください）。",
    spend7d: cost,
    tokens7d: tokens,
    credit,
    level: anthLevel(credit, cost),
    note: "※組織全体の利用（ゆうしゃレオ等を含む）。ワークスペース別内訳は将来対応可。",
    billingUrl: CONSOLE_USAGE,
    at: new Date().toISOString(),
  });
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  // GET でも POST({mode:'status'}) でも状態を返す
  try {
    return await handleStatus(res);
  } catch (e) {
    return res.status(500).json({
      ok: false, state: "error", label: "確認失敗",
      detail: String((e && e.message) || e).slice(0, 200),
      billingUrl: CONSOLE_USAGE, at: new Date().toISOString(),
    });
  }
}
