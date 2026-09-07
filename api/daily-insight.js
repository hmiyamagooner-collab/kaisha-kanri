// Vercel Serverless Function: /api/daily-insight
// 日次データ報告の「所見」を生成する（表A/表BのJSON → 3行以内の所見）。
// 参照: Cursor指示書_追補_日次データ報告_20260907.md §4
// コスト優先: OpenAI gpt-4o-mini を使用（安価）。APIキーは OPENAI_API_KEY（サーバー側のみ）。

import { getOpenAIKey } from "./_lib/getOpenAIKey.js";

export const config = { maxDuration: 30 };

const MODEL = process.env.OPENAI_INSIGHT_MODEL || "gpt-4o-mini";
const TIMEOUT_MS = 25000;

function applyCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// 指示書 §4 の固定プロンプト（{json} をデータで置換）
function buildPrompt(jsonStr) {
  return [
    "あなたは RELA（リラ）の広告戦略パートナーです。以下の日次データ（JSON）を読み、日本語で 3 行以内の所見を書いてください。",
    "ルール：",
    "- 1 行目：最も重要な変化を 1 つ（例：wake 率の低下、analysis の増加）",
    "- 2 行目：その原因として最も可能性が高いもの 1 つ（断定せず「可能性」で）",
    "- 3 行目：次に見るべき数字 1 つ",
    "- 「成功」「失敗」のような評価語は使わない。母数が 10 未満の率には触れない",
    "- CPI の低下は「良い」と書かない（開かない層に寄る兆候として扱う）",
    "データ：" + jsonStr,
  ].join("\n");
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const key = await getOpenAIKey();
  if (!key) {
    return res.status(200).json({
      ok: false, state: "no_key",
      error: "OPENAI_API_KEY が未設定です。Vercelの環境変数を設定してください。",
    });
  }

  try {
    const body = req.body || {};
    let jsonStr = "";
    if (typeof body.json === "string") jsonStr = body.json;
    else if (body.json != null) jsonStr = JSON.stringify(body.json);
    else jsonStr = JSON.stringify(body);
    jsonStr = jsonStr.slice(0, 12000);
    if (!jsonStr || jsonStr === "{}") return res.status(400).json({ ok: false, error: "データが空です" });

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let r;
    try {
      r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 300,
          temperature: 0.3,
          messages: [{ role: "user", content: buildPrompt(jsonStr) }],
        }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await r.text();
    if (!r.ok) {
      const low = /insufficient_quota|billing|credit|no credits/i.test(text);
      return res.status(200).json({
        ok: false,
        state: low ? "no_credits" : "error",
        error: low ? "OpenAIの残高が不足しています。" : "所見の生成に失敗しました。",
        detail: text.slice(0, 300),
      });
    }
    let data = {};
    try { data = JSON.parse(text); } catch (e) {}
    const insight = String(data.choices?.[0]?.message?.content || "").trim();
    return res.status(200).json({ ok: true, insight, model: MODEL, at: new Date().toISOString() });
  } catch (e) {
    const aborted = e && e.name === "AbortError";
    return res.status(200).json({
      ok: false,
      state: aborted ? "timeout" : "error",
      error: aborted ? "所見の生成がタイムアウトしました。" : String((e && e.message) || e).slice(0, 200),
    });
  }
}
