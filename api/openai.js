// Vercel Serverless Function: /api/openai
// 会社管理 — 円卓会議ターミナルのAI（OpenAI GPT-4o）
// Claude版(/api/claude)と同じ振り分けルール。APIキーはサーバー側のみで保持。

export const config = { maxDuration: 60 };

const OPENAI_TIMEOUT_MS = 50000;
const MODEL = process.env.OPENAI_MODEL || "gpt-4o";

const AGENT_LABEL = { secretary: "凛", finance: "紬", legal: "陽翔" };

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

const SYSTEM_ENTAKU = [
  "あなたは会社管理アプリ「GOONER」の円卓会議を進行するAIです。参加者は次の4名のみです。",
  "・利用者（社長／システム利用者）— user メッセージとして届く",
  "・凛（secretary）— 秘書・進行役。全体調整、雑談、どの専門家に回すかの案内",
  "・紬（finance）— 経理部長。お金・領収書・請求・入出金・税・CF・口座・精算",
  "・陽翔（legal）— 法務部長。契約・リーガル・コンプラ・印籠・案件の法務観点",
  "",
  "円卓という別人格は存在しません。必ず凛・紬・陽翔のいずれか（複数可）として発言してください。",
  "専門外の話題は凛が受け、必要なら紬・陽翔を会話に招く形で進行します。",
  "契約と支払が絡むときは陽翔→紬の順で短く連携するのが望ましいです。",
  "",
  "【出力形式 — 必ずこのJSONのみ。Markdownや説明文は禁止】",
  '{"replies":[{"agent":"secretary|finance|legal","text":"発言本文"}]}',
  "replies は1〜3件。各 text は日本語で簡潔に。モジュール案内（口座・案件・契約リーガル等）を含めてよい。",
  "断定的な法的・税務助言は避け、社内の可視化・記録・牽制の観点で答える。",
].join("\n");

function formatHistoryMessage(m) {
  const content = String(m.content || "").slice(0, 6000);
  if (m.role === "assistant" && m.agent && AGENT_LABEL[m.agent]) {
    return `【${AGENT_LABEL[m.agent]}】${content}`;
  }
  return content;
}

function parseEntakuReplies(raw) {
  const text = String(raw || "").trim();
  if (!text) return [{ agent: "secretary", text: "（応答が空でした）" }];
  try {
    const m = text.match(/\{[\s\S]*\}/);
    const j = JSON.parse(m ? m[0] : text);
    const replies = Array.isArray(j.replies) ? j.replies : [];
    const valid = replies
      .filter((r) => r && ["secretary", "finance", "legal"].includes(r.agent) && String(r.text || "").trim())
      .map((r) => ({ agent: r.agent, text: String(r.text).trim().slice(0, 6000) }));
    if (valid.length) return valid;
  } catch (e) { /* fall through */ }
  return [{ agent: "secretary", text: text.slice(0, 6000) }];
}

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
    const entaku = body.mode === "entaku";
    if (!history.length) {
      return res.status(400).json({ error: "messages が空です" });
    }

    const messages = history.slice(-16).map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: entaku ? formatHistoryMessage(m) : String(m.content || "").slice(0, 6000),
    }));

    const baseSystem = entaku ? SYSTEM_ENTAKU : SYSTEM;
    const system = context ? `${baseSystem}\n\n【現在のシステム状況】\n${context.slice(0, 2000)}` : baseSystem;

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
          temperature: entaku ? 0.5 : 0.4,
          ...(entaku ? { response_format: { type: "json_object" } } : {}),
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
    const raw = String(data.choices?.[0]?.message?.content || "").trim();
    if (entaku) {
      const replies = parseEntakuReplies(raw);
      const text = replies.map((r) => `【${AGENT_LABEL[r.agent]}】${r.text}`).join("\n\n");
      return res.status(200).json({ ok: true, text, replies, model: MODEL, at: new Date().toISOString() });
    }
    return res.status(200).json({ ok: true, text: raw, model: MODEL, at: new Date().toISOString() });
  } catch (e) {
    const aborted = e && e.name === "AbortError";
    return res.status(aborted ? 504 : 500).json({
      error: aborted ? "OpenAIの応答がタイムアウトしました" : "サーバーエラー",
      detail: String((e && e.message) || e).slice(0, 300),
    });
  }
}
