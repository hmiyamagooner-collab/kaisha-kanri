// Vercel Serverless Function: /api/legal-analyze
// 会社管理 — 契約書テキストをAIでリーガルチェックし、案件/CFと突合するための構造化データを返す。
// 目的は社内のキャッシュフロー証拠化・牽制（水掛け論の防止）。正式な法的助言や当局手続そのものではない。

export const config = { maxDuration: 60 };

// OpenAI呼び出しの自前タイムアウト(ms)。VercelのmaxDuration(60s)より必ず短く。
const OPENAI_TIMEOUT_MS = 50000;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "OPENAI_API_KEY is not configured" });
  }

  try {
    const body = req.body || {};
    const contractText = String(body.contractText || "").trim();
    const caseInfo = body.case || null; // {title,type,counterparty,contractDate,amount}
    if (!contractText) {
      return res.status(400).json({ error: "契約書テキストが空です" });
    }

    const systemText = [
      "あなたは日本企業の社内法務アシスタントです。提示された契約書テキストを読み、結果をJSONだけで返します。",
      "目的は「キャッシュフローの証拠化・社内牽制（水掛け論の防止）」であり、正式な法的助言ではありません。",
      "必ず次のJSONスキーマだけを返す（前後に文章やコードフェンスを付けない）:",
      "{",
      '  "summary": "契約書の要点を3〜5行で（日本語）",',
      '  "type": "契約種別（例: 売買契約 / 金銭消費貸借 / 賃貸借 / 業務委託 / その他）",',
      '  "parties": ["当事者名の配列"],',
      '  "counterparty": "自社から見た主な相手方名（不明なら空文字）",',
      '  "amount": 契約金額の数値（円・不明ならnull）,',
      '  "contractDate": "契約日 YYYY-MM-DD（不明ならnull）",',
      '  "keyTerms": [{"label":"項目名","value":"内容"}],',
      '  "risks": [{"level":"high|medium|low","text":"リスク・注意点（日本語）"}]',
      "}",
      "リスクは、支払条件・期日・金額の不一致・違約金・不明瞭な相手方・資金洗浄/反社の懸念など、お金の流れに関わる点を重視して指摘する。",
    ].join("\n");

    let userText = '契約書テキスト:\n"""\n' + contractText.slice(0, 16000) + '\n"""';
    if (caseInfo) {
      userText +=
        "\n\nこの契約書は次の登録案件に対応するはずです。抽出の参考にしてください（一致判定はこちらで行います）:\n" +
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
          model: "gpt-4o",
          max_tokens: 2000,
          temperature: 0.2,
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

    // 案件との突合はサーバー側で機械的に判定（証拠性を保つ）
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
      const dateMatch = caseInfo.contractDate && parsed.contractDate ? caseInfo.contractDate === parsed.contractDate : null;
      reconcile = { amountMatch, partyMatch, dateMatch, caseAmount: cAmt, aiAmount: pAmt };
    }

    return res.status(200).json({ ok: true, analysis: parsed, reconcile, model: "gpt-4o", at: new Date().toISOString() });
  } catch (e) {
    const aborted = e && e.name === "AbortError";
    return res.status(aborted ? 504 : 500).json({
      error: aborted ? "AIの応答がタイムアウトしました" : "サーバーエラー",
      detail: String((e && e.message) || e).slice(0, 300),
    });
  }
}
