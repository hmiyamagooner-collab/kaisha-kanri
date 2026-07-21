// Vercel Serverless Function: /api/whisper-minutes
// 円卓会議: 音声 → Whisper文字起こし → GPTで議事録（要約・決定事項）

import { getOpenAIKey } from "./_lib/getOpenAIKey.js";

export const config = {
  maxDuration: 60,
  api: { bodyParser: { sizeLimit: "8mb" } },
};

const OPENAI_TIMEOUT_MS = 55000;
const CHAT_MODEL = process.env.OPENAI_MODEL || "gpt-4o";
const WHISPER_MODEL = process.env.OPENAI_WHISPER_MODEL || "whisper-1";

const MINUTES_SYSTEM = [
  "あなたは会社管理アプリ「GOONER」円卓会議の書記AIです。",
  "利用者の会議音声の文字起こしから、議事録を日本語で作成します。",
  "断定的な法的・税務助言は避け、決定事項と次の一手を明確にしてください。",
  "",
  "【出力形式 — 必ずこのJSONのみ】",
  JSON.stringify({
    summary: "会議の要約（3〜8文）",
    decisions: [{ title: "決定事項", owner: "担当（社長|凛|紬|陽翔|氏名）", due: "期限目安" }],
    actions: [
      {
        title: "具体的な次の一手",
        owner: "担当",
        due: "期限",
        module: "任意: cf-forecast等",
      },
    ],
    replies: [
      {
        agent: "secretary",
        text: "凛としての議事録報告（要約と決定事項を簡潔に）",
      },
    ],
  }),
  "・decisions / actions は0〜8件。無ければ空配列。",
  "・replies は1〜2件。先頭は必ず secretary（凛）。必要なら finance / legal が短く補足。",
].join("\n");

function extFromMime(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.includes("ogg")) return "ogg";
  if (m.includes("mp4") || m.includes("m4a")) return "m4a";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("wav")) return "wav";
  return "webm";
}

function parseMinutesJson(raw) {
  const text = String(raw || "").trim();
  if (!text) {
    return {
      summary: "",
      decisions: [],
      actions: [],
      replies: [{ agent: "secretary", text: "議事録の生成結果が空でした。" }],
    };
  }
  try {
    const m = text.match(/\{[\s\S]*\}/);
    const j = JSON.parse(m ? m[0] : text);
    const decisions = (Array.isArray(j.decisions) ? j.decisions : [])
      .filter((d) => d && String(d.title || "").trim())
      .slice(0, 8)
      .map((d) => ({
        title: String(d.title).trim().slice(0, 200),
        owner: String(d.owner || "").trim().slice(0, 40),
        due: String(d.due || "").trim().slice(0, 40),
      }));
    const actions = (Array.isArray(j.actions) ? j.actions : [])
      .filter((a) => a && String(a.title || "").trim())
      .slice(0, 8)
      .map((a) => ({
        title: String(a.title).trim().slice(0, 200),
        owner: String(a.owner || "").trim().slice(0, 40),
        due: String(a.due || "").trim().slice(0, 40),
        module: String(a.module || "").trim().slice(0, 40),
      }));
    const replies = (Array.isArray(j.replies) ? j.replies : [])
      .filter((r) => r && ["secretary", "finance", "legal"].includes(r.agent) && String(r.text || "").trim())
      .map((r) => ({ agent: r.agent, text: String(r.text).trim().slice(0, 6000) }))
      .slice(0, 3);
    return {
      summary: String(j.summary || "").trim().slice(0, 4000),
      decisions,
      actions,
      replies: replies.length
        ? replies
        : [{ agent: "secretary", text: String(j.summary || text).slice(0, 2000) }],
    };
  } catch (e) {
    return {
      summary: text.slice(0, 4000),
      decisions: [],
      actions: [],
      replies: [{ agent: "secretary", text: text.slice(0, 2000) }],
    };
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const apiKey = await getOpenAIKey();
  if (!apiKey) {
    return res.status(500).json({
      error: "OPENAI_API_KEY is not configured",
      hint: "Vercelの環境変数 OPENAI_API_KEY を設定してください。",
    });
  }

  try {
    const body = req.body || {};
    const b64 = String(body.audioBase64 || "").replace(/^data:[^;]+;base64,/, "");
    const mime = String(body.mime || "audio/webm").slice(0, 80);
    const context = String(body.context || "").slice(0, 2000);
    if (!b64) return res.status(400).json({ error: "audioBase64 が空です" });
    if (b64.length > 10 * 1024 * 1024) {
      return res.status(413).json({ error: "音声が大きすぎます（約7MBまで）" });
    }

    const buf = Buffer.from(b64, "base64");
    if (!buf.length) return res.status(400).json({ error: "音声データが不正です" });

    const filename = `entaku-meeting.${extFromMime(mime)}`;
    const form = new FormData();
    const bytes = new Uint8Array(buf);
    const fileBlob =
      typeof File !== "undefined"
        ? new File([bytes], filename, { type: mime })
        : new Blob([bytes], { type: mime });
    form.append("file", fileBlob, filename);
    form.append("model", WHISPER_MODEL);
    form.append("language", "ja");
    form.append("response_format", "json");

    const ac1 = new AbortController();
    const t1 = setTimeout(() => ac1.abort(), OPENAI_TIMEOUT_MS);
    let whRes;
    try {
      whRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: ac1.signal,
      });
    } finally {
      clearTimeout(t1);
    }

    if (!whRes.ok) {
      const t = await whRes.text();
      return res.status(502).json({ error: "Whisper文字起こしに失敗しました", detail: t.slice(0, 500) });
    }
    const whData = await whRes.json();
    const transcript = String(whData.text || "").trim();
    if (!transcript) {
      return res.status(200).json({
        ok: true,
        transcript: "",
        summary: "",
        decisions: [],
        actions: [],
        replies: [{ agent: "secretary", text: "音声から内容を読み取れませんでした。もう一度録音してください。" }],
      });
    }

    const userPrompt = [
      "次の会議音声の文字起こしから議事録を作成してください。",
      context ? `【状況メモ】\n${context}` : "",
      "【文字起こし】",
      transcript.slice(0, 12000),
    ]
      .filter(Boolean)
      .join("\n\n");

    const ac2 = new AbortController();
    const t2 = setTimeout(() => ac2.abort(), OPENAI_TIMEOUT_MS);
    let aiRes;
    try {
      aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: CHAT_MODEL,
          max_tokens: 1800,
          temperature: 0.3,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: MINUTES_SYSTEM },
            { role: "user", content: userPrompt },
          ],
        }),
        signal: ac2.signal,
      });
    } finally {
      clearTimeout(t2);
    }

    if (!aiRes.ok) {
      const t = await aiRes.text();
      return res.status(502).json({
        error: "議事録生成に失敗しました",
        detail: t.slice(0, 500),
        transcript,
      });
    }

    const data = await aiRes.json();
    const raw = String(data.choices?.[0]?.message?.content || "").trim();
    const parsed = parseMinutesJson(raw);

    return res.status(200).json({
      ok: true,
      transcript,
      summary: parsed.summary,
      decisions: parsed.decisions,
      actions: parsed.actions,
      replies: parsed.replies,
      model: CHAT_MODEL,
      at: new Date().toISOString(),
    });
  } catch (e) {
    const aborted = e && e.name === "AbortError";
    return res.status(aborted ? 504 : 500).json({
      error: aborted ? "音声処理がタイムアウトしました" : "サーバーエラー",
      detail: String((e && e.message) || e).slice(0, 300),
    });
  }
}
