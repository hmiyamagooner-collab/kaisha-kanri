// Vercel Serverless Function: /api/legal-analyze
// 法務部長・陽翔ペルソナで契約書を構造化チェック（円卓法務AIと同系統）
// コスト優先: OpenAI(GPT-4o) を優先。OPENAI_API_KEY 未設定 or 失敗時のみ Claude(Opus) にフォールバック。
//   （精度重視でClaude優先に戻したい場合は handler 内の呼び出し順を入れ替える）
//   出力スキーマ（analysis/reconcile 等）は従来と不変。

import { getOpenAIKey } from "./_lib/getOpenAIKey.js";

export const config = { maxDuration: 60 };

const AI_TIMEOUT_MS = 55000;
const CLAUDE_MODEL = "claude-opus-4-8";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";

function buildPrompts(contractText, caseInfo) {
  const systemText = [
    "あなたは会社管理アプリ「GOONER」の法務部長・陽翔（HARUTO）です。世界水準のジェネラル・カウンセルとして契約を読みます。",
    "使命: 会社を守る／利益を出す／コンプライアンスを守る。正式な法的助言ではなく、社内のキャッシュフロー証拠化・牽制が目的です。",
    "必ず支払サイト（支払条件・期日・締め/支払日・分割・利率）を keyTerms に含め、経理（紬）へ引き継ぐ観点で指摘する。",
    "リスクは支払条件・期日・金額不一致・違約金・相手方不明瞭・反社/名義貸し懸念など、お金の流れを重視する。",
    "出力は次のJSONのみ（前後に文章やコードフェンス禁止）:",
    "{",
    '  "summary": "陽翔としての要点を3〜5行（日本語・です/ます調）",',
    '  "type": "契約種別",',
    '  "parties": ["当事者名"],',
    '  "counterparty": "主な相手方（不明なら空文字）",',
    '  "amount": 契約金額の数値（円・不明ならnull）,',
    '  "contractDate": "YYYY-MM-DD または null",',
    '  "keyTerms": [{"label":"項目名","value":"内容"}],',
    '  "risks": [{"level":"high|medium|low","text":"注意点"}],',
    '  "paymentTerms": "支払サイトの要約（なければ空文字）",',
    '  "entakuMessage": "円卓で社長に伝える陽翔の発言（2〜5文。です/ます調）"',
    "}",
  ].join("\n");

  let userText = '契約書テキスト:\n"""\n' + contractText.slice(0, 16000) + '\n"""';
  if (caseInfo) {
    userText +=
      "\n\n登録案件（突合参考）:\n" +
      JSON.stringify({
        title: caseInfo.title,
        type: caseInfo.type,
        counterparty: caseInfo.counterparty,
        contractDate: caseInfo.contractDate,
        amount: caseInfo.amount,
      });
  }
  return { systemText, userText };
}

// Claudeはjson_object指定が無いので、コードフェンスや前後文が混じっても堅牢に抽出する
function extractJson(s) {
  if (!s) return null;
  let t = String(s).replace(/```json/gi, "```").replace(/```/g, "").trim();
  try { return JSON.parse(t); } catch (e) {}
  const i = t.indexOf("{"), j = t.lastIndexOf("}");
  if (i >= 0 && j > i) {
    try { return JSON.parse(t.slice(i, j + 1)); } catch (e) {}
  }
  return null;
}

// 適材適所①: Claude(Opus 4.8) で法務精読。ANTHROPIC_API_KEY 未設定なら skip。
async function callClaude(systemText, userText) {
  const key = String(process.env.ANTHROPIC_API_KEY || "").trim();
  if (!key) return { ok: false, skip: true };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), AI_TIMEOUT_MS);
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 2500,
        system: systemText,
        messages: [{ role: "user", content: userText }],
      }),
      signal: ac.signal,
    });
    if (!r.ok) {
      const t = await r.text();
      return { ok: false, detail: t.slice(0, 500), status: r.status };
    }
    const data = await r.json();
    const text = Array.isArray(data.content)
      ? data.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim()
      : "";
    return { ok: true, text, model: CLAUDE_MODEL };
  } catch (e) {
    return { ok: false, detail: String((e && e.message) || e).slice(0, 200), aborted: e && e.name === "AbortError" };
  } finally {
    clearTimeout(timer);
  }
}

// 適材適所フォールバック: OpenAI(GPT)。OPENAI_API_KEY 未設定なら skip。
async function callOpenAI(systemText, userText) {
  const apiKey = await getOpenAIKey();
  if (!apiKey) return { ok: false, skip: true };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), AI_TIMEOUT_MS);
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        max_tokens: 2500,
        temperature: 0.25,
        messages: [
          { role: "system", content: systemText },
          { role: "user", content: userText },
        ],
        response_format: { type: "json_object" },
      }),
      signal: ac.signal,
    });
    if (!r.ok) {
      const t = await r.text();
      return { ok: false, detail: t.slice(0, 500), status: r.status };
    }
    const data = await r.json();
    return { ok: true, text: data.choices?.[0]?.message?.content || "", model: OPENAI_MODEL };
  } catch (e) {
    return { ok: false, detail: String((e && e.message) || e).slice(0, 200), aborted: e && e.name === "AbortError" };
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const body = req.body || {};
    const contractText = String(body.contractText || "").trim();
    const caseInfo = body.case || null;
    if (!contractText) {
      return res.status(400).json({ error: "契約書テキストが空です" });
    }

    const { systemText, userText } = buildPrompts(contractText, caseInfo);

    // コスト優先: まず OpenAI(GPT)、ダメなら Claude にフォールバック
    let used = await callOpenAI(systemText, userText);
    if (!used.ok) {
      const cl = await callClaude(systemText, userText);
      if (cl.ok) {
        used = cl;
      } else if (used.skip && cl.skip) {
        return res.status(500).json({
          error: "AIキーが未設定です",
          hint: "Vercelの環境変数 OPENAI_API_KEY（法務はGPT優先）または ANTHROPIC_API_KEY を設定してください。",
        });
      } else {
        // 両方試して失敗
        return res.status(used.aborted || cl.aborted ? 504 : 502).json({
          error: used.aborted || cl.aborted ? "AIの応答がタイムアウトしました" : "AI呼び出しに失敗しました",
          detail: (used.detail || cl.detail || "").slice(0, 500),
        });
      }
    }

    const parsed = extractJson(used.text);
    if (!parsed) {
      return res.status(502).json({ error: "AI応答の解析に失敗しました" });
    }

    let reconcile = null;
    if (caseInfo) {
      const num = (v) => (v == null || v === "" ? null : Number(v));
      const cAmt = num(caseInfo.amount);
      const pAmt = num(parsed.amount);
      const amountMatch = cAmt != null && pAmt != null ? Math.abs(cAmt - pAmt) <= 1 : null;
      const norm = (s) => String(s || "").replace(/\s|株式会社|（株）|\(株\)|有限会社|㈱/g, "");
      const cP = norm(caseInfo.counterparty);
      const pP = norm(parsed.counterparty);
      const partyMatch = cP && pP ? pP.includes(cP) || cP.includes(pP) : null;
      const dateMatch =
        caseInfo.contractDate && parsed.contractDate ? caseInfo.contractDate === parsed.contractDate : null;
      reconcile = { amountMatch, partyMatch, dateMatch, caseAmount: cAmt, aiAmount: pAmt };
    }

    return res.status(200).json({
      ok: true,
      analysis: parsed,
      reconcile,
      agent: "legal",
      agentName: "陽翔",
      model: used.model,
      at: new Date().toISOString(),
    });
  } catch (e) {
    const aborted = e && e.name === "AbortError";
    return res.status(aborted ? 504 : 500).json({
      error: aborted ? "AIの応答がタイムアウトしました" : "サーバーエラー",
      detail: String((e && e.message) || e).slice(0, 300),
    });
  }
}
