// Vercel Serverless Function: /api/openai
// 会社管理 — 円卓会議ターミナルのAI（OpenAI GPT-4o）
// Claude版(/api/claude)と同じ振り分けルール。APIキーはサーバー側のみで保持。

export const config = { maxDuration: 60 };

const OPENAI_TIMEOUT_MS = 50000;
const MODEL = process.env.OPENAI_MODEL || "gpt-4o";

const SYSTEM = [
  "あなたは会社管理アプリ「GOONER」の円卓会議ターミナルに常駐するAI秘書です。名前は「円卓（Entaku）」。ダッシュボードの秘書室の立場で、経理・法務の2部署へ情報を振り分けます。",
  "この会社のCEOを支え、キャッシュフロー(CF)の可視化と証拠化（水掛け論の防止・会長のマネーロンダリング牽制）を助けるのが使命です。",
  "",
  "【部署の担当（まずこの2部署のどちらかへ振り分ける）】",
  "■ 経理(Ritsu): お金の出入りに関わるものすべて。領収書のスクショ／請求書のスクショ／入出金明細／経費／振込・支払い／税。",
  "  → 該当モジュール: 口座・CSV取込、明細突合、精算クエスト、CF予測、印籠レポート。",
  "■ 法務(Tsukasa): 契約に関わるものすべて。契約書・覚書・注文書など。",
  "  → 該当モジュール: 契約リーガル(AIチェック)、案件ボード、関連者貸借。",
  "",
  "【法務 → 経理 の連携（重要）】",
  "契約書が来たら、法務での確認に加えて必ず『支払サイト（支払条件・支払期日・締め/支払日・分割スケジュール・利率）』を抽出し、経理へ引き継ぐよう案内すること。",
  "経理はその支払サイトを CF予測 の予定入出金として登録し、将来のキャッシュフローを管理する。契約→支払予定→CF予測 が一本の線でつながるようにする。",
  "",
  "【回答フォーマット】",
  "1行目に『→ 振り分け先: 経理』または『→ 振り分け先: 法務』（両方なら『法務→経理』）を示す。",
  "続けて、理由・使うモジュール・次に取るべき具体操作を箇条書きで。契約書なら支払サイトの抽出と経理連携を必ず含める。",
  "お金/契約の情報では、金額・相手・日付・期日・支払サイトなど『証拠とCF管理に必要な項目』が揃っているかを指摘する。",
  "単なる相談は振り分け先を省いて普通に助言してよい。断定的な法的・税務助言は避け、社内の可視化・記録・牽制の観点で日本語で簡潔に答える。",
].join("\n");

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
    const history = Array.isArray(body.messages) ? body.messages : [];
    const context = typeof body.context === "string" ? body.context : "";
    if (!history.length) {
      return res.status(400).json({ error: "messages が空です" });
    }

    const messages = history.slice(-16).map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content || "").slice(0, 6000),
    }));

    const system = context ? `${SYSTEM}\n\n【現在のシステム状況】\n${context.slice(0, 2000)}` : SYSTEM;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), OPENAI_TIMEOUT_MS);
    let aiRes;
    try {
      aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 1500,
          temperature: 0.4,
          messages: [{ role: "system", content: system }, ...messages],
        }),
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!aiRes.ok) {
      const t = await aiRes.text();
      return res.status(502).json({ error: "OpenAI呼び出しに失敗しました", detail: t.slice(0, 500) });
    }

    const data = await aiRes.json();
    const text = String(data.choices?.[0]?.message?.content || "").trim();
    return res.status(200).json({ ok: true, text, model: MODEL, at: new Date().toISOString() });
  } catch (e) {
    const aborted = e && e.name === "AbortError";
    return res.status(aborted ? 504 : 500).json({
      error: aborted ? "OpenAIの応答がタイムアウトしました" : "サーバーエラー",
      detail: String((e && e.message) || e).slice(0, 300),
    });
  }
}
