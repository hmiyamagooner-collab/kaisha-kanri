// Vercel Serverless Function: /api/pdf-cf
// CF表PDFのテキスト（必要時のみ小さなページ画像）→ 入出金予定JSON

import { getOpenAIKey } from "./getOpenAIKey.js";

export const config = { maxDuration: 60 };

const OPENAI_TIMEOUT_MS = 55000;
// 表抽出は mini の方が速く、タイムアウトしにくい
const MODEL = process.env.OPENAI_PDF_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini";

function clampYm(year, month) {
  const now = new Date();
  const y = Number(year) || now.getFullYear();
  const m = Number(month) || now.getMonth() + 1;
  const mm = Math.min(12, Math.max(1, m));
  return { year: y, month: mm, ym: `${y}-${String(mm).padStart(2, "0")}` };
}

function detectYm(fileName, text, aiYm, fallbackYear, fallbackMonth) {
  const blob = `${fileName || ""}\n${String(text || "").slice(0, 2000)}\n${aiYm || ""}`;
  const full = blob.match(/(20\d{2})\s*[年\/\-._]?\s*(\d{1,2})\s*月/);
  if (full) return clampYm(+full[1], +full[2]);
  const mOnly = blob.match(/(?:^|[^\d])(\d{1,2})\s*月\s*(?:CF|分|度)?/i);
  if (mOnly) return clampYm(fallbackYear, +mOnly[1]);
  if (/^\d{4}-\d{2}$/.test(String(aiYm || "").trim())) {
    const [y, m] = String(aiYm).split("-").map(Number);
    return clampYm(y, m);
  }
  return clampYm(fallbackYear, fallbackMonth);
}

function sanitizeEntries(raw, ym, lastDay) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const e of list) {
    if (!e || typeof e !== "object") continue;
    const kind = e.kind === "in" ? "in" : e.kind === "out" ? "out" : null;
    const amount = Math.round(Math.abs(Number(e.amount) || 0));
    if (!kind || amount <= 0) continue;

    let date = String(e.date || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const day = Math.min(lastDay, Math.max(1, Number(e.day) || lastDay));
      date = `${ym}-${String(day).padStart(2, "0")}`;
    } else {
      const d = Number(date.slice(8, 10));
      if (!Number.isFinite(d) || d < 1) continue;
      date = `${ym}-${String(Math.min(d, lastDay)).padStart(2, "0")}`;
    }

    const item = String(e.item || "").trim().slice(0, 80);
    const content = String(e.content || e.memo || "").trim().slice(0, 120);
    const memo = [item, content].filter(Boolean).join(" / ") || String(e.memo || "PDF取込").slice(0, 160);
    out.push({
      date,
      kind,
      amount,
      category: String(e.category || item || "その他").slice(0, 40),
      item,
      content,
      dept: String(e.dept || "").slice(0, 40),
      method: String(e.method || "").slice(0, 40),
      due: String(e.due || "").slice(0, 40),
      memo,
      source: "pdf",
    });
  }
  return out;
}

/** dataURL画像をサイズ制限（大きすぎると Vercel/OpenAI で失敗） */
function shrinkImages(images) {
  const list = Array.isArray(images) ? images : [];
  const out = [];
  let total = 0;
  const MAX_EACH = 450000; // ~450KB
  const MAX_TOTAL = 1200000; // ~1.2MB
  for (const u of list) {
    if (typeof u !== "string" || !u.startsWith("data:image/")) continue;
    if (u.length > MAX_EACH) continue;
    if (total + u.length > MAX_TOTAL) break;
    out.push(u);
    total += u.length;
    if (out.length >= 2) break;
  }
  return out;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = await getOpenAIKey();
  if (!apiKey) {
    return res.status(500).json({
      error: "OPENAI_API_KEY が未設定です",
      hint: "Vercelの Environment Variables に OPENAI_API_KEY を設定してください。",
    });
  }

  try {
    const body = req.body || {};
    let text = String(body.text || "").trim().slice(0, 20000);
    let images = shrinkImages(body.images);
    // テキストが十分なら画像は送らない（タイムアウト・413対策）
    if (text.length >= 400) images = [];

    const fileName = String(body.fileName || "document.pdf").slice(0, 120);
    const fb = clampYm(body.year, body.month);
    const guessed = detectYm(fileName, text, "", fb.year, fb.month);
    const hintYm = guessed.ym;
    const hintLastDay = new Date(guessed.year, guessed.month, 0).getDate();

    if (!text && !images.length) {
      return res.status(400).json({
        error: "PDFテキストまたはページ画像が必要です",
        hint: "テキスト付きPDF（スプシの「PDFにダウンロード」）を使うか、画像が大きすぎる場合は再試行してください。",
      });
    }

    const systemText = [
      "あなたは日本企業のキャッシュフロー(CF)担当アシスタントです。",
      "提示されたPDFの内容（月次CF表・入出金予定・請求書など）から入出金予定を抽出し、JSONだけを返します。",
      "",
      "【抽出ルール】",
      `- 対象年月ヒント: ${hintYm}。PDF見出しやファイル名が正しければ ym に採用。`,
      `- 日はその月の1〜${hintLastDay}日。`,
      "- kind: 入金=in / 出金・引落・振込=out",
      "- 日別列（1〜31）に金額があればその日で複数エントリ可",
      "- 引落日・支払期日・月末を date に反映",
      "- 「その他」のみ金額なら引落日、なければ月末",
      "- 合計/収入合計/収出合計/差引合計は除外",
      "- 項目空欄は直前の項目を継承",
      "- セクション（収入/固定費/変動費/税金/保留）は category",
      "- 金額は円の正の整数。二重計上しない",
      "",
      "出力は次のJSONのみ:",
      '{"title":"...","ym":"YYYY-MM","entries":[{"date":"YYYY-MM-DD","kind":"in|out","amount":123,"category":"...","item":"...","content":"...","dept":"...","method":"...","due":"...","memo":"..."}],"notes":"..."}',
    ].join("\n");

    const userParts = [];
    let userText = `ファイル名: ${fileName}\n対象月ヒント: ${hintYm}\n`;
    if (text) userText += `\n【抽出テキスト】\n"""\n${text}\n"""\n`;
    else userText += "\n（テキストが弱いため画像から表を読んでください）\n";
    userParts.push({ type: "text", text: userText });
    images.forEach((url) => {
      userParts.push({ type: "image_url", image_url: { url, detail: "low" } });
    });

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), OPENAI_TIMEOUT_MS);
    let aiRes;
    try {
      aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 6000,
          temperature: 0.1,
          messages: [
            { role: "system", content: systemText },
            { role: "user", content: userParts },
          ],
          response_format: { type: "json_object" },
        }),
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const aiJson = await aiRes.json().catch(() => ({}));
    if (!aiRes.ok) {
      const detail = aiJson.error?.message || `OpenAI error ${aiRes.status}`;
      throw new Error(detail);
    }
    const content = aiJson.choices?.[0]?.message?.content || "{}";
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error("AI応答のJSON解析に失敗しました");
    }

    const resolved = detectYm(fileName, text, parsed.ym, guessed.year, guessed.month);
    const lastDay = new Date(resolved.year, resolved.month, 0).getDate();
    const entries = sanitizeEntries(parsed.entries, resolved.ym, lastDay);
    const sumIn = entries.filter((e) => e.kind === "in").reduce((a, e) => a + e.amount, 0);
    const sumOut = entries.filter((e) => e.kind === "out").reduce((a, e) => a + e.amount, 0);

    if (!entries.length) {
      return res.status(422).json({
        error: "入出金データが抽出できませんでした",
        hint: "テキスト付きPDFか、表が見えるページのPDFでもう一度お試しください。",
        ym: resolved.ym,
        notes: String(parsed.notes || "").slice(0, 300),
      });
    }

    return res.status(200).json({
      ok: true,
      mode: "pdf",
      fileName,
      title: String(parsed.title || fileName).slice(0, 120),
      ym: resolved.ym,
      year: resolved.year,
      month: resolved.month,
      totals: { in: sumIn, out: sumOut, net: sumIn - sumOut, count: entries.length },
      notes: String(parsed.notes || "").slice(0, 500),
      entries,
      at: new Date().toISOString(),
      meta: { model: MODEL, textLen: text.length, imageCount: images.length },
    });
  } catch (e) {
    const msg = String((e && e.message) || e);
    const aborted = /abort/i.test(msg);
    return res.status(aborted ? 504 : 500).json({
      error: aborted ? "PDF解析がタイムアウトしました（再試行するか、テキスト付きPDFを使ってください）" : "PDF解析に失敗しました",
      detail: msg.slice(0, 400),
    });
  }
}
