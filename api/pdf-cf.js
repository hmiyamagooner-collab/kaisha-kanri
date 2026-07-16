// Vercel Serverless Function: /api/pdf-cf
// CF表・請求書などのPDFテキスト（＋必要ならページ画像）→ 入出金予定JSON

import { getOpenAIKey } from "./getOpenAIKey.js";

export const config = { maxDuration: 60 };

const OPENAI_TIMEOUT_MS = 50000;
const MODEL = process.env.OPENAI_MODEL || "gpt-4o";

function clampYm(year, month) {
  const now = new Date();
  const y = Number(year) || now.getFullYear();
  const m = Number(month) || now.getMonth() + 1;
  const mm = Math.min(12, Math.max(1, m));
  return { year: y, month: mm, ym: `${y}-${String(mm).padStart(2, "0")}` };
}

/** ファイル名・本文・AI応答から対象年月を推定 */
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
      // 対象月に寄せる（PDFが月次CFのとき）
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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = await getOpenAIKey();
  if (!apiKey) {
    return res.status(500).json({
      error: "OPENAI_API_KEY is not configured",
      hint: "Vercelの OPENAI_API_KEY、または api/secrets.local.js を設定してください。",
    });
  }

  try {
    const body = req.body || {};
    const text = String(body.text || "").trim();
    const images = Array.isArray(body.images)
      ? body.images.filter((u) => typeof u === "string" && u.startsWith("data:image/")).slice(0, 4)
      : [];
    const fileName = String(body.fileName || "document.pdf").slice(0, 120);
    const fb = clampYm(body.year, body.month);
    const guessed = detectYm(fileName, text, "", fb.year, fb.month);
    const hintYm = guessed.ym;
    const hintLastDay = new Date(guessed.year, guessed.month, 0).getDate();

    if (!text && !images.length) {
      return res.status(400).json({ error: "PDFテキストまたはページ画像が必要です" });
    }

    const systemText = [
      "あなたは日本企業のキャッシュフロー(CF)担当アシスタントです。",
      "提示されたPDFの内容（月次CF表・入出金予定・請求書・支払一覧など）から、入出金予定を抽出しJSONだけを返します。",
      "正式な会計処理ではなく、社内の資金繰り可視化が目的です。",
      "",
      "【抽出ルール】",
      `- 対象年月のヒントは ${hintYm}。PDF見出し（例: 06月CF）やファイル名が正しければそちらを ym に採用する。`,
      `- 日はその月の1〜末日（ヒント月なら1〜${hintLastDay}）。`,
      "- kind: 入金は in、出金・引落・振込支払は out。",
      "- 月次CF表で「1〜31日」列に金額がある行は、その日を date にする（複数日に金額があれば複数エントリ）。",
      "- 「引落日」「支払期日」「支払日」「〇日」「月末」があれば date に反映（月末は最終日）。",
      "- 「その他」列のみ金額があり日別が空なら、引落日があればその日、なければ月末。",
      "- 「合計」「収入合計」「収出合計」「差引合計」の集計行は必ず除外。",
      "- 項目列が空の行は直前の項目名を継承（例: 車両費配下の車種）。",
      "- セクション見出し（収入/固定費/変動費/税金/保留）は category に使う。",
      "- 金額は円の正の整数。¥やカンマは除去。",
      "- 同じ行を二重計上しない（日別があるのに合計列も入れない）。",
      "- 請求書なら支払期日・金額・相手・内容を1件以上。",
      "",
      "【出力JSONのみ。前後に説明やコードフェンス禁止】",
      "{",
      '  "title": "文書の短いタイトル",',
      '  "ym": "YYYY-MM（PDFの月次。必須）",',
      '  "entries": [',
      '    {',
      '      "date": "YYYY-MM-DD",',
      '      "kind": "in|out",',
      '      "amount": 12345,',
      '      "category": "収入|固定費|変動費|税金|保留|その他 など",',
      '      "item": "項目名",',
      '      "content": "内容・相手名",',
      '      "dept": "部署",',
      '      "method": "支払方法",',
      '      "due": "引落日・支払期日の原文",',
      '      "memo": "短いメモ"',
      "    }",
      "  ],",
      '  "notes": "読み取り上の注意（任意・短く）"',
      "}",
    ].join("\n");

    const userParts = [];
    let userText = `ファイル名: ${fileName}\n対象月ヒント: ${hintYm}\n`;
    if (text) {
      userText += `\n【抽出テキスト】\n"""\n${text.slice(0, 28000)}\n"""\n`;
    } else {
      userText += "\n（テキスト抽出が弱いため、ページ画像から表・金額・支払期日を読み取ってください）\n";
    }
    userParts.push({ type: "text", text: userText });
    images.forEach((url) => {
      userParts.push({ type: "image_url", image_url: { url, detail: "high" } });
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
          max_tokens: 8000,
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
      throw new Error(aiJson.error?.message || `OpenAI error ${aiRes.status}`);
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
    });
  } catch (e) {
    const msg = String((e && e.message) || e);
    const aborted = /abort/i.test(msg);
    return res.status(aborted ? 504 : 500).json({
      error: aborted ? "PDF解析がタイムアウトしました" : "PDF解析に失敗しました",
      detail: msg.slice(0, 400),
    });
  }
}
