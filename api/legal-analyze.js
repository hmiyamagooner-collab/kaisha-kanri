// Vercel Serverless Function: /api/legal-analyze
// 法務部長・陽翔ペルソナで契約書を構造化チェック（円卓法務AIと同系統）

import { getOpenAIKey } from "./_lib/getOpenAIKey.js";

export const config = { maxDuration: 60 };

const OPENAI_TIMEOUT_MS = 50000;
const MODEL = process.env.OPENAI_MODEL || "gpt-4o";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const apiKey = await getOpenAIKey();
  if (!apiKey) {
    return res.status(500).json({
      error: "OPENAI_API_KEY is not configured",
      hint: "Vercelの環境変数 OPENAI_API_KEY を設定するか、api/secrets.local.js.example を secrets.local.js にコピーしてキーを入れてください。",
    });
  }

  try {
    const body = req.body || {};
    const contractText = String(body.contractText || "").trim();
    const caseInfo = body.case || null;
    if (!contractText) {
      return res.status(400).json({ error: "契約書テキストが空です" });
    }

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

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), OPENAI_TIMEOUT_MS);
    let aiRes;
    try {
      aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: MODEL,
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
    } finally {
      clearTimeout(timer);
    }

    if (!aiRes.ok) {
      const t = await aiRes.text();
      return res.status(502).json({ error: "AI呼び出しに失敗しました", detail: t.slice(0, 500) });
    }
    const data = await aiRes.json();
    let parsed;
    try {
      parsed = JSON.parse(data.choices?.[0]?.message?.content || "{}");
    } catch (e) {
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
      model: MODEL,
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
