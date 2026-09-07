// Vercel Serverless Function: /api/rela-revenue
// RELAの実課金売上（Google Play + App Store + Web/Stripe をまとめた真実の源＝RevenueCat）を読み取り専用で取得。
// RevenueCat REST API v2:
//   一覧:   GET https://api.revenuecat.com/v2/projects
//   概要:   GET https://api.revenuecat.com/v2/projects/{project_id}/metrics/overview
//   ヘッダ: Authorization: Bearer <Secret API key (sk_...)>
// 環境変数:
//   REVENUECAT_API_KEY      … v2 Secret APIキー(sk_...)  ※サーバー側のみ。ブラウザに出さない
//   REVENUECAT_PROJECT_ID   … 任意。未指定なら最初のプロジェクトを使う
//   USD_JPY_RATE            … 任意。USD→円の概算レート(既定150)。RevenueCatの金額はUSD基準のため表示補助に使用

const API_BASE = "https://api.revenuecat.com/v2";
const DASH_URL = "https://app.revenuecat.com/overview";
const TIMEOUT_MS = 12000;

function applyCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function authHeaders(key) {
  return { Authorization: "Bearer " + key, "Content-Type": "application/json" };
}

async function rcFetch(url, key, signal) {
  const r = await fetch(url, { headers: authHeaders(key), signal });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { /* keep null */ }
  return { ok: r.ok, status: r.status, data, text };
}

// overviewのメトリクス配列は実装差に備えて複数キーを許容し、id→オブジェクトのmapにする
function indexMetrics(overview) {
  const arr =
    (overview && (overview.metrics || overview.items || overview.data)) || [];
  const map = {};
  for (const m of Array.isArray(arr) ? arr : []) {
    if (m && m.id != null) map[String(m.id)] = m;
  }
  return { map, list: Array.isArray(arr) ? arr : [] };
}

async function handleStatus(res) {
  const key = String(process.env.REVENUECAT_API_KEY || "").trim();
  if (!key) {
    return res.status(200).json({
      ok: false, state: "no_key", label: "キー未設定",
      detail:
        "Vercelの環境変数 REVENUECAT_API_KEY（RevenueCatのv2 Secret APIキー sk_...）が未設定です。設定するとRELAの実課金売上（Google Play/App Store/Web統合）を表示します。",
      dashboardUrl: DASH_URL, at: new Date().toISOString(),
    });
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    // 1) プロジェクト特定（env指定があれば優先）
    let projectId = String(process.env.REVENUECAT_PROJECT_ID || "").trim();
    let projectName = "";
    if (!projectId) {
      const pj = await rcFetch(API_BASE + "/projects", key, ctrl.signal);
      if (pj.status === 401) {
        return res.status(200).json({
          ok: false, state: "bad_key", label: "キー無効",
          detail: "REVENUECAT_API_KEY が無効です。RevenueCatのv2 Secret APIキー(sk_...)を確認してください。",
          dashboardUrl: DASH_URL, at: new Date().toISOString(),
        });
      }
      if (!pj.ok) {
        return res.status(200).json({
          ok: false, state: "error", label: "取得失敗",
          detail: "プロジェクト一覧の取得に失敗しました（HTTP " + pj.status + "）。",
          dashboardUrl: DASH_URL, at: new Date().toISOString(),
        });
      }
      const items = (pj.data && (pj.data.items || pj.data.data)) || [];
      if (!items.length) {
        return res.status(200).json({
          ok: false, state: "no_project", label: "プロジェクト無し",
          detail: "RevenueCatにプロジェクトが見つかりませんでした。",
          dashboardUrl: DASH_URL, at: new Date().toISOString(),
        });
      }
      projectId = items[0].id;
      projectName = items[0].name || "";
    }

    // 2) 概要メトリクス
    const ov = await rcFetch(
      API_BASE + "/projects/" + encodeURIComponent(projectId) + "/metrics/overview",
      key, ctrl.signal
    );
    if (ov.status === 401) {
      return res.status(200).json({
        ok: false, state: "bad_key", label: "キー無効",
        detail: "REVENUECAT_API_KEY が無効です（overview 401）。",
        dashboardUrl: DASH_URL, at: new Date().toISOString(),
      });
    }
    if (!ov.ok) {
      return res.status(200).json({
        ok: false, state: "error", label: "取得失敗",
        detail: "概要メトリクスの取得に失敗しました（HTTP " + ov.status + "）。",
        projectId, dashboardUrl: DASH_URL, at: new Date().toISOString(),
      });
    }

    const { map, list } = indexMetrics(ov.data);
    const pick = (id) => {
      const m = map[id];
      if (!m) return null;
      return { id, name: m.name || id, value: Number(m.value), unit: m.unit || "", period: m.period || "" };
    };
    const rate = Number(process.env.USD_JPY_RATE || 150) || 150;

    return res.status(200).json({
      ok: true, state: "ok", label: "接続OK",
      detail: "RevenueCatからRELAの実課金サマリーを取得しました（Google Play/App Store/Web統合）。",
      project: { id: projectId, name: projectName },
      usdJpyRate: rate,
      metrics: {
        revenue: pick("revenue"),                       // 直近28日の売上(USD)
        mrr: pick("mrr"),                               // 月次経常収益(USD)
        active_subscriptions: pick("active_subscriptions"),
        active_trials: pick("active_trials"),
        active_users: pick("active_users"),
        new_customers: pick("new_customers"),
        installs: pick("installs"),
      },
      allMetrics: list.map((m) => ({ id: m.id, name: m.name, value: m.value, unit: m.unit, period: m.period })),
      note: "金額はRevenueCat基準(USD)。円表示はUSD_JPY_RATEでの概算です。ストア別内訳はRevenueCatダッシュボードのChartsで確認できます。",
      dashboardUrl: DASH_URL, at: new Date().toISOString(),
    });
  } catch (e) {
    const aborted = e && e.name === "AbortError";
    return res.status(200).json({
      ok: false, state: aborted ? "timeout" : "error", label: aborted ? "応答なし" : "エラー",
      detail: aborted ? "RevenueCatへの確認がタイムアウトしました。" : String((e && e.message) || e).slice(0, 200),
      dashboardUrl: DASH_URL, at: new Date().toISOString(),
    });
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    return await handleStatus(res);
  } catch (e) {
    return res.status(500).json({
      ok: false, state: "error", label: "確認失敗",
      detail: String((e && e.message) || e).slice(0, 200),
      dashboardUrl: DASH_URL, at: new Date().toISOString(),
    });
  }
}
