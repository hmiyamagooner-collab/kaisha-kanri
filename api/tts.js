// Vercel Serverless Function: /api/tts
// OpenAI Text-to-Speech（円卓AIの声）
import { getOpenAIKey } from "./_lib/getOpenAIKey.js";

export const config = { maxDuration: 30 };

const MODEL = process.env.OPENAI_TTS_MODEL || "tts-1";
const VOICES = new Set(["alloy", "echo", "fable", "onyx", "nova", "shimmer"]);

function applyCors(req, res) {
  const origin = String(req.headers.origin || "");
  const allowed =
    !origin ||
    /vercel\.app$/i.test(origin) ||
    origin === "https://hmiyamagooner-collab.github.io" ||
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
  if (allowed) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function pickVoice(raw) {
  const v = String(raw || "").toLowerCase();
  if (VOICES.has(v)) return v;
  if (v === "secretary" || v === "rin" || v === "凛") return "nova";
  if (v === "finance" || v === "tsumugi" || v === "紬") return "shimmer";
  if (v === "legal" || v === "hinata" || v === "陽翔") return "onyx";
  return "nova";
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = await getOpenAIKey();
  if (!apiKey) {
    return res.status(500).json({
      error: "OPENAI_API_KEY is not configured",
      hint: "Vercelの環境変数 OPENAI_API_KEY を設定してください。",
    });
  }

  try {
    const body = req.body || {};
    let text = String(body.text || body.input || "").replace(/\s+/g, " ").trim();
    if (!text) return res.status(400).json({ error: "text が空です" });
    // OpenAI TTS 上限 4096。余裕を見て切る
    if (text.length > 3500) text = text.slice(0, 3500);

    const voice = pickVoice(body.voice || body.agent);
    const speed = Math.min(1.25, Math.max(0.85, Number(body.speed) || 1.05));

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 28000);
    let aiRes;
    try {
      aiRes = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: MODEL,
          voice,
          input: text,
          response_format: "mp3",
          speed,
        }),
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!aiRes.ok) {
      const t = await aiRes.text();
      return res.status(502).json({
        error: "TTS呼び出しに失敗しました",
        detail: t.slice(0, 400),
      });
    }

    const buf = Buffer.from(await aiRes.arrayBuffer());
    const b64 = buf.toString("base64");
    return res.status(200).json({
      ok: true,
      mime: "audio/mpeg",
      audioBase64: b64,
      voice,
      model: MODEL,
      chars: text.length,
      at: new Date().toISOString(),
    });
  } catch (e) {
    const aborted = e && e.name === "AbortError";
    return res.status(aborted ? 504 : 500).json({
      error: aborted ? "TTSがタイムアウトしました" : "サーバーエラー",
      detail: String((e && e.message) || e).slice(0, 300),
    });
  }
}
