// Vercel Serverless Function: /api/rela-revenue
// プロダクト別の実課金売上（Google Play + App Store + Web/Stripe をまとめた真実の源＝RevenueCat）を読み取り専用で取得。
// RevenueCat REST API v2:
//   一覧:   GET https://api.revenuecat.com/v2/projects
//   概要:   GET https://api.revenuecat.com/v2/projects/{project_id}/metrics/overview
//   ヘッダ: Authorization: Bearer <Secret API key (sk_...)>
// 呼び方: GET /api/rela-revenue?product=rela|leo  または POST {product:'leo'}（省略時 rela）
// 環境変数（v2 Secret キーはプロジェクト単位で発行されるため、プロダクトごとに1本）:
//   REVENUECAT_API_KEY          … RELA の v2 Secret APIキー(sk_...)  ※サーバー側のみ
//   REVENUECAT_PROJECT_ID       … 任意。RELA のプロジェクトID（未指定なら名前に rela を含むもの→最初のもの）
//   REVENUECAT_API_KEY_LEO      … ゆうしゃレオ の v2 Secret APIキー(sk_...)
//   REVENUECAT_PROJECT_ID_LEO   … 任意。レオ のプロジェクトID（未指定なら名前に leo/レオ を含むもの→最初のもの）
//   USD_JPY_RATE                … 任意。USD→円の概算レート(既定150)。RevenueCatの金額はUSD基準のため表示補助に使用
// キーに必要な権限: 「Charts & Metrics › Overview metrics: Read」（無いと overview が 403 になる）

const API_BASE = "https://api.revenuecat.com/v2";
const DASH_URL = "https://app.revenuecat.com/overview";
const TIMEOUT_MS = 12000;

const PRODUCTS = {
  rela: { id: "rela", label: "RELA", keyEnv: "REVENUECAT_API_KEY", projectEnv: "REVENUECAT_PROJECT_ID", nameHint: /rela/i,
          scope: "Google Play/App Store/Web統合" },
  leo:  { id: "leo", label: "ゆうしゃレオ", keyEnv: "REVENUECAT_API_KEY_LEO", projectEnv: "REVENUECAT_PROJECT_ID_LEO", nameHint: /leo|レオ|yusha/i,
          scope: "Google Play/App Store統合" },
};

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

// product の解決（query → body → 既定 rela）。未知の値は rela に倒す
function resolveProduct(req) {
  let p = "";
  try { p = String((req.query && req.query.product) || "").trim().toLowerCase(); } catch (e) { /* ignore */ }
  if (!p && req.body) {
    try {
      const b = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      p = String((b && b.product) || "").trim().toLowerCase();
    } catch (e) { /* ignore */ }
  }
  return PRODUCTS[p] || PRODUCTS.rela;
}

function fail(res, prod, extra) {
  return res.status(200).json(Object.assign({
    ok: false, product: { id: prod.id, label: prod.label }, keyEnv: prod.keyEnv,
    dashboardUrl: DASH_URL, at: new Date().toISOString(),
  }, extra));
}

async function handleStatus(res, prod) {
  const key = String(process.env[prod.keyEnv] || "").trim();
  if (!key) {
    return fail(res, prod, {
      state: "no_key", label: "キー未設定",
      detail: "Vercelの環境変数 " + prod.keyEnv + "（RevenueCatの v2 Secret APIキー sk_...）が未設定です。設定すると" +
        prod.label + "の実課金売上（" + prod.scope + "）を表示します。",
    });
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    // 1) プロジェクト特定（env指定があれば優先。無ければ一覧から名前で推定→最初のもの）
    let projectId = String(process.env[prod.projectEnv] || "").trim();
    let projectName = "";
    if (!projectId) {
      const pj = await rcFetch(API_BASE + "/projects", key, ctrl.signal);
      if (pj.status === 401) {
        return fail(res, prod, {
          state: "bad_key", label: "キー無効",
          detail: prod.keyEnv + " が無効です。RevenueCatの v2 Secret APIキー(sk_...)を確認してください。",
        });
      }
      if (!pj.ok) {
        return fail(res, prod, {
          state: "error", label: "取得失敗",
          detail: "プロジェクト一覧の取得に失敗しました（HTTP " + pj.status + "）。",
        });
      }
      const items = (pj.data && (pj.data.items || pj.data.data)) || [];
      if (!items.length) {
        return fail(res, prod, {
          state: "no_project", label: "プロジェクト無し",
          detail: "RevenueCatにプロジェクトが見つかりませんでした。",
        });
      }
      const hit = items.find((it) => prod.nameHint.test(String(it.name || ""))) || items[0];
      projectId = hit.id;
      projectName = hit.name || "";
    }

    // 2) 概要メトリクス
    const ov = await rcFetch(
      API_BASE + "/projects/" + encodeURIComponent(projectId) + "/metrics/overview",
      key, ctrl.signal
    );
    if (ov.status === 401) {
      return fail(res, prod, {
        state: "bad_key", label: "キー無効",
        detail: prod.keyEnv + " が無効です（overview 401）。",
        projectId,
      });
    }
    if (ov.status === 403) {
      return fail(res, prod, {
        state: "no_permission", label: "権限不足",
        detail: prod.keyEnv + " に概要メトリクスの読み取り権限がありません。RevenueCat → Project settings → API keys で" +
          "該当の v2 Secret key を編集し「Charts & Metrics › Overview metrics: Read」を有効にしてください（キーの再発行でも可）。",
        projectId, project: { id: projectId, name: projectName },
      });
    }
    if (!ov.ok) {
      return fail(res, prod, {
        state: "error", label: "取得失敗",
        detail: "概要メトリクスの取得に失敗しました（HTTP " + ov.status + "）。",
        projectId,
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
      product: { id: prod.id, label: prod.label },
      detail: "RevenueCatから" + prod.label + "の実課金サマリーを取得しました（" + prod.scope + "）。",
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
    return fail(res, prod, {
      state: aborted ? "timeout" : "error", label: aborted ? "応答なし" : "エラー",
      detail: aborted ? "RevenueCatへの確認がタイムアウトしました。" : String((e && e.message) || e).slice(0, 200),
    });
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  const prod = resolveProduct(req);
  try {
    return await handleStatus(res, prod);
  } catch (e) {
    return res.status(500).json({
      ok: false, state: "error", label: "確認失敗", product: { id: prod.id, label: prod.label },
      detail: String((e && e.message) || e).slice(0, 200),
      dashboardUrl: DASH_URL, at: new Date().toISOString(),
    });
  }
}
